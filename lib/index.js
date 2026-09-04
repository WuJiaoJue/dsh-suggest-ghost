/**
 * dsh-suggest-ghost host 端：监听已完成回合，有界生成下一条建议并写入
 * 会话日志，注册 `suggestGhost` 会话投影。零核心改动，纯插件挂载。
 * @module dsh-suggest-ghost
 */
import z from '@deepseek-ai/schemastery';
import { SUGGEST_EVENT } from './domain.js';
import { resolveConfig } from './generate.js';
import { generateSuggestion } from './generate.js';
import { HotnessTable } from './hotness.js';
import { applySuggestGhostProjection, initSuggestGhostProjection, suggestGhostSchema } from './projection.js';
import { effectiveConfig, registerSuggestGhostSettings, SUGGEST_GHOST_NAMESPACE } from './settings.js';
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
    for (const event of session.events) {
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
    // 全局跨会话热度表（增量，随 user/message 事件累积）。
    const hotness = new HotnessTable();
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
                // 插件启动/重载时清理 settings.yaml 里残留的上一次 `_push`：
                // 否则会话重载后 client 可能把旧回合的建议当新建议显示（幽灵复现）。
                pushToClient(null, null);
            }
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
    /**
     * 经 settings `_push` 字段（JSON 字符串）把最新建议+热度推给 client。
     * 幂等优化：payload 与上次完全一致（无新建议且热度未变）时直接跳过——
     * 避免每回合都触发一次 settings 持久化写盘 + client 端 JSON 解析/重渲染。
     *
     * 写盘合并优化：settings.update 是异步落盘；同一时刻连续多次 push（回合
     * 结束推送建议+热度、随后又一轮快速更新）会排成多次顺序写盘。这里把最新
     * 载荷挂起，在途写入完成后只补写**最新一份**（尾写合并），避免背靠背写盘。
     */
    let pushRev = 0;
    // 上次已推送 payload 的内容指纹；空载荷与「从未推送」用同一哨兵表示。
    let lastPushFingerprint = null;
    // 在途写入与待写载荷（合并缓冲）。
    let pushInFlight = null;
    let pendingPushPayload = null;
    const fingerprintOf = (suggestion, hot, error) => {
        const sug = suggestion === null
            ? '∅'
            : `${suggestion.turn}:${suggestion.text}:${suggestion.truncated}:${suggestion.acceptKey}`;
        const hotKey = hot === null || hot.length === 0
            ? '∅'
            : hot.map(h => `${h.text}×${h.count}`).join('|');
        return `${sug}<HOT>${hotKey}<ERR>${error ?? ''}`;
    };
    /**
     * @param error - 本次生成失败的摘要；随 `_push` 送达 client/设置页，
     * 失败不再只进终端日志（否则辅助调用挂了用户完全无感知，也无法诊断）。
     */
    const pushToClient = (suggestion, hot, error) => {
        if (settingsSvc === null)
            return;
        const fingerprint = fingerprintOf(suggestion, hot, error);
        if (lastPushFingerprint === fingerprint)
            return; // 无变化，跳过写盘
        lastPushFingerprint = fingerprint;
        pushRev += 1;
        const payload = {
            rev: pushRev,
            suggestion: suggestion === null ? null : {
                turn: suggestion.turn,
                baseSeq: suggestion.baseSeq,
                text: suggestion.text,
                truncated: suggestion.truncated,
                acceptKey: suggestion.acceptKey,
            },
            hot: hot !== null && hot.length > 0 ? [...hot] : null,
            ...(error !== undefined ? { error } : {}),
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
    const handleTurnEnd = (session, turn) => {
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
            const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
            pushToClient(null, hot);
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
            // 开关仅在 client 端决定是否把这些文本并作候选。数据本就落在本地
            // profile 的会话日志里，top-K 快照（≤ historyMaxEntries 条）不新增暴露面。
            const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
            pushToClient(suggestion ?? null, hot);
        }, (error) => {
            if (state?.pending?.controller === controller)
                state.pending = undefined;
            if (controller.signal.aborted)
                return; // 被新回合取代，失败符合预期
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.warn(`dsh-suggest-ghost: suggestion generation failed: ${message}`);
            // 失败也推送：清掉残留幽灵 + 把错误摘要带给 client/设置页（可诊断）。
            const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
            pushToClient(null, hot, message.slice(0, 300));
        });
    };
    ctx.on('session/event', (session, event) => {
        // 传会话 id：同会话相邻重复的用户消息只计一次热度（对齐 extractHistory 的去重语义）。
        hotness.consume(event, session.id);
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
    ctx.inject(['sessionProjections'], (projectionCtx) => {
        projectionCtx.sessionProjections.register({
            key: PROJECTION_KEY,
            schema: suggestGhostSchema,
            init: initSuggestGhostProjection,
            apply: applySuggestGhostProjection,
            view: (state) => state,
            stateVersion: 2,
        });
    });
}
