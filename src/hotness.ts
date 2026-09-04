/**
 * 跨会话历史热度表：增量统计所有会话 `user/message` 的去重文本频次。
 * host 端全局一份，供历史补全打分取 top-K 快照（经 settings `_push` 送达 client）。
 * 纯内存、无持久化；重启后从零累积。条目数有上限（最久未用者淘汰），长驻内存有界。
 *
 * 淘汰用 lazy-deletion 最小堆（按 lastSeq）：新条目入堆，条目 lastSeq 更新时
 * 旧堆项自然过期，evict 时从堆顶跳过过期项——O(log n) 淘汰，替代全表线性扫描。
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

/**
 * 按 `seq` 升序的最小堆（lazy-deletion）：pop 时由调用方校验条目是否仍是
 * 当前值（seq 与表内一致），过期的旧版本堆项被丢弃后继续弹。仅用于找
 * 「最近性最差」的淘汰候选，不需要 decrease-key。
 */
class MinSeqHeap {
  private readonly heap: Array<{ readonly text: string; readonly seq: number }> = [];

  /** 压入一条（可重复压入同 text 的新 seq 版本；旧版本在 pop 时惰性跳过）。 */
  push(text: string, seq: number): void {
    this.heap.push({ text, seq });
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.seq <= this.heap[i]!.seq) break;
      const parentNode = this.heap[parent]!;
      const childNode = this.heap[i]!;
      this.heap[parent] = childNode;
      this.heap[i] = parentNode;
      i = parent;
    }
  }

  /**
   * 弹出 seq 最小的堆项；跳过已被 {@link validator} 判为过期的项。
   * @param validator - (text, seq) => boolean；返回 false 的堆项视为陈旧版本，
   * 直接丢弃（它对应的条目要么已删除、要么 lastSeq 已推进到更新的值）。
   */
  popValid(validator: (text: string, seq: number) => boolean): { readonly text: string; readonly seq: number } | undefined {
    while (this.heap.length > 0) {
      const top = this.heap[0]!;
      const last = this.heap.pop()!;
      if (this.heap.length > 0) {
        this.heap[0] = last;
        let i = 0;
        const n = this.heap.length;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let smallest = i;
          if (l < n && this.heap[l]!.seq < this.heap[smallest]!.seq) smallest = l;
          if (r < n && this.heap[r]!.seq < this.heap[smallest]!.seq) smallest = r;
          if (smallest === i) break;
          const smallestNode = this.heap[smallest]!;
          const node = this.heap[i]!;
          this.heap[smallest] = node;
          this.heap[i] = smallestNode;
          i = smallest;
        }
      }
      if (validator(top.text, top.seq)) return top;
    }
    return undefined;
  }

  get size(): number {
    return this.heap.length;
  }
}

/** 跨会话频次与最近性都保留（按 count 降序、lastSeq 降序取 top-K）。 */
export class HotnessTable {
  private readonly table = new Map<string, HotEntry>();
  /** 每个会话最近一条已入表文本（trim 后）：同会话相邻重复不再计入频次。 */
  private readonly lastTextBySession = new Map<string, string>();
  /** 按 lastSeq 的最小堆：evict 时取最近性最差的条目（lazy-deletion）。 */
  private heap = new MinSeqHeap();

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
      this.heap.push(clean, seq);
      // 内存界限：淘汰最近性最差的条目（长驻进程不至于无限增长）。
      if (this.table.size > HOT_TABLE_MAX_ENTRIES) this.evictLeastRecent();
      return;
    }
    prev.count += 1;
    if (seq > prev.lastSeq) {
      prev.lastSeq = seq;
      // lazy 更新：新 seq 版本入堆；旧版本在 evict 时经 validator 判过期
      // 惰性丢弃（只保留「seq 与表内当前 lastSeq 一致」的有效版本）。
      this.heap.push(clean, seq);
    }
  }

  /** 淘汰 lastSeq 最小的条目（最久未出现者优先出局）。 */
  private evictLeastRecent(): void {
    const victim = this.heap.popValid(
      (text, seq) => this.table.get(text)?.lastSeq === seq,
    );
    if (victim !== undefined) this.table.delete(victim.text);
    // lazy 堆会随每次 lastSeq 更新累积陈旧版本；远超过表内条目数时压缩一次，
    // 防止同文本反复出现导致堆无限膨胀（长期驻留进程的内存保护）。
    if (this.heap.size > this.table.size * 4 + 64) this.compactHeap();
  }

  /** 重建堆，只保留与表内当前 lastSeq 一致的有效版本（O(表大小)）。 */
  private compactHeap(): void {
    const compact = new MinSeqHeap();
    for (const [text, entry] of this.table) compact.push(text, entry.lastSeq);
    this.heap = compact;
  }

  /** 消费一条会话事件（仅处理真实用户发出的 user/message）；其余事件为空操作。
   * @param sessionId - 当前会话 id；传入以启用「同会话相邻去重」。 */
  consume(event: SessionEvent, sessionId?: string): void {
    if (event.type !== 'user/message') return;
    // `user/message` 事件是真 discriminated union：收窄后 event.data 即
    // UserMessage（content/source 必填）。只统计 source.kind === 'user' 的
    // 消息：系统注入（runtime 快照、system-reminder 等）虽以 user 角色入日志，
    // 但 source.kind 为 'plugin'，作为补全候选毫无意义，且巨型文本会挤占
    // top-K、撑大推送载荷。source 缺失的畸形载荷（旧日志/手写回放）直接跳过。
    const { source, content } = event.data;
    if (source === undefined || source.kind !== 'user') return;
    // 防御性长度上限：正常提示词远小于此；超长文本无法成为有效补全。
    const text = extractText(content);
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
