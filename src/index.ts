/**
 * dsh-suggest-ghost host 端：监听已完成回合，有界生成下一条建议并写入
 * 会话日志，注册 `suggestGhost` 会话投影。零核心改动，纯插件挂载。
 * @module dsh-suggest-ghost
 */

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import { SUGGEST_EVENT } from './domain.js';
import type { SuggestGhostHotEntry, SuggestGhostSuggested } from './domain.js';
import { resolveConfig } from './generate.js';
import type { Config as GenerateConfig } from './generate.js';
import { generateSuggestion, sessionEvents } from './generate.js';
import { parseHotnessOps, setupHotnessPersistence } from './hotness-store.js';
import { applySuggestGhostProjection, initSuggestGhostProjection, suggestGhostSchema } from './projection.js';
import { effectiveConfig, EMPTY_PUSH, registerSuggestGhostSettings, SUGGEST_GHOST_NAMESPACE } from './settings.js';
import type { SuggestGhostSettings } from './settings.js';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostProjection } from './domain.js';

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

/** 每会话生成状态：防重入、可中止。 */
interface SessionState {
  /** 日志中已生成建议的最新回合号（重载/恢复后避免重复生成）。 */
  lastSuggestedTurn: number;
  /** 在途生成；新回合会中止旧生成。 */
  pending: { readonly turn: number; readonly controller: AbortController } | undefined;
}

/** 从会话日志恢复已建议的最新回合号。 */
function lastSuggestedTurnInLog(session: Session): number {
  let last = 0;
  // 跨代读取：0.1.2 起没有 `session.events`（见 generate.sessionEvents）。
  for (const event of sessionEvents(session)) {
    if (event.type === SUGGEST_EVENT && typeof event.data.turn === 'number') {
      last = Math.max(last, event.data.turn);
    }
  }
  return last;
}

/** `_push` 携带的历史文本条数上限（控制 settings 写盘体积；client 端再按
 * historyMaxEntries 做打分窗口截尾，取两者较小窗口）。 */
const HISTORY_PUSH_CAP = 300;
/** 单条历史文本上限（与 client extractHistory 的 HISTORY_TEXT_MAX_CHARS 一致）。 */
const HISTORY_TEXT_MAX_CHARS = 2000;

/**
 * 从一条会话事件提取可补全的用户输入文本（null = 跳过）。筛选语义与 client
 * `extractHistory` 对齐：只收 `source.kind === 'user'` 的 user/message 文本块，
 * 跳过空白、系统提醒包装块与超长文本。
 */
function userTextOfEvent(event: SessionEvent): string | null {
  if (event.type !== 'user/message') return null;
  const data = event.data as { content?: unknown; source?: { kind?: unknown } };
  const srcKind = data.source?.kind;
  if (typeof srcKind === 'string' && srcKind !== 'user') return null;
  let text = '';
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      const record = block as { type?: unknown; text?: unknown };
      if (record.type === 'text' && typeof record.text === 'string') text += record.text;
    }
  }
  text = text.trim();
  if (text === '' || text.startsWith('<system-reminder>') || text.length > HISTORY_TEXT_MAX_CHARS) return null;
  return text;
}

/**
 * 挂载插件：监听完成回合、按会话生成建议、注册投影单元，并把配置暴露
 * 到 WebUI 设置页（settings 命名空间，live 生效）。
 * @param ctx - 提供 LLM 与会话服务的 cordis 上下文。
 * @param config - 必填的有界生成策略。
 */
