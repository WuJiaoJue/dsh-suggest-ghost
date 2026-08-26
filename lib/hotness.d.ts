/**
 * 跨会话历史热度表：增量统计所有会话 `user/message` 的去重文本频次。
 * host 端全局一份，供历史补全打分取 top-K 快照（经 settings `_push` 送达 client）。
 * 纯内存、无持久化；重启后从零累积。条目数有上限（最久未用者淘汰），长驻内存有界。
 * @module dsh-suggest-ghost/hotness
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SuggestGhostHotEntry } from './domain.js';
/** 单条候选文本最大长度：超过视为系统注入/超大粘贴，不进热表。 */
export declare const HOT_TEXT_MAX_CHARS = 2000;
/** 热表条目数上限：超过后淘汰最近性最差的条目，防止长驻进程内存无限增长。
 * 取 2000 与设置页「最大历史条目」可配置的上限对齐（避免用户配大值被静默砍半）。 */
export declare const HOT_TABLE_MAX_ENTRIES = 2000;
/** 跨会话频次与最近性都保留（按 count 降序、lastSeq 降序取 top-K）。 */
export declare class HotnessTable {
    private readonly table;
    /** 每个会话最近一条已入表文本（trim 后）：同会话相邻重复不再计入频次。 */
    private readonly lastTextBySession;
    /**
     * 记账一次出现：同一会话内与上一条相邻重复的文本不再累计频次
     * （同一时刻重发 / 回放重复派发不应虚增热度）；跨会话的再次出现正常累计。
     */
    recordUserText(text: string, seq: number, sessionId?: string): void;
    /** 淘汰 lastSeq 最小的条目（最久未出现者优先出局）。 */
    private evictLeastRecent;
    /** 消费一条会话事件（仅处理真实用户发出的 user/message）；其余事件为空操作。
     * @param sessionId - 当前会话 id；传入以启用「同会话相邻去重」。 */
    consume(event: SessionEvent, sessionId?: string): void;
    /** 取 top-K（按频次降序、最近优先；K<=0 表示不限）。 */
    snapshot(limit: number): readonly SuggestGhostHotEntry[];
    /** 当前跟踪的去重会话数（即不同用户消息数）。 */
    get size(): number;
}
