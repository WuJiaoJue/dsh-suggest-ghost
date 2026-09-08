/**
 * 有界辅助建议生成：转录提取、脱敏、路由解析、截止时间熔断的 LLM 调用、输出净化。
 * 与 session-title-llm 调用策略一致（字节上限、输出上限、截止时间、派发前记录）。
 * @module dsh-suggest-ghost/generate
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostSuggested } from './domain.js';
import type { Transcript } from './transcript.js';
/**
 * 读取会话完整事件日志（跨代兼容）。
 * DSH 0.1.2 起 `Session.events` getter 被移除：公开面改为 `snapshotEvents()`
 * （无参调用返回全量冻结数组，语义与旧 `events` 一致）；≤0.1.1 内核只有
 * `events` getter、没有 `snapshotEvents`。两边的属性在对方那一代都不存在，
 * 类型上互不可见，这里按运行时能力探测读取。两者都缺失（不该出现的代际
 * 组合）时回退空数组——回合结束路径绝不能再因日志读取崩掉。
 */
export declare function sessionEvents(session: Session): readonly SessionEvent[];
/** 本能力所属的辅助请求超时错误码。 */
export declare const SUGGEST_TIMEOUT_CODE = "SUGGEST_GHOST_TIMEOUT";
/** host 插件配置（未校验版本）。 */
export interface Config {
    maxInputBytes: number;
    maxOutputTokens: number;
    timeoutMs: number;
    maxRecentTurns?: number;
    maxTranscriptChars: number;
    maxSuggestionChars: number;
    provider?: string;
    model?: string;
    acceptKey?: string;
    /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
    llmEnabled?: boolean;
}
/** 校验并返回不可变配置。 */
export declare function resolveConfig(config: Config): Config;
/** 建议生成指令：只预测用户下一条提示词，禁止生成内容或元文本。 */
export declare function systemPrompt(maxSuggestionChars: number, language: string): string;
/**
 * 从会话日志构建模型可见转录：最近 `maxRecentTurns` 个已完成回合的
 * user/assistant 消息（默认 1 = 只取最后一轮），脱敏，依次按字符预算
 * （`maxTranscriptChars`）与 UTF-8 字节预算（`maxInputBytes`）截尾。
 */
export declare function buildTranscript(session: Session, maxRecentTurns: number, maxTranscriptChars: number, maxInputBytes: number): Transcript | undefined;
/**
 * 为一个已完成回合生成建议。模型产出空或不合格回复 = 无建议（静默返回
 * undefined），真实失败抛错。
 *
 * 辅助调用带**有界重试**（默认共 3 次尝试，1.2s/2.4s 退避）：主循环对
 * EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 类瞬时错误有 5 次重试，
 * 而建议调用是单发——不稳定窗口里会整轮静默失败（实测发生过）。被外部
 * 中止（新回合取代/卸载）时不重试。
 */
export declare function generateSuggestion(ctx: Context, config: Config, session: Session, turn: number, signal: AbortSignal): Promise<SuggestGhostSuggested | undefined>;
export { PROJECTION_KEY };
