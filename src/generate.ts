/**
 * 有界辅助建议生成：转录提取、脱敏、路由解析、截止时间熔断的 LLM 调用、输出净化。
 * 与 session-title-llm 调用策略一致（字节上限、输出上限、截止时间、派发前记录）。
 * @module dsh-suggest-ghost/generate
 */

import type { Context } from '@deepseek-ai/cordis';
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
} from '@deepseek-ai/dsh-llm';
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface';
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostSuggested } from './domain.js';
import {
  cleanSuggestion,
  hasCJK,
  redactSecrets,
  sanitizeSuggestion,
  shouldFilterSuggestion,
} from './sanitize.js';

/** 本能力所属的辅助请求超时错误码。 */
export const SUGGEST_TIMEOUT_CODE = 'SUGGEST_GHOST_TIMEOUT';

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
export function resolveConfig(config: Config): Config {
  if (config === null || typeof config !== 'object') {
    throw new Error('dsh-suggest-ghost: configuration is required');
  }
  const value = config as unknown as Record<string, unknown>;
  const int = (name: string): number => {
    const n = value[name];
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw new Error(`dsh-suggest-ghost: ${name} must be a positive integer`);
    }
    return n;
  };
  int('maxInputBytes');
  int('maxOutputTokens');
  int('timeoutMs');
  if (value.maxRecentTurns !== undefined) int('maxRecentTurns');
  int('maxTranscriptChars');
  int('maxSuggestionChars');
  if (typeof value.timeoutMs === 'number' && value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-suggest-ghost: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  }
  const hasProvider = value.provider !== undefined;
  const hasModel = value.model !== undefined;
  if (hasProvider !== hasModel) {
    throw new Error('dsh-suggest-ghost: provider and model must be supplied together');
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('dsh-suggest-ghost: provider and model overrides must be non-empty strings');
  }
  if (value.acceptKey !== undefined
    && (typeof value.acceptKey !== 'string' || value.acceptKey.trim().length === 0)) {
    throw new Error('dsh-suggest-ghost: acceptKey must be a non-empty shortcut string');
  }
  if (value.llmEnabled !== undefined && typeof value.llmEnabled !== 'boolean') {
    throw new Error('dsh-suggest-ghost: llmEnabled must be a boolean');
  }
  return deepFreeze(Object.assign({}, value)) as unknown as Config;
}

/** 建议生成指令：只预测用户下一条提示词，禁止生成内容或元文本。 */
export function systemPrompt(maxSuggestionChars: number, language: string): string {
  return [
    'You are a prompt suggestion generator. Your ONLY purpose is to predict the user\'s next prompt in a coding-assistant chat — never to generate content.',
    '',
    'Your job:',
    '1. Read the user\'s most recent message and the assistant\'s final answer.',
    '2. Predict what the USER would naturally type next — not what the assistant should do.',
    '',
    'CRITICAL CONSTRAINTS:',
    '- You are NOT a code generator, writer, or task executor.',
    '- You MUST respond with ONLY the suggestion text, on a single line.',
    '- NEVER generate, implement, code, or produce any content.',
    '- NEVER provide explanations, reasoning, or extra text.',
    '- NEVER use quotes, labels, Markdown, XML, or formatting.',
    '- Be specific when you can — name files, functions, or actions.',
    '- If the next step is not obvious, reply with nothing at all.',
    '',
    'THE TEST: would the user think "I was just about to type that"?',
    '',
    'EXAMPLES:',
    'User asked "fix the bug and run tests", bug is fixed -> "run the tests"',
    'After code written -> "try it out"',
    'Assistant offers options -> pick the one the user would choose',
    'Assistant asks to continue -> "yes" or "go ahead"',
    'Task complete, obvious follow-up -> "commit this" or "push it"',
    'After an error or misunderstanding -> reply with nothing',
    '',
    'NEVER SUGGEST:',
    '- Evaluative feedback ("looks good", "thanks")',
    '- Questions ("what about...?")',
    '- Assistant-voice phrasing ("Let me...", "I\'ll...", "Here\'s...")',
    '- New ideas the user did not ask about',
    '- Multiple sentences',
    '',
    'Reply with ONLY the suggestion, 3-12 words, no quotes or explanation. If the next step is not obvious, reply with nothing.',
    '',
    `Language: ${language}`,
    `At most ${maxSuggestionChars} visible characters.`,
  ].join('\n');
}

