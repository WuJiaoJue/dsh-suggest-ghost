// dsh-suggest-ghost 历史补全纯函数冒烟测试（node --experimental-strip-types 直接跑 TS 源）。
import assert from 'node:assert/strict';
import {
  extractHistory,
  historySuggestion,
  normalizeForMatch,
  commonPrefixLength,
} from '../src/client/history.ts';
import { HotnessTable } from '../src/hotness.ts';
import { nextAcceptChunk, nextAcceptChunkFallback } from '../src/client/chunk.ts';

const T = '帮我写个单元测试';
const R = '帮我看下这个日志';
const X = '帮我部署到预发环境';
const opts = { minChars: 1, maxEntries: 0 };

// —— B：归一化 ——
assert.equal(normalizeForMatch('Ｈello，Ｗorld！'), 'hello,world!');
assert.equal(normalizeForMatch('  a　b\t c '), 'a b c');
// 全角草稿 vs 半角历史
assert.equal(historySuggestion(['帮我,看下日志'], '帮我，', opts), '帮我,看下日志');
// 尾部空格草稿仍可匹配；渲染公共前缀按原文计算
assert.equal(commonPrefixLength('帮我 ', '帮我看下日志'), 2);
assert.equal(historySuggestion(['帮我看下日志'], '帮我 ', opts), '帮我看下日志');
// 归一化意义下与草稿完全相同 → 排除
assert.equal(historySuggestion(['你好世界'], '你好世界 ', opts), undefined);
assert.equal(historySuggestion(['你好世界！'], '你好世界!', opts), undefined);

// —— A：打分制 ——
// 新近度主导：一次性最新短语压过较旧的高频短语
assert.equal(
  historySuggestion([T, T, R], '帮我', opts),
  R,
  '新近度应占主导',
);
// 频次纠偏：高频旧短语压过一次性新短语
assert.equal(
  historySuggestion([T, T, T, T, T, R], '帮我', opts),
  T,
  '高频旧短语应在频次项下胜出',
);
// maxEntries 截尾保留最近 N 条
assert.equal(
  historySuggestion([T, T, T, R], '帮我', { minChars: 1, maxEntries: 1 }),
  R,
  '截尾后只剩最近一条',
);

// —— C：热度频次 ——
// 场景：R 在 idx7（recency .8），X 最新 idx9（recency 1.0）；无热度时 X 胜，
// R 有满额热度时反超（0.3 权重 > 0.2 的 recency 差）。
const arr2 = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', R, 'f8', X];
// 无热度：最新者胜
assert.equal(
  historySuggestion(arr2, '帮我', opts),
  X,
  '无热度信号时最近者胜',
);
// 有热度：次新条目凭频次反超
assert.equal(
  historySuggestion(arr2, '帮我', { ...opts, hotCounts: new Map([[normalizeForMatch(R), 99]]) }),
  R,
  '热度频次应让次新条目反超',
);
// extraCandidates：会话内没有的历史也能成为候选；重复文本不产生双候选
assert.equal(
  historySuggestion(['完全无关的消息'], '帮我', { ...opts, extraCandidates: [{ text: R, count: 5 }] }),
  R,
  '跨会话候选应参与竞争',
);
assert.equal(
  historySuggestion([R], '帮我', {
    ...opts,
    hotCounts: new Map([[normalizeForMatch(R), 5]]),
    extraCandidates: [{ text: R, count: 5 }],
  }),
  R,
  '会话内已有该文本时热度并入同一候选',
);

// —— extractHistory 回归：仅 user 节点、跳过空白、去相邻重复 ——
const nodes = [
  { kind: 'user', content: [{ type: 'text', text: '  第一条  ' }] },
  { kind: 'user', content: [{ type: 'text', text: '其他消息' }] }, // 隔开两条相同消息
  { kind: 'assistant', content: [{ type: 'text', text: 'AI 回复不算' }] },
  { kind: 'user', content: [{ type: 'text', text: '第一条' }] }, // 非相邻：不去重
  { kind: 'user', content: [{ type: 'text', text: '   ' }] }, // 空白跳过
];
assert.deepEqual(extractHistory(nodes), ['第一条', '其他消息', '第一条']);

// —— 系统注入过滤（活实例测试发现的回归）——
// extractHistory：跳过 <system-reminder> 包装块与超长文本；带 source 的注入节点跳过。
{
  const nodes = [
    { kind: 'user', content: [{ type: 'text', text: '<system-reminder>\nA skill is...' }] },
    { kind: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Current runtime context...' }] },
    { kind: 'user', content: [{ type: 'text', text: 'x'.repeat(3000) }] },
    { kind: 'user', content: [{ type: 'text', text: '正常消息' }] },
  ];
  assert.deepEqual(extractHistory(nodes), ['正常消息']);
}
// HotnessTable：source.kind 非 user 不计数、超长不计；
// 同会话相邻重复只计一次（对齐 extractHistory 去重），跨会话再次出现才累计。
{
  const hot = new HotnessTable();
  const ev = (kind, text, seq) => ({
    type: 'user/message',
    seq,
    data: { content: [{ type: 'text', text }], ...(kind === null ? {} : { source: { kind } }) },
  });
  hot.consume(ev('user', '部署到测试环境', 1), 's1');
  hot.consume(ev('user', '部署到测试环境', 2), 's1'); // 同会话相邻重复：不虚增
  hot.consume(ev('user', '部署到测试环境', 3), 's2'); // 跨会话再次出现：计入
  hot.consume(ev('plugin', 'Current runtime context...', 4), 's1'); // 系统注入
  hot.consume(ev(null, '缺 source 的未知消息不计', 5), 's1'); // 严格白名单
  hot.consume(ev('user', 'y'.repeat(3000), 6), 's1'); // 超长防御
  const snap = hot.snapshot(0);
  assert.deepEqual(snap.map(e => e.text), ['部署到测试环境']);
  assert.equal(snap[0]?.count, 2);
}

// —— 逐词采纳切分 ——
// 英文：词 + 尾随空格
assert.equal(nextAcceptChunk('run the tests'), 'run ');
assert.equal(nextAcceptChunk('the tests'), 'the ');
assert.equal(nextAcceptChunk('tests'), 'tests');
// 中文词典分词；词尾标点跟随词
const zh = '提交一下代码，然后跑测试';
assert.equal(nextAcceptChunk(zh), '提交');
assert.equal(nextAcceptChunk(zh.slice(2)), '一下');
assert.equal(nextAcceptChunk(zh.slice(4)), '代码，');
// 前导标点/空白并入下一片段（不产生纯空片段）
assert.equal(nextAcceptChunk('，然后'), '，然后');
assert.equal(nextAcceptChunk(' world'), ' world');
// 全标点后缀整段收尾；空串原样
assert.equal(nextAcceptChunk('。！？'), '。！？');
assert.equal(nextAcceptChunk(''), '');
// 回退路径（无 Intl.Segmenter）：CJK 每片 ≤2 字、英文按空格、前导空格并入
assert.equal(nextAcceptChunkFallback('帮我看下日志'), '帮我');
assert.equal(nextAcceptChunkFallback('run the'), 'run ');
assert.equal(nextAcceptChunkFallback(' the'), ' the');

console.log('✅ 全部冒烟测试通过');
