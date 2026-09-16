/**
 * dsh-suggest-ghost host 端：监听已完成回合，有界生成下一条建议并经 settings
 * `_push` 实时推给 client，注册 `suggestGhost` 会话投影。零核心改动，纯插件挂载。
 *
 * 冷启动语义见 ./coldstart.ts：历史环按需从会话日志物化、建议按「回合是否仍是
 * 最后一个已完成回合」语义校验，因此重启后打开页面即可用，无需等新回合。
 * @module dsh-suggest-ghost
 */
import z from '@deepseek-ai/schemastery';
import { appendToRing, HISTORY_PUSH_CAP, nextTrackedSuggestion, parsePersistedPush, seedRingFromLog, suggestionFieldsFor, suggestionIsCurrent, userTextOfEvent, } from './coldstart.js';
import { SUGGEST_EVENT } from './domain.js';
import { resolveConfig } from './generate.js';
import { generateSuggestion, sessionEvents } from './generate.js';
import { parseHotnessOps, setupHotnessPersistence } from './hotness-store.js';
import { applySuggestGhostProjection, initSuggestGhostProjection, suggestGhostSchema } from './projection.js';
import { effectiveConfig, EMPTY_PUSH, registerSuggestGhostSettings, SUGGEST_GHOST_NAMESPACE } from './settings.js';
import { PROJECTION_KEY } from './domain.js';
/** 配置 schema（cordis 插件约定，config catalog 会原样粘贴声明）。全部字段带默认值，开箱即用；可按需覆盖。 */
export const Config = z.object({
    /** 最终框架化用户提示的最大 UTF-8 字节数。 */
    maxInputBytes: z.natural().min(1).default(4096),
    /** 建议生成输出令牌上限（推理模型需留足预算，如 512）。 */
    maxOutputTokens: z.natural().min(1).default(512),
    /** 辅助请求端到端截止时间（毫秒）。 */
    timeoutMs: z.natural().min(1).default(60_000),
    /** 转录尾部保留的最近完成回合数（默认 1：只取最后一轮）。 */
    maxRecentTurns: z.natural().min(1).default(1),
    /** 转录字符预算。 */
    maxTranscriptChars: z.natural().min(1).default(12_000),
    /** 建议可见字符上限。 */
    maxSuggestionChars: z.natural().min(1).default(240),
    /** LLM 下一条建议开关（默认开）；作为 settings base 初值，WebUI 卡片可实时覆盖。 */
    llmEnabled: z.boolean().default(true),
    /** 显式路由对；同时省略则继承主请求最近记录的路由。 */
    provider: z.string().min(1),
    model: z.string().min(1),
    /** 采纳建议的输入框快捷键（默认 Tab）。 */
    acceptKey: z.string().min(1).default('Tab'),
});
/** 所需服务：LLM 路由 + 会话存储。 */
export const inject = ['llm', 'sessions'];
/** 插件名（与 cordis 条目 id 及 manifest 一致）。 */
export const name = 'dsh-suggest-ghost';
/** 从会话日志恢复已建议的最新回合号。 */
function lastSuggestedTurnInLog(session) {
    let last = 0;
    // 跨代读取：0.1.2 起没有 `session.events`（见 generate.sessionEvents）。
    for (const event of sessionEvents(session)) {
        if (event.type === SUGGEST_EVENT && typeof event.data.turn === 'number') {
            last = Math.max(last, event.data.turn);
        }
    }
    return last;
}
/**
 * 挂载插件：监听完成回合、按会话生成建议、注册投影单元，并把配置暴露
 * 到 WebUI 设置页（settings 命名空间，live 生效）。
 * @param ctx - 提供 LLM 与会话服务的 cordis 上下文。
 * @param config - 必填的有界生成策略。
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const states = new WeakMap();
    const tracked = new Set();
    // 全局跨会话热度表（增量，随 user/message 事件累积），并经 storageDomain
    // 持久化频次（宿主未挂 storageDomain 时自动降级为纯内存）。
    const { hotness, persistence } = setupHotnessPersistence(ctx);
    // 读取生成配置的 live 值：settings 层优先，未覆盖的字段回退到插件配置。
    // 同时持有 settings 服务引用，用于经 `_push` 字段实时把建议/热度推给 client
    // （client 端通过 remote settings/document-updated 订阅收到）。落 settings.yaml，
    // 不写会话日志 → 不再破坏 rc.7 会话重载。
    let liveSettings = null;
    let settingsSvc = null;
    ctx.inject(['settings'], (settingsCtx) => {
        try {
            const svc = settingsCtx.settings;
            const scope = registerSuggestGhostSettings(settingsCtx, resolved);
            liveSettings = scope.get();
            if (svc !== undefined) {
                settingsSvc = svc;
                // 重启/重载对账：`_push` 是建议（不可重建的 LLM 输出）唯一的持久载体，
                // 回读盘上残留并按**语义**校验——会话存活且建议回合仍是其最后一个已完成
                // 回合 → 原样恢复（打开页面即见上一轮建议，不必等新回合）；可判定为陈旧
                // → 清场；会话尚未进店（持久化懒恢复未发生）→ 不猜测、不覆盖盘上值，
                // 等该会话首次 pull / 事件到达时经同一组装路径对账。
                const persisted = parsePersistedPush(scope.get()._push);
                const persistedLive = persisted.sessionId === null
                    ? undefined
                    : ctx.sessions.get(persisted.sessionId);
                // persistedLive === undefined 且盘上有建议 = 会话尚未进店（持久化懒恢复
                // 未发生）：此时无从判定新旧，绝不据此清盘，留给该会话首次 pull/事件对账。
                if (persisted.suggestion === null || persistedLive !== undefined) {
                    if (suggestionIsCurrent(persisted.suggestion, persistedLive)) {
                        lastSuggestion = persisted.suggestion;
                        lastSuggestionSession = persisted.sessionId;
                    }
                    pushToClient(statePushOf(persisted.sessionId));
                }
                // `_ops` 遗留补消费：watch 只在字段值变化时触发——client 冷启动的 pull
                // 若抢跑在 host 就绪之前，那次写入已被错过。消费幂等（热度 ops 幂等、
                // 消费后立即清空），先跑一次关掉这个时序窗口。
                consumeOps(parseHotnessOps(scope.get()._ops), svc);
                // 热度恢复是异步的（storageDomain.open）：恢复完成后补推一次快照，修正
                // 恢复窗口内已推送的不完整热度（恢复若早于本次注入，上面的对账推送已含
                // 完整热度，此处经指纹幂等跳过）。
                void persistence.whenReady.then(() => {
                    if (settingsSvc === null)
                        return;
                    pushToClient(statePushOf(lastSuggestionSession));
                });
            }
            // `_ops` 反向通道：client 管理面板的热度操作（删除/固定/新增/清空）与
            // 历史环 pull 请求（client 打开/切换会话时请求该会话的权威状态）。
            // watch 仅在字段值变化时触发；消费后立即清空（防重启重放——陈旧的
            // clear 若在重启后重放会把新数据清掉）；空载荷（'null'）直接跳过。
            // 推回的最新 `_push` 即消费完成的权威状态，client 无需 ACK。
            const unwatchOps = scope.watch((next, prev) => {
                if (next._ops === prev._ops || svc === undefined)
                    return;
                consumeOps(parseHotnessOps(next._ops), svc);
            });
            settingsCtx.effect(() => unwatchOps);
            ctx.logger.info('dsh-suggest-ghost: settings namespace registered (suggest-ghost)');
        }
        catch (error) {
            ctx.logger.warn(`dsh-suggest-ghost: settings registration failed: ${String(error)}`);
        }
    });
    const effective = () => {
        if (liveSettings === null)
            return resolved;
        return effectiveConfig(resolved, liveSettings);
    };
    // —— 每会话历史环：最近用户消息文本（时间序），供 client 历史前缀补全 ——
    // 0.1.2 起会话快照不再向插件暴露对话 nodes；历史文本改由 host 侧维护并经
    // `_push` 推送。host 本就逐事件扫 user/message 做热度记账，顺带成环零新增
    // 扫描。环是会话日志的按需物化缓存：pull 时未命中就从日志现种（日志持久化，
    // apply 时必然已在内存），「播种时机」与竞态窗口一并消失；会话活跃期间由
    // session/event 增量维护。筛选语义与 client extractHistory 对齐：只收
    // source.kind === 'user' 的文本块，跳过系统注入与超长文本，相邻重复只计
    // 一次。环容量 = HISTORY_PUSH_CAP × 2（推送窗口的两倍，硬上限防泄漏）。
    const historyRings = new Map();
    /** 取会话历史环：缓存未命中且会话存活时从日志物化（幂等，每会话至多一次）。 */
    const ringFor = (sessionId) => {
        const cached = historyRings.get(sessionId);
        if (cached !== undefined)
            return cached;
        const session = ctx.sessions.get(sessionId);
        if (session === undefined)
            return undefined; // 会话不存在（已销毁）：无法回答
        const seed = seedRingFromLog(session);
        historyRings.set(sessionId, seed);
        return seed;
    };
    const ringPush = (sessionId, text) => {
        // 先物化（未命中则从日志现种）：环是日志的缓存，绝不能凭空从单条文本起建
        // ——否则该会话的历史前缀会丢掉此前的所有轮次。
        const ring = ringFor(sessionId);
        if (ring === undefined)
            return; // 会话不存在（已销毁）：无环可维护
        appendToRing(ring, text);
    };
    // 最新建议及其会话（pull 推送时原样保留建议字段，跨会话由 client 守卫隐藏）。
    let lastSuggestion = null;
    let lastSuggestionSession = null;
    /**
     * 取某会话当前语义有效的建议（null = 无）。判据从「时间」换成「语义」：
     * 建议对应的回合是否仍是该会话最后一个已完成回合——不是就作废（防止
     * 重启后把旧回合的建议当新建议显示）。这是 `_push` 里建议状态的唯一
     * 权威来源：启动时从盘上回读、pull 时校验后重推，都走这里。
     */
    const currentSuggestionFor = (sessionId) => {
        if (lastSuggestion === null || lastSuggestionSession !== sessionId)
            return null;
        const session = ctx.sessions.get(sessionId);
        return suggestionIsCurrent(lastSuggestion, session) ? lastSuggestion : null;
    };
    /**
     * 更新「最新建议」追踪状态——建议的产出与作废只发生在生成路径，所以追踪也
     * 只在这里更新（载荷推送不改它，见 pushToClient）。
     */
    const trackSuggestion = (sessionId, suggestion) => {
        const next = nextTrackedSuggestion({ suggestion: lastSuggestion, sessionId: lastSuggestionSession }, sessionId, suggestion);
        lastSuggestion = next.suggestion;
        lastSuggestionSession = next.sessionId;
    };
    const fingerprintOf = (p) => {
        const sug = p.suggestion === null
            ? '∅'
            : `${p.suggestion.turn}:${p.suggestion.text}:${p.suggestion.truncated}:${p.suggestion.acceptKey}`;
        const hotKey = p.hot === null || p.hot.length === 0
            ? '∅'
            : p.hot.map(h => `${h.text}×${h.count}${h.pinned === true ? '!p' : ''}`).join('|');
        const historyKey = p.history === null || p.history.length === 0 || p.historySessionId === null
            ? '∅'
            : `${p.historySessionId}#${p.history.length}:${p.history[p.history.length - 1] ?? ''}`;
        return `${sug}<HOT>${hotKey}<T>${p.total}<HIST>${historyKey}<ERR>${p.error ?? ''}`;
    };
    /**
     * 经 settings `_push` 字段（JSON 字符串）把最新建议+热度+历史推给 client。
     * 幂等优化：payload 与上次完全一致时直接跳过——避免重复写盘 + client 端
     * JSON 解析/重渲染。`history: null` 表示本次推送不携带历史（client 保留
     * 现值）——pull/turn-end 想更新历史时才携带。
     *
     * 写盘合并优化：settings.update 是异步落盘；同一时刻连续多次 push 会排成
     * 多次顺序写盘。这里把最新载荷挂起，在途写入完成后只补写**最新一份**。
     */
    let pushRev = 0;
    let lastPushFingerprint = null;
    let pushInFlight = null;
    let pendingPushPayload = null;
    const pushToClient = (p) => {
        if (settingsSvc === null)
            return;
        const fingerprint = fingerprintOf(p);
        if (lastPushFingerprint === fingerprint)
            return; // 无变化，跳过写盘
        lastPushFingerprint = fingerprint;
        pushRev += 1;
        // 注意：这里**不**改 lastSuggestion/lastSuggestionSession。载荷里的
        // `suggestion: null` 有两种含义——「本会话没有建议」（如 pull 一个没有建议
        // 的会话）与「建议被作废」。若在这里按载荷清空追踪状态，pull 一次别的会话
        // 就会把仍在有效期的那条建议弄丢。追踪状态只在真正产出/作废建议的地方更新
        // （handleTurnEnd 的生成结果与启动对账）。
        const payload = {
            rev: pushRev,
            suggestion: p.suggestion === null ? null : {
                turn: p.suggestion.turn,
                baseSeq: p.suggestion.baseSeq,
                text: p.suggestion.text,
                truncated: p.suggestion.truncated,
                acceptKey: p.suggestion.acceptKey,
            },
            suggestionSessionId: p.suggestionSessionId,
            hot: p.hot !== null && p.hot.length > 0 ? [...p.hot] : null,
            total: p.total,
            ...(p.history !== null && p.historySessionId !== null
                ? { history: [...p.history], historySessionId: p.historySessionId }
                : {}),
            ...(p.error !== undefined ? { error: p.error } : {}),
        };
        // 合并缓冲：若已有在途写入，只更新「最新待写」；flush 在途完成后补写。
        pendingPushPayload = JSON.stringify(payload);
        flushPush();
    };
    /** 尾写合并：把挂起的最新载荷写盘；写入期间再来新载荷则在完成后续写。 */
    const flushPush = () => {
        if (settingsSvc === null || pushInFlight !== null)
            return;
        const payload = pendingPushPayload;
        pendingPushPayload = null;
        if (payload === null)
            return;
        pushInFlight = settingsSvc.update(SUGGEST_GHOST_NAMESPACE, { _push: payload })
            .catch((error) => {
            ctx.logger.warn(`dsh-suggest-ghost: push to client failed: ${String(error)}`);
        })
            .finally(() => {
            pushInFlight = null;
            if (pendingPushPayload !== null)
                flushPush(); // 写入期间又有新载荷 → 续写最新
        });
    };
    /**
     * 组装某会话的**当前权威状态**并推给 client：历史环按需从日志物化（ringFor，
     * 无播种时机概念）、建议经语义校验（currentSuggestionFor）、热度取热表现照。
     * 启动对账、pull 应答、热度恢复补推三条路径共用这一份组装逻辑——它们此前
     * 各写各的，是冷启动竞态的根源。
     *
     * 建议字段的跨会话语义：本会话的建议按校验结果推（有效原样 / 陈旧清掉）；
     * 其他会话的有效建议原样保留——client 端按 sessionId 守卫隐藏，切回时仍在
     * 有效期，推 null 反而会把切回后的建议弄丢。
     * @param sessionId - 目标会话；null 表示无特定会话（仅刷新热度，历史不携带）。
     */
    const statePushOf = (sessionId) => {
        const ring = sessionId === null ? undefined : ringFor(sessionId);
        // 建议字段：本会话按语义校验取用；不属于本会话但仍被追踪的那条原样带上
        // （client 按 suggestionSessionId 守卫隐藏，切回时立即可用）。
        const fields = suggestionFieldsFor({ suggestion: lastSuggestion, sessionId: lastSuggestionSession }, sessionId, sessionId === null ? null : currentSuggestionFor(sessionId));
        return {
            suggestion: fields.suggestion,
            suggestionSessionId: fields.sessionId,
            hot: hotness.snapshot(liveSettings?.historyMaxEntries ?? 50),
            total: hotness.size,
            history: ring === undefined ? null : ring.slice(-HISTORY_PUSH_CAP),
            historySessionId: ring === undefined ? null : sessionId,
        };
    };
    /**
     * `_ops` 消费器（watch 触发与启动遗留补消费共用）：pull 走统一的状态组装应答，
     * 其余操作交热表层应用（幂等），最后 flush 并清空队列。
     * @param ops - 已解析的操作批；空数组直接返回（不写盘）。
     * @param svc - settings 写面，用于消费后清空 `_ops`。
     */
    const consumeOps = (ops, svc) => {
        if (ops.length === 0)
            return;
        for (const op of ops) {
            if (op.op !== 'pull')
                continue;
            // 无论历史环可不可得都应答：环缺失（会话尚未进店/已销毁）时 statePushOf
            // 会省略 history（client 保留现值），但热度与对账后的建议照常送达——
            // 静默丢弃会让 client 永远等不到这一轮对账。
            pushToClient(statePushOf(op.sessionId));
        }
        const changed = persistence.applyOps(ops);
        if (changed > 0)
            ctx.logger.info(`dsh-suggest-ghost: hotness ops applied (${changed} changed)`);
        void persistence.flush();
        // 消费完成：清空操作队列（下一次 watch 触发时 ops 为空，直接跳过）。
        void svc.update(SUGGEST_GHOST_NAMESPACE, { _ops: EMPTY_PUSH }).catch((error) => {
            ctx.logger.warn(`dsh-suggest-ghost: clearing _ops failed: ${String(error)}`);
        });
    };
    const handleTurnEnd = (session, turn) => {
        // 回合边界是热表持久化的天然写点：本回合累计的 user/message 频次合并落盘
        // （fail-soft，未就绪/无脏标记时空转；卸载另有 close 兜底）。
        void persistence.flush();
        let state = states.get(session);
        if (state === undefined) {
            state = { lastSuggestedTurn: lastSuggestedTurnInLog(session), pending: undefined };
            states.set(session, state);
            tracked.add(state);
        }
        if (state.lastSuggestedTurn === turn)
            return;
        const pending = state.pending;
        if (pending !== undefined) {
            if (pending.turn === turn)
                return;
            pending.controller.abort();
        }
        // LLM 建议被用户关闭：跳过模型调用（省 token），但热度照常推进并推送，
        // 历史前缀补全不受影响；同时把残留建议清空，避免幽灵残留。
        if (effective().llmEnabled === false) {
            state.pending = undefined;
            state.lastSuggestedTurn = turn;
            trackSuggestion(session.id, null); // 关闭 LLM：本会话建议作废（其他会话不受影响）
            const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
            pushToClient({
                suggestion: null,
                suggestionSessionId: null,
                hot,
                total: hotness.size,
                history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
                historySessionId: session.id,
            });
            return;
        }
        const controller = new AbortController();
        state.pending = { turn, controller };
        void Promise.resolve()
            .then(() => generateSuggestion(ctx, effective(), session, turn, controller.signal))
            .then((suggestion) => {
            if (state?.pending?.controller !== controller)
                return;
            state.pending = undefined;
            state.lastSuggestedTurn = turn;
            // 经 settings 实时推给 client（不写日志）。热度快照始终附带：
            // 其频次参与历史补全打分（新近度为主、频次为辅）；「跨会话搜索」
            // 开关仅在 client 端决定是否把这些文本并作候选。历史环随推：client
            // 端补全的文本源（0.1.2 会话快照已不对插件暴露对话 nodes）。
            const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
            trackSuggestion(session.id, suggestion ?? null);
            pushToClient({
                suggestion: suggestion ?? null,
                suggestionSessionId: session.id,
                hot,
                total: hotness.size,
                history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
                historySessionId: session.id,
            });
        }, (error) => {
            if (state?.pending?.controller === controller)
                state.pending = undefined;
            if (controller.signal.aborted)
                return; // 被新回合取代，失败符合预期
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.warn(`dsh-suggest-ghost: suggestion generation failed: ${message}`);
            // 失败也推送：清掉残留幽灵 + 把错误摘要带给 client/设置页（可诊断）。
            trackSuggestion(session.id, null);
            const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
            pushToClient({
                suggestion: null,
                suggestionSessionId: null,
                hot,
                total: hotness.size,
                history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
                historySessionId: session.id,
                error: message.slice(0, 300),
            });
        });
    };
    ctx.on('session/event', (session, event) => {
        // 传会话 id：同会话相邻重复的用户消息只计一次热度（对齐 extractHistory 的去重语义）。
        hotness.consume(event, session.id);
        const userText = userTextOfEvent(event);
        // ringPush 会先按需物化（含本事件之前的日志），无需任何「首见播种」步骤。
        if (userText !== null)
            ringPush(session.id, userText);
        if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
            handleTurnEnd(session, event.data.turn);
        }
    });
    // 插件卸载时中止所有在途生成。
    ctx.effect(() => () => {
        for (const state of tracked)
            state.pending?.controller.abort();
    });
    // `suggestGhost` 投影单元：last-wins fold。仅当投影注册表已组合时激活
    // （headless 组装不受影响）。
    //
    // 跨代注册：0.1.2 改了单元形状——`schema` → `stateSchema`，顶层 `view` 挪进
    // `wire.view`（payload schema 随之改名 `wire.viewSchema`），`init` 额外接收
    // (header, inheritedEventCount)（本插件的无参 init 天然兼容）。两代形状在
    // 对方的类型里都不可见，按 0.1.2 独有的 `cachedSnapshot` 方法探测代际后
    // 分别构造；类型层以宽松结构视图对接，运行时行为两代各自验证。
    ctx.inject(['sessionProjections'], (projectionCtx) => {
        const registry = projectionCtx.sessionProjections;
        if (registry === undefined)
            return;
        const is02 = typeof registry.cachedSnapshot === 'function';
        const fold = {
            key: PROJECTION_KEY,
            init: initSuggestGhostProjection,
            apply: applySuggestGhostProjection,
            stateVersion: 2,
        };
        if (is02) {
            registry.register({
                ...fold,
                stateSchema: suggestGhostSchema,
                wire: {
                    viewSchema: suggestGhostSchema,
                    view: (state) => state,
                },
            });
        }
        else {
            registry.register({
                ...fold,
                schema: suggestGhostSchema,
                view: (state) => state,
            });
        }
    });
}