/** 一条脱敏后的对话交换。 */
export interface TranscriptPair {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** 有界转录及其日志归因。 */
export interface Transcript {
  readonly pairs: readonly TranscriptPair[];
  readonly sourceMessageSeqs: readonly number[];
  readonly baseSeq: number;
}

/** 提取消息文本块。 */
function renderMessageText(message: Message): string {
  let out = '';
  for (const block of message.content) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

/** 预算内保留最新若干对；至少保留最新一对。 */
function keepTail(pairs: readonly TranscriptPair[], budget: number): number {
  let remaining = budget;
  let kept = 0;
  for (const pair of [...pairs].reverse()) {
    const cost = pair.role.length + pair.text.length + 2;
    if (cost > remaining && kept > 0) break;
    kept += 1;
    remaining -= cost;
  }
  return Math.max(1, kept);
}

/** 建议回复语言跟随会话（最后一条用户消息含 CJK → 简体中文）。 */
export function suggestionLanguage(pairs: readonly TranscriptPair[]): string {
  for (const pair of [...pairs].reverse()) {
    if (pair.role !== 'user') continue;
    return hasCJK(pair.text) ? '简体中文' : 'English';
  }
  return 'English';
}

/** 组装带标签块供模型阅读。 */
function frameTranscript(pairs: readonly TranscriptPair[]): string {
  const blocks: string[] = [];
  for (const pair of pairs) {
    blocks.push(pair.role === 'user' ? `[User Message]\n${pair.text}` : `[Assistant Response]\n${pair.text}`);
  }
  return blocks.join('\n\n');
}

/**
 * 从会话日志构建模型可见转录：最近 `maxRecentTurns` 个已完成回合的
 * user/assistant 消息（默认 1 = 只取最后一轮），脱敏、按预算截尾。
 */
export function buildTranscript(
  session: Session,
  maxRecentTurns: number,
  maxTranscriptChars: number,
): Transcript | undefined {
  const events = session.events;
  let lastTurn = 0;
  const turnStarts: Array<{ readonly turn: number; readonly seq: number }> = [];
  for (const event of events) {
    if (event.type === 'turn/start') turnStarts.push({ turn: event.data.turn, seq: event.seq });
    else if (event.type === 'turn/end') lastTurn = event.data.turn;
  }
  if (lastTurn === 0) return undefined;
  const cutoffTurn = Math.max(1, lastTurn - Math.max(1, maxRecentTurns) + 1);
  const cutoffSeq = turnStarts.find(entry => entry.turn === cutoffTurn)?.seq ?? 0;
  const pairs: TranscriptPair[] = [];
  const sourceMessageSeqs: number[] = [];
  let baseSeq = 0;
  for (const event of events) {
    if (event.seq < cutoffSeq) continue;
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    const message = deriveEventMessage(event);
    if (message === null) continue;
    const text = renderMessageText(message).trim();
    if (text.length === 0) continue;
    pairs.push({ role: message.role === 'user' ? 'user' : 'assistant', text: redactSecrets(text) });
    sourceMessageSeqs.push(event.seq);
    baseSeq = event.seq;
  }
  if (pairs.length === 0) return undefined;
  const keptCount = keepTail(pairs, Math.max(1, maxTranscriptChars));
  return {
    pairs: pairs.slice(pairs.length - keptCount),
    sourceMessageSeqs: sourceMessageSeqs.slice(sourceMessageSeqs.length - keptCount),
    baseSeq,
  };
}

/** 解析路由：显式配置优先，否则继承会话最近一次请求的路由。 */
function routeOf(
  session: Session,
  config: Config,
): { readonly provider: string; readonly model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model };
  }
  const route = session.requestHeader()?.config;
  if (route !== undefined && route.provider.length > 0 && route.model.length > 0) {
    return { provider: route.provider, model: route.model };
  }
  throw new Error('dsh-suggest-ghost: no logged request route is available; configure provider and model together');
}

