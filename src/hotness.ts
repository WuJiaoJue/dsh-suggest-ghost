/**
 * 跨会话历史热度表：增量统计所有会话 `user/message` 的去重文本频次。
 * host 端全局一份，供历史补全打分取 top-K 快照（经 settings `_push` 送达 client）。
 * 纯内存、无持久化；重启后从零累积。条目数有上限（最久未用者淘汰），长驻内存有界。
 * @module dsh-suggest-ghost/hotness
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SuggestGhostHotEntry } from './domain.js';

/** 单条候选文本最大长度：超过视为系统注入/超大粘贴，不进热表。 */
export const HOT_TEXT_MAX_CHARS = 2000;

/** 热表条目数上限：超过后淘汰最近性最差的条目，防止长驻进程内存无限增长。
 * 取 2000 与设置页「最大历史条目」可配置的上限对齐（避免用户配大值被静默砍半）。 */
export const HOT_TABLE_MAX_ENTRIES = 2000;

/** 单个用户文本的热度记账。 */
interface HotEntry {
  /** 累计跨会话出现频次。 */
  count: number;
  /** 最近一次出现的事件 seq（跨会话越大越新）。 */
  lastSeq: number;
}

/** 跨会话频次与最近性都保留（按 count 降序、lastSeq 降序取 top-K）。 */
export class HotnessTable {
  private readonly table = new Map<string, HotEntry>();
  /** 每个会话最近一条已入表文本（trim 后）：同会话相邻重复不再计入频次。 */
  private readonly lastTextBySession = new Map<string, string>();

  /**
   * 记账一次出现：同一会话内与上一条相邻重复的文本不再累计频次
   * （同一时刻重发 / 回放重复派发不应虚增热度）；跨会话的再次出现正常累计。
   */
  recordUserText(text: string, seq: number, sessionId?: string): void {
    const clean = text.trim();
    if (clean === '') return;
    const sessionKey = sessionId ?? '';
    // 同会话相邻重复（同一时刻重发）只计一次频次，也不推进最近性。
    if (this.lastTextBySession.get(sessionKey) === clean) return;
    this.lastTextBySession.set(sessionKey, clean);
    const prev = this.table.get(clean);
    if (prev === undefined) {
      this.table.set(clean, { count: 1, lastSeq: seq });
      // 内存界限：淘汰最近性最差的条目（长驻进程不至于无限增长）。
      if (this.table.size > HOT_TABLE_MAX_ENTRIES) this.evictLeastRecent();
      return;
    }
    prev.count += 1;
    if (seq > prev.lastSeq) prev.lastSeq = seq;
  }

  /** 淘汰 lastSeq 最小的条目（最久未出现者优先出局）。 */
  private evictLeastRecent(): void {
    let victim: string | undefined;
    let victimSeq = Infinity;
    for (const [text, entry] of this.table) {
      if (entry.lastSeq < victimSeq) {
        victimSeq = entry.lastSeq;
        victim = text;
      }
    }
    if (victim !== undefined) this.table.delete(victim);
  }

  /** 消费一条会话事件（仅处理真实用户发出的 user/message）；其余事件为空操作。
   * @param sessionId - 当前会话 id；传入以启用「同会话相邻去重」。 */
  consume(event: SessionEvent, sessionId?: string): void {
    if (event.type !== 'user/message') return;
    // 只统计 source.kind === 'user' 的消息：系统注入（runtime 快照、
    // system-reminder 等）虽以 user 角色入日志，但 source.kind 为 'plugin'，
    // 作为补全候选毫无意义，且巨型文本会挤占 top-K、撑大推送载荷。
    const data = (event as unknown as {
      data?: { content?: unknown; source?: { kind?: unknown } };
    }).data;
    if (data?.source?.kind !== 'user') return;
    // 防御性长度上限：正常提示词远小于此；超长文本无法成为有效补全。
    const text = extractText(data?.content);
    if (text === '' || text.length > HOT_TEXT_MAX_CHARS) return;
    this.recordUserText(text, event.seq, sessionId);
  }

  /** 取 top-K（按频次降序、最近优先；K<=0 表示不限）。 */
  snapshot(limit: number): readonly SuggestGhostHotEntry[] {
    const ranked = [...this.table.entries()]
      .map(([text, entry]) => ({ text, count: entry.count, lastSeq: entry.lastSeq }))
      .sort((a, b) => b.count - a.count || b.lastSeq - a.lastSeq);
    const slice = limit > 0 ? ranked.slice(0, limit) : ranked;
    return slice.map(({ text, count }) => ({ text, count }));
  }

  /** 当前跟踪的去重会话数（即不同用户消息数）。 */
  get size(): number {
    return this.table.size;
  }
}

/** 从内容块数组提取纯文本（与 client `textOf` 语义一致）。 */
function extractText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') out += record.text;
  }
  return out.trim();
}