export function apply(ctx: Context, config: GenerateConfig): void {
  const resolved = resolveConfig(config);
  const states = new WeakMap<Session, SessionState>();
  const tracked = new Set<SessionState>();
  // 全局跨会话热度表（增量，随 user/message 事件累积），并经 storageDomain
  // 持久化频次（宿主未挂 storageDomain 时自动降级为纯内存）。
  const { hotness, persistence } = setupHotnessPersistence(ctx);

  // 读取生成配置的 live 值：settings 层优先，未覆盖的字段回退到插件配置。
  // 同时持有 settings 服务引用，用于经 `_push` 字段实时把建议/热度推给 client
  // （client 端通过 remote settings/document-updated 订阅收到）。落 settings.yaml，
  // 不写会话日志 → 不再破坏 rc.7 会话重载。
  let liveSettings: SuggestGhostSettings | null = null;
  let settingsSvc: { update: (ns: unknown, patch: object) => Promise<void> } | null = null;
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const svc = (settingsCtx as { settings?: { update: (ns: unknown, patch: object) => Promise<void> } }).settings;
      const scope = registerSuggestGhostSettings(settingsCtx, resolved);
      liveSettings = scope.get();
      if (svc !== undefined) {
        settingsSvc = svc;
        // 插件启动/重载时清理 settings.yaml 里残留的上一次 `_push`：
        // 否则会话重载后 client 可能把旧回合的建议当新建议显示（幽灵复现）。
        pushToClient({
          suggestion: null,
          suggestionSessionId: null,
          hot: null,
          total: hotness.size,
          history: null,
          historySessionId: null,
        });
      }
      // `_ops` 反向通道：client 管理面板的热度操作（删除/固定/新增/清空）与
      // 历史环 pull 请求（client 打开/切换会话时请求该会话的历史文本）。
      // watch 仅在字段值变化时触发；消费后立即清空（防重启重放——陈旧的
      // clear 若在重启后重放会把新数据清掉）；空载荷（'null'）直接跳过。
      // 推回的最新 `_push` 即消费完成的权威状态，client 无需 ACK。
      const unwatchOps = scope.watch((next, prev) => {
        if (next._ops === prev._ops) return;
        const ops = parseHotnessOps(next._ops);
        if (ops.length === 0 || svc === undefined) return;
        // pull：推该会话的历史环。建议字段原样保留（跨会话建议由 client 端
        // sessionId 守卫隐藏，推 null 反而会在切回时丢掉仍在有效期的建议）。
        for (const op of ops) {
          if (op.op !== 'pull') continue;
          const ring = historyRings.get(op.sessionId);
          if (ring === undefined) continue; // 未播种（该会话自插件启动以来无事件）：回空，等其下次事件
          pushToClient({
            suggestion: lastSuggestion,
            suggestionSessionId: lastSuggestionSession,
            hot: hotness.snapshot(liveSettings?.historyMaxEntries ?? 50),
            total: hotness.size,
            history: ring.slice(-HISTORY_PUSH_CAP),
            historySessionId: op.sessionId,
          });
        }
        const changed = persistence.applyOps(ops);
        if (changed > 0) ctx.logger.info(`dsh-suggest-ghost: hotness ops applied (${changed} changed)`);
        void persistence.flush();
        // 消费完成：清空操作队列（下一次 watch 触发时 ops 为空，直接跳过）。
        void svc.update(SUGGEST_GHOST_NAMESPACE, { _ops: EMPTY_PUSH }).catch((error: unknown) => {
          ctx.logger.warn(`dsh-suggest-ghost: clearing _ops failed: ${String(error)}`);
        });
      });
      settingsCtx.effect(() => unwatchOps);
      ctx.logger.info('dsh-suggest-ghost: settings namespace registered (suggest-ghost)');
    } catch (error) {
      ctx.logger.warn(`dsh-suggest-ghost: settings registration failed: ${String(error)}`);
    }
  });
  const effective = (): GenerateConfig => {
    if (liveSettings === null) return resolved;
    return effectiveConfig(resolved, liveSettings);
  };

  // —— 每会话历史环：最近用户消息文本（时间序），供 client 历史前缀补全 ——
  // 0.1.2 起会话快照不再向插件暴露对话 nodes；历史文本改由 host 侧维护并经
  // `_push` 推送。host 本就逐事件扫 user/message 做热度记账，顺带成环零新增
  // 扫描；会话首见时从日志播种一次。筛选语义与 client extractHistory 对齐：
  // 只收 source.kind === 'user' 的文本块，跳过系统注入与超长文本，相邻重复
  // 只计一次。环容量 = HISTORY_PUSH_CAP × 2（推送窗口的两倍，硬上限防泄漏）。
  const historyRings = new Map<string, string[]>();
  const ringPush = (sessionId: string, text: string): void => {
    const ring = historyRings.get(sessionId);
    if (ring === undefined) {
      historyRings.set(sessionId, [text]);
      return;
    }
    if (ring[ring.length - 1] === text) return; // 相邻重复只计一次
    ring.push(text);
    if (ring.length > HISTORY_PUSH_CAP * 2) ring.splice(0, ring.length - HISTORY_PUSH_CAP * 2);
  };

  // 最新建议及其会话（pull 推送时原样保留建议字段，跨会话由 client 守卫隐藏）。
  let lastSuggestion: SuggestGhostSuggested | null = null;
  let lastSuggestionSession: string | null = null;

  /** 推给 client 的 `_push` 载荷（结构化形态；写盘前序列化）。 */
  interface ClientPush {
    /** 最新 LLM 建议；null = 清空当前建议。 */
    readonly suggestion: SuggestGhostSuggested | null;
    /** 建议所属会话（client 据此只在同会话显示建议）。 */
    readonly suggestionSessionId: string | null;
    /** 跨会话热度快照。 */
    readonly hot: readonly SuggestGhostHotEntry[] | null;
    /** 热表总条目数（管理面板「共 N 条」展示；快照只是 top-K）。 */
    readonly total: number;
    /** 历史环推送：最近用户消息文本（时间序）；null = 不携带（保留 client 现值）。 */
    readonly history: readonly string[] | null;
    /** history 所属会话；null 同步 history 为 null。 */
    readonly historySessionId: string | null;
    /** 本次生成失败的摘要（可诊断；成功/无错误时缺省）。 */
    readonly error?: string;
  }

  const fingerprintOf = (p: ClientPush): string => {
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
  let lastPushFingerprint: string | null = null;
  let pushInFlight: Promise<void> | null = null;
  let pendingPushPayload: string | null = null;
  const pushToClient = (p: ClientPush): void => {
    if (settingsSvc === null) return;
    const fingerprint = fingerprintOf(p);
    if (lastPushFingerprint === fingerprint) return; // 无变化，跳过写盘
    lastPushFingerprint = fingerprint;
    pushRev += 1;
    // 建议追踪：pull 推送按 lastSuggestion 原样保留建议字段（跨会话由 client 隐藏）。
    if (p.suggestion !== null) {
      lastSuggestion = p.suggestion;
      lastSuggestionSession = p.suggestionSessionId;
    } else {
      lastSuggestion = null;
      lastSuggestionSession = null;
    }
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
  const flushPush = (): void => {
    if (settingsSvc === null || pushInFlight !== null) return;
    const payload = pendingPushPayload;
    pendingPushPayload = null;
    if (payload === null) return;
    pushInFlight = settingsSvc.update(SUGGEST_GHOST_NAMESPACE, { _push: payload })
      .catch((error: unknown) => {
        ctx.logger.warn(`dsh-suggest-ghost: push to client failed: ${String(error)}`);
      })
      .finally(() => {
        pushInFlight = null;
        if (pendingPushPayload !== null) flushPush(); // 写入期间又有新载荷 → 续写最新
      });
  };

  const handleTurnEnd = (session: Session, turn: number): void => {
    // 回合边界是热表持久化的天然写点：本回合累计的 user/message 频次合并落盘
    // （fail-soft，未就绪/无脏标记时空转；卸载另有 close 兜底）。
    void persistence.flush();
    let state = states.get(session);
    if (state === undefined) {
      state = { lastSuggestedTurn: lastSuggestedTurnInLog(session), pending: undefined };
      states.set(session, state);
      tracked.add(state);
    }
    if (state.lastSuggestedTurn === turn) return;
    const pending = state.pending;
    if (pending !== undefined) {
      if (pending.turn === turn) return;
      pending.controller.abort();
    }
    // LLM 建议被用户关闭：跳过模型调用（省 token），但热度照常推进并推送，
    // 历史前缀补全不受影响；同时把残留建议清空，避免幽灵残留。
    if (effective().llmEnabled === false) {
      state.pending = undefined;
      state.lastSuggestedTurn = turn;
      const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
      pushToClient({
        suggestion: null,
        suggestionSessionId: null,
        hot,
        total: hotness.size,
        history: (historyRings.get(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
        historySessionId: session.id,
      });
      return;
    }
    const controller = new AbortController();
    state.pending = { turn, controller };
    void Promise.resolve()
      .then(() => generateSuggestion(ctx, effective(), session, turn, controller.signal))
      .then(
        (suggestion) => {
          if (state?.pending?.controller !== controller) return;
          state.pending = undefined;
          state.lastSuggestedTurn = turn;
          // 经 settings 实时推给 client（不写日志）。热度快照始终附带：
          // 其频次参与历史补全打分（新近度为主、频次为辅）；「跨会话搜索」
          // 开关仅在 client 端决定是否把这些文本并作候选。历史环随推：client
          // 端补全的文本源（0.1.2 会话快照已不对插件暴露对话 nodes）。
          const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
          pushToClient({
            suggestion: suggestion ?? null,
            suggestionSessionId: session.id,
            hot,
            total: hotness.size,
            history: (historyRings.get(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
            historySessionId: session.id,
          });
        },
        (error: unknown) => {
          if (state?.pending?.controller === controller) state.pending = undefined;
          if (controller.signal.aborted) return; // 被新回合取代，失败符合预期
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`dsh-suggest-ghost: suggestion generation failed: ${message}`);
          // 失败也推送：清掉残留幽灵 + 把错误摘要带给 client/设置页（可诊断）。
          const hot = hotness.snapshot(liveSettings?.historyMaxEntries ?? 50);
          pushToClient({
            suggestion: null,
            suggestionSessionId: null,
            hot,
            total: hotness.size,
            history: (historyRings.get(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
            historySessionId: session.id,
            error: message.slice(0, 300),
          });
        },
      );
  };

  ctx.on('session/event', (session, event) => {
    // 会话首见：从日志播种历史环（当前事件可能已入日志，ringPush 相邻去重兜底）。
    if (!historyRings.has(session.id)) {
      const seed: string[] = [];
      for (const past of sessionEvents(session)) {
        const text = userTextOfEvent(past);
        if (text !== null) seed.push(text);
      }
      historyRings.set(session.id, seed);
    }
    // 传会话 id：同会话相邻重复的用户消息只计一次热度（对齐 extractHistory 的去重语义）。
    hotness.consume(event, session.id);
    const userText = userTextOfEvent(event);
    if (userText !== null) ringPush(session.id, userText);
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      handleTurnEnd(session, event.data.turn);
    }
  });

  // 插件卸载时中止所有在途生成。
  ctx.effect(() => () => {
    for (const state of tracked) state.pending?.controller.abort();
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
    const registry = (projectionCtx as unknown as {
      sessionProjections?: {
        register: (definition: Record<string, unknown>) => () => void;
        cachedSnapshot?: unknown;
      };
    }).sessionProjections;
    if (registry === undefined) return;
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
          view: (state: SuggestGhostProjection) => state,
        },
      });
    } else {
      registry.register({
        ...fold,
        schema: suggestGhostSchema,
        view: (state: SuggestGhostProjection) => state,
      });
    }
  });
}