/** 终止原因 → 失败信息。 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined;
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string };
      error.code = finish.failure.code;
      return error;
    }
    case 'max-tokens':
      return new Error('dsh-suggest-ghost: suggestion output reached maxOutputTokens');
    case 'tool-calls':
      return new Error('dsh-suggest-ghost: suggestion model unexpectedly requested a tool');
    /* v8 ignore next 2 -- FinishReason 是封闭五元联合，默认分支不可达 */
    default:
      return new Error(`dsh-suggest-ghost: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`);
  }
}

/** 可中止的退避等待；到点或被中止即返回（由调用方 throwIfAborted 兜底）。 */
async function backoff(signal: AbortSignal, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  signal.throwIfAborted();
}

/**
 * 为一个已完成回合生成建议。模型产出空或不合格回复 = 无建议（静默返回
 * undefined），真实失败抛错。
 *
 * 辅助调用带**有界重试**（默认共 3 次尝试，1.2s/2.4s 退避）：主循环对
 * EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 类瞬时错误有 5 次重试，
 * 而建议调用是单发——不稳定窗口里会整轮静默失败（实测发生过）。被外部
 * 中止（新回合取代/卸载）时不重试。
 */
export async function generateSuggestion(
  ctx: Context,
  config: Config,
  session: Session,
  turn: number,
  signal: AbortSignal,
): Promise<SuggestGhostSuggested | undefined> {
  signal.throwIfAborted();
  const transcript = buildTranscript(session, config.maxRecentTurns ?? 1, config.maxTranscriptChars);
  if (transcript === undefined) {
    throw new Error('dsh-suggest-ghost: session has no model-visible transcript to suggest from');
  }
  const route = routeOf(session, config);
  const language = suggestionLanguage(transcript.pairs);
  const system = systemPrompt(config.maxSuggestionChars, language);
  const framed = frameTranscript(transcript.pairs);
  const inputBytes = Buffer.byteLength(framed, 'utf8');
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`dsh-suggest-ghost: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`);
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'plugin', plugin: 'dsh-suggest-ghost' },
  })];
  // 请求细节（turn/seq/provider/model/maxTokens）不再写入会话日志：
  // rc.7 禁止未标记 ignorable 的自定义事件落日志，且建议经 settings `_push` 实时送达 client。

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 每次尝试独立截止时间：timeoutMs 是「单次调用」预算而非三次总和。
    using callDeadline = deadline(signal, config.timeoutMs, SUGGEST_TIMEOUT_CODE);
    const options: GenerateOptions = deepFreeze({
      provider: route.provider,
      model: route.model,
      messages,
      system,
      maxTokens: config.maxOutputTokens,
      sessionId: session.id,
      signal: callDeadline.signal,
    });
    try {
      callDeadline.signal.throwIfAborted();
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(options)) {
        callDeadline.signal.throwIfAborted();
        assembler.push(chunk);
      }
      callDeadline.signal.throwIfAborted();
      const terminalError = finishError(assembler.finish);
      if (terminalError !== undefined) throw terminalError;
      const blocks = assembler.blocks();
      if (blocks.some(block => block.type === 'tool-call')) {
        throw new Error('dsh-suggest-ghost: suggestion output must contain text only');
      }
      const text = blocks
        .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join(' ');
      const cleaned = cleanSuggestion(text);
      if (cleaned.length === 0 || shouldFilterSuggestion(cleaned)) {
        // 空回复或不合格回复 = 正常「无建议」。
        return undefined;
      }
      const { text: suggestion, truncated } = sanitizeSuggestion(cleaned, config.maxSuggestionChars);
      const suggested: SuggestGhostSuggested = {
        version: 1,
        turn,
        baseSeq: transcript.baseSeq,
        text: suggestion,
        truncated,
        acceptKey: config.acceptKey ?? 'Tab',
      };
      return suggested;
    } catch (error) {
      // 外部中止（新回合取代 / 卸载）不重试；最后一次尝试失败则原样抛出。
      if (signal.aborted || attempt >= maxAttempts) throw error;
      ctx.logger.debug?.(`dsh-suggest-ghost: suggestion attempt ${attempt}/${maxAttempts} failed, retrying: ${String(error)}`);
      await backoff(signal, 1200 * attempt);
    }
  }
  /* v8 ignore next 2 -- 循环内必然 return 或 throw，此处仅满足类型收窄 */
  throw new Error('dsh-suggest-ghost: suggestion generation exhausted retries');
}

export { PROJECTION_KEY };
