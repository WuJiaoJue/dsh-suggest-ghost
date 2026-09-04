window.__ModuleLoader__.load({
	id: "dsh-suggest-ghost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// src/client/history.ts
function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  let text = "";
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const record = block;
    if (record.type === "text" && typeof record.text === "string") text += record.text;
  }
  return text;
}
var HISTORY_TEXT_MAX_CHARS = 2e3;
function extractHistory(nodes) {
  const out = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const record = node;
    if (record.kind !== "user" && record.kind !== "user/message") continue;
    const payload = record.data ?? record;
    const srcKind = payload.source?.kind;
    if (typeof srcKind === "string" && srcKind !== "user") continue;
    const text = textOf(payload.content).trim();
    if (text === "" || text.startsWith("<system-reminder>") || text.length > HISTORY_TEXT_MAX_CHARS) continue;
    const last = out[out.length - 1];
    if (last !== void 0 && last === text) continue;
    out.push(text);
  }
  return out;
}
function normalizeForMatch(text) {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248)).replace(/\u3000/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
}
function commonPrefixLength(a, b) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}
var TIME_TOKEN_RE = /^[+\d].*|^[a-z]+\d+.*|^\d{1,2}:\d{2}.*|^\d+月.*|^\d{1,2}日.*|^[上下]周.*|^今天.*|^明天.*|^后天.*|^今.*|^明.*|^后.*/i;
function stripCommandPrefix(draft) {
  const head = /^\/([A-Za-z][\w-]*)((?:\s+[\s\S]*)?)$/.exec(draft);
  if (head === null) return draft;
  const rest = (head[2] ?? "").replace(/^\s+/, "");
  if (rest === "") return "";
  const firstToken = /^\S+/.exec(rest);
  if (firstToken === null) return rest;
  if (TIME_TOKEN_RE.test(firstToken[0])) {
    return rest.slice(firstToken[0].length).replace(/^\s+/, "");
  }
  return rest;
}
var HISTORY_WEIGHTS = {
  /** 新近度（0–1，最新≈1）；跨会话候选固定 0。 */
  recency: 1,
  /** 会话内出现次数 / 候选内最大次数（0–1）。 */
  localFreq: 0.45,
  /** 全局热度频次 / 热度表最大频次（0–1；无热度信号时为 0）。 */
  hotFreq: 0.3,
  /** 后缀信息量：min(后缀长, 60) / 60，偏好有内容的补全而非 1 字符碎片。 */
  suffixLen: 0.1
};
var SUFFIX_LEN_CAP = 60;
function historySuggestion(history, draft, opts = { minChars: 1, maxEntries: 0 }) {
  const normDraft = normalizeForMatch(draft);
  if (normDraft === "" || normDraft.length < opts.minChars) return void 0;
  const entries = opts.maxEntries > 0 ? history.slice(-opts.maxEntries) : history;
  const byNorm = /* @__PURE__ */ new Map();
  entries.forEach((raw, idx) => {
    const norm = normalizeForMatch(raw);
    if (norm === "") return;
    const prev = byNorm.get(norm);
    if (prev === void 0) {
      byNorm.set(norm, { text: raw, norm, bestIdx: idx, localCount: 1 });
    } else {
      prev.localCount += 1;
      if (idx > prev.bestIdx) {
        prev.bestIdx = idx;
        prev.text = raw;
      }
    }
  });
  if (opts.extraCandidates !== void 0) {
    for (const item of opts.extraCandidates) {
      const norm = normalizeForMatch(item.text);
      if (norm === "" || byNorm.has(norm)) continue;
      byNorm.set(norm, { text: item.text, norm, bestIdx: -1, localCount: 0 });
    }
  }
  let maxLocal = 0;
  for (const c of byNorm.values()) if (c.localCount > maxLocal) maxLocal = c.localCount;
  let maxHot = 0;
  if (opts.hotCounts !== void 0) {
    for (const h of opts.hotCounts.values()) if (h > maxHot) maxHot = h;
  }
  let best;
  let bestScore = 0;
  let bestRecency = -1;
  for (const c of byNorm.values()) {
    if (c.norm === normDraft) continue;
    if (!c.norm.startsWith(normDraft)) continue;
    const recency = c.bestIdx < 0 ? 0 : (c.bestIdx + 1) / Math.max(entries.length, 1);
    const localFreq = maxLocal > 0 ? c.localCount / maxLocal : 0;
    const hotCount = opts.hotCounts?.get(c.norm) ?? 0;
    const hotFreq = maxHot > 0 ? hotCount / maxHot : 0;
    const suffixLen = Math.min(Math.max(c.norm.length - normDraft.length, 0), SUFFIX_LEN_CAP) / SUFFIX_LEN_CAP;
    const score = HISTORY_WEIGHTS.recency * recency + HISTORY_WEIGHTS.localFreq * localFreq + HISTORY_WEIGHTS.hotFreq * hotFreq + HISTORY_WEIGHTS.suffixLen * suffixLen;
    if (best === void 0 || score > bestScore || score === bestScore && recency > bestRecency) {
      best = c;
      bestScore = score;
      bestRecency = recency;
    }
  }
  return best?.text;
}

// src/client/chunk.ts
var segmenter;
try {
  const ctor = Intl.Segmenter;
  segmenter = typeof ctor === "function" ? new ctor("zh", { granularity: "word" }) : void 0;
} catch {
  segmenter = void 0;
}
function charClassOf(ch) {
  if (/\s/.test(ch)) return "space";
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) return "cjk";
  if (/[\w]/.test(ch)) return "word";
  return "punct";
}
function nextAcceptChunkFallback(text) {
  if (text === "") return "";
  let i = 0;
  while (i < text.length && charClassOf(text[i]) === "space") i++;
  if (i < text.length) {
    const cls = charClassOf(text[i]);
    let run = 0;
    while (i < text.length && charClassOf(text[i]) === cls) {
      i++;
      run++;
      if (cls === "cjk" && run >= 2) break;
    }
    while (i < text.length && charClassOf(text[i]) === "space") i++;
  }
  return text.slice(0, Math.max(i, 1));
}
function nextAcceptChunk(text) {
  if (text === "") return "";
  if (segmenter === void 0) return nextAcceptChunkFallback(text);
  const parts = [...segmenter.segment(text)];
  let firstWord = 0;
  while (firstWord < parts.length && !parts[firstWord].isWordLike) firstWord++;
  if (firstWord >= parts.length) return text;
  let end = firstWord + 1;
  while (end < parts.length && !parts[end].isWordLike) end++;
  return parts.slice(0, end).map((p) => p.segment).join("");
}

// src/client/keyspec.ts
var KEY_CODES = {
  tab: "Tab",
  enter: "Enter",
  slash: "Slash",
  space: "Space",
  comma: "Comma",
  period: "Period",
  minus: "Minus",
  equal: "Equal",
  semicolon: "Semicolon",
  quote: "Quote",
  backquote: "Backquote",
  backslash: "Backslash",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]))
};
function keyCodeOf(spec) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const key = parts[parts.length - 1];
  const direct = key === void 0 ? void 0 : KEY_CODES[key];
  if (direct !== void 0) return direct;
  if (key !== void 0 && /^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (key !== void 0 && /^[0-9]$/.test(key)) return `Digit${key}`;
  return void 0;
}
function keyNameOfCode(code) {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  const arrows = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right"
  };
  if (code in arrows) return arrows[code];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (Object.values(KEY_CODES).includes(code)) return code;
  return void 0;
}
var MODIFIER_KEYS = /* @__PURE__ */ new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "Fn", "FnLock"]);
function keyEventToSpec(event) {
  if (MODIFIER_KEYS.has(event.key)) return void 0;
  const key = keyNameOfCode(event.code);
  if (key === void 0) return void 0;
  const mods = [];
  if (event.altKey) mods.push("Alt");
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.metaKey) mods.push("Meta");
  if (event.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

// src/client/settings-card.tsx
var import_react2 = require("react");

// src/client/useGhostT.ts
var import_react = require("react");
var noopSubscribe = () => () => {
};
function useGhostT(locale) {
  const subscribe = (0, import_react.useCallback)(
    (onStoreChange) => locale === void 0 ? noopSubscribe() : locale.subscribe(onStoreChange),
    [locale]
  );
  const getActive = (0, import_react.useCallback)(
    () => locale === void 0 ? "zh" : locale.getSnapshot().active,
    [locale]
  );
  const active = (0, import_react.useSyncExternalStore)(subscribe, getActive, getActive);
  return active === "en" ? "en" : "zh";
}

// src/client/settings-card.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var GHOST_FIELDS = [
  // —— LLM 下一条建议 ——
  {
    key: "maxOutputTokens",
    label: { zh: "\u8F93\u51FA\u4EE4\u724C\u4E0A\u9650", en: "Output token cap" },
    hint: {
      zh: "\u5EFA\u8BAE\u751F\u6210\u7684\u6700\u5927\u8F93\u51FA token\uFF08\u63A8\u7406\u6A21\u578B\u7559\u8DB3\u9884\u7B97\uFF0C\u5982 512\uFF09",
      en: "Max output tokens per suggestion (leave headroom for reasoning models, e.g. 512)"
    },
    kind: "number",
    section: "llm"
  },
  {
    key: "maxSuggestionChars",
    label: { zh: "\u5EFA\u8BAE\u5B57\u7B26\u4E0A\u9650", en: "Suggestion character cap" },
    hint: { zh: "\u5E7D\u7075\u6587\u672C\u53EF\u89C1\u5B57\u7B26\u6570\u4E0A\u9650", en: "Max visible characters of the ghost text" },
    kind: "number",
    section: "llm"
  },
  {
    key: "maxRecentTurns",
    label: { zh: "\u53C2\u8003\u56DE\u5408\u6570", en: "Recent turns referenced" },
    hint: {
      zh: "\u8F6C\u5F55\u5C3E\u90E8\u4FDD\u7559\u7684\u6700\u8FD1\u5B8C\u6210\u56DE\u5408\u6570\uFF081 = \u53EA\u53D6\u6700\u540E\u4E00\u8F6E\uFF09",
      en: "Completed turns kept from the transcript tail (1 = last turn only)"
    },
    kind: "number",
    section: "llm"
  },
  {
    key: "maxTranscriptChars",
    label: { zh: "\u8F6C\u5F55\u5B57\u7B26\u9884\u7B97", en: "Transcript character budget" },
    hint: {
      zh: "\u53D1\u9001\u7ED9\u5EFA\u8BAE\u6A21\u578B\u7684\u8F6C\u5F55\u5B57\u7B26\u4E0A\u9650",
      en: "Max transcript characters sent to the suggestion model"
    },
    kind: "number",
    section: "llm"
  },
  {
    key: "timeoutMs",
    label: { zh: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", en: "Timeout (ms)" },
    hint: {
      zh: "\u8F85\u52A9 LLM \u8BF7\u6C42\u7AEF\u5230\u7AEF\u622A\u6B62\u65F6\u95F4",
      en: "End-to-end deadline for the auxiliary LLM request"
    },
    kind: "number",
    section: "llm"
  },
  {
    key: "acceptKey",
    label: { zh: "\u91C7\u7EB3\u5FEB\u6377\u952E", en: "Accept shortcut" },
    hint: {
      zh: "\u70B9\u51FB\u540E\u6309\u4E0B\u7EC4\u5408\u952E\uFF1B\u652F\u6301 Tab\u3001\u5B57\u6BCD/\u6570\u5B57\u3001F1-F12\u3001\u65B9\u5411\u952E\u7B49\uFF08\u4E24\u4E2A\u529F\u80FD\u5171\u7528\uFF09",
      en: "Click, then press a key combo; supports Tab, letters/digits, F1-F12, arrows, etc. (shared by both features)"
    },
    kind: "key",
    section: "llm"
  },
  {
    key: "llmEnabled",
    label: { zh: "\u542F\u7528 LLM \u5EFA\u8BAE", en: "Enable LLM suggestions" },
    hint: {
      zh: "\u5173\u95ED\u540E\u6BCF\u56DE\u5408\u4E0D\u518D\u8C03\u7528\u5EFA\u8BAE\u6A21\u578B\uFF08\u7701 token\uFF09\uFF1B\u5386\u53F2\u524D\u7F00\u8865\u5168\u4E0E\u70ED\u5EA6\u4E0D\u53D7\u5F71\u54CD",
      en: "When off, no suggestion model call per turn (saves tokens); history completion and hotness are unaffected"
    },
    kind: "boolean",
    section: "llm"
  },
  {
    key: "provider",
    label: { zh: "Provider", en: "Provider" },
    hint: {
      zh: "\u663E\u5F0F\u8DEF\u7531\uFF1B\u7559\u7A7A\u7EE7\u627F\u4E3B\u8BF7\u6C42\u8DEF\u7531",
      en: "Explicit routing; leave empty to inherit the main request route"
    },
    kind: "text",
    section: "llm"
  },
  {
    key: "model",
    label: { zh: "Model", en: "Model" },
    hint: {
      zh: "\u663E\u5F0F\u8DEF\u7531\uFF1B\u7559\u7A7A\u7EE7\u627F\u4E3B\u8BF7\u6C42\u8DEF\u7531",
      en: "Explicit routing; leave empty to inherit the main request route"
    },
    kind: "text",
    section: "llm"
  },
  // —— 历史前缀补全 ——
  {
    key: "historyEnabled",
    label: { zh: "\u542F\u7528\u5386\u53F2\u8865\u5168", en: "Enable history completion" },
    hint: {
      zh: "\u8349\u7A3F\u975E\u7A7A\u65F6\u6309\u5386\u53F2\u6D88\u606F\u524D\u7F00\u8865\u5168\uFF08\u6253\u5206\u5236\uFF1A\u6700\u8FD1\u4F18\u5148 + \u9891\u6B21/\u70ED\u5EA6\u52A0\u6743\uFF09",
      en: "Completes the draft from history-message prefixes while typing (scored: recency first, weighted by frequency/heat)"
    },
    kind: "boolean",
    section: "history"
  },
  {
    key: "historyCrossSession",
    label: { zh: "\u8DE8\u4F1A\u8BDD\u641C\u7D22", en: "Cross-session search" },
    hint: {
      zh: "\u5173=\u5019\u9009\u4EC5\u5F53\u524D\u4F1A\u8BDD\uFF1B\u5F00=\u5E76\u5165\u5176\u4ED6\u4F1A\u8BDD\u7684\u9AD8\u9891\u5386\u53F2\u3002\u70ED\u5EA6\u9891\u6B21\u6253\u5206\u4E0D\u53D7\u6B64\u5F00\u5173\u5F71\u54CD",
      en: "Off = candidates from this session only; on = merge frequent history from other sessions. Hotness frequency scoring is unaffected by this switch"
    },
    kind: "boolean",
    section: "history"
  },
  {
    key: "historyMaxEntries",
    label: { zh: "\u6700\u5927\u5386\u53F2\u6761\u76EE", en: "Max history entries" },
    hint: {
      zh: "\u6700\u591A\u53C2\u8003\u7684\u5386\u53F2\u6761\u76EE\u6570\uFF080 = \u4E0D\u9650\uFF09",
      en: "How many history entries to consider at most (0 = unlimited)"
    },
    kind: "number",
    section: "history"
  },
  {
    key: "historyMinChars",
    label: { zh: "\u6700\u5C11\u8F93\u5165\u5B57\u7B26", en: "Minimum typed characters" },
    hint: {
      zh: "\u8349\u7A3F\u8F93\u5165\u591A\u5C11\u5B57\u7B26\u540E\u624D\u89E6\u53D1\u8865\u5168\uFF08\u907F\u514D\u8FC7\u65E9\u5F39\u6846\uFF09",
      en: "How many characters must be typed before completion kicks in (avoids popping up too early)"
    },
    kind: "number",
    section: "history"
  },
  {
    key: "wordAccept",
    label: { zh: "\u9010\u8BCD\u91C7\u7EB3", en: "Word-by-word accept" },
    hint: {
      zh: "\u5E7D\u7075\u663E\u793A\u65F6\u6309 \u2192 \u6BCF\u6B21\u91C7\u7EB3\u4E00\u4E2A\u8BCD\uFF08\u4E2D\u6587\u6309\u8BCD\u5178\u5206\u8BCD\uFF09\uFF1BTab \u59CB\u7EC8\u6574\u6761\u91C7\u7EB3\u3002\u5BF9\u4E24\u79CD\u5EFA\u8BAE\u6A21\u5F0F\u90FD\u751F\u6548",
      en: "While the ghost shows, \u2192 accepts one word at a time (Chinese segments via dictionary); Tab always accepts the whole text. Applies to both suggestion modes"
    },
    kind: "boolean",
    section: "history"
  }
];
var zhStrings = {
  /** header 描述 */
  description: "\u8F93\u5165\u9884\u6D4B\uFF1A\u5386\u53F2\u524D\u7F00\u8865\u5168 + LLM \u4E0B\u4E00\u6761\u5EFA\u8BAE\uFF08\u8349\u7A3F\u4E3A\u7A7A\u65F6\uFF09\u3002\u6539\u52A8\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548\u3002",
  /** 未保存徽章 */
  unsaved: "\u672A\u4FDD\u5B58",
  /** 只读提示 */
  readOnly: "\u5F53\u524D\u90E8\u7F72\u4E0D\u53EF\u5199\uFF08\u5185\u5B58\u6A21\u5F0F\uFF09",
  /** 分组标题 */
  sectionLlm: "LLM \u4E0B\u4E00\u6761\u5EFA\u8BAE",
  sectionHistory: "\u5386\u53F2\u524D\u7F00\u8865\u5168",
  /** footer 状态与按钮 */
  saved: "\u5DF2\u4FDD\u5B58",
  discard: "\u653E\u5F03\u4FEE\u6539",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  save: "\u4FDD\u5B58",
  /** 数字字段校验错误 */
  invalidNumber: "\u8BF7\u8F93\u5165\u6570\u5B57",
  /** 布尔字段选项 */
  optionOn: "\u5F00\u542F",
  optionOff: "\u5173\u95ED",
  /** 快捷键控件 */
  keyCapturing: "\u6309\u4E0B\u7EC4\u5408\u952E\u2026\uFF08Esc \u53D6\u6D88\uFF09",
  keyEmpty: "\u70B9\u51FB\u8BBE\u7F6E\u5FEB\u6377\u952E"
};
var enStrings = {
  description: "Input prediction: history prefix completion + LLM next suggestion (while the draft is empty). Changes take effect right after saving.",
  unsaved: "Unsaved",
  readOnly: "Not writable in this deployment (in-memory mode)",
  sectionLlm: "LLM next suggestion",
  sectionHistory: "History prefix completion",
  saved: "Saved",
  discard: "Discard changes",
  saving: "Saving\u2026",
  save: "Save",
  invalidNumber: "Enter a number",
  optionOn: "On",
  optionOff: "Off",
  keyCapturing: "Press a key combo\u2026 (Esc to cancel)",
  keyEmpty: "Click to set a shortcut"
};
var GHOST_STRINGS = { zh: zhStrings, en: enStrings };
var CARD_CSS = [
  ".sgc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".sgc-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
  ".sgc-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".sgc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}",
  ".sgc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
  ".sgc-headText{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}",
  ".sgc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
  ".sgc-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
  ".sgc-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;flex:none}",
  ".sgc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".sgc-chevronOpen{transform:rotate(180deg)}",
  ".sgc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
  ".sgc-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
  ".sgc-section{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;line-height:1.5;margin:14px 0 0}",
  ".sgc-section+.sgc-field{border-top:0}",
  ".sgc-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
  ".sgc-field+.sgc-field{border-top:1px solid var(--dsw-alias-border-l2)}",
  ".sgc-fieldHead{display:flex;align-items:center;gap:8px}",
  ".sgc-label{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}",
  ".sgc-input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}",
  ".sgc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
  ".sgc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".sgc-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}",
  ".sgc-key{box-sizing:border-box;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}",
  ".sgc-key:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
  ".sgc-key:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".sgc-keyCapturing,.sgc-keyCapturing:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
  ".sgc-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}",
  ".sgc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
  ".sgc-footer{border-top:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px}",
  ".sgc-status{flex:1;min-width:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5}",
  ".sgc-save,.sgc-discard{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
  ".sgc-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
  ".sgc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}",
  ".sgc-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
  ".sgc-save:disabled,.sgc-discard:disabled{opacity:.4;cursor:default}",
  ".sgc-save:focus-visible,.sgc-discard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}"
].join("");
var STYLE_ID = "dsh-suggest-ghost-card-css";
if (typeof document !== "undefined" && document.getElementById(STYLE_ID) === null) {
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.dataset.pluginCss = "dsh-suggest-ghost/settings-card";
  tag.textContent = CARD_CSS;
  document.head.appendChild(tag);
}
function displayValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  return v === void 0 || v === null ? "" : String(v);
}
function ChevronDown({ className }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: "14", height: "14", viewBox: "0 0 16 16", className, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: "1.5", fill: "none", strokeLinecap: "round", strokeLinejoin: "round" }) });
}
function KeyField({ id, value, disabled, t, onChange }) {
  const [capturing, setCapturing] = (0, import_react2.useState)(false);
  (0, import_react2.useEffect)(() => {
    if (!capturing) return;
    const onKey = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        return;
      }
      const spec = keyEventToSpec(event);
      if (spec !== void 0) {
        onChange(spec);
        setCapturing(false);
      }
    };
    const cancel = () => setCapturing(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
  }, [capturing, onChange]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      id,
      className: capturing ? "sgc-key sgc-keyCapturing" : "sgc-key",
      disabled,
      onClick: () => setCapturing((c) => !c),
      children: capturing ? t.keyCapturing : value === "" ? t.keyEmpty : value
    }
  );
}
function SuggestGhostCard({ scope, locale }) {
  const lang = useGhostT(locale);
  const t = GHOST_STRINGS[lang];
  const [snap, setSnap] = (0, import_react2.useState)(scope.getSnapshot());
  (0, import_react2.useEffect)(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [edits, setEdits] = (0, import_react2.useState)({});
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [saved, setSaved] = (0, import_react2.useState)(false);
  const [open, setOpen] = (0, import_react2.useState)(false);
  if (snap.status === "unavailable") return null;
  const value = snap.value ?? {};
  const writable = snap.writable && snap.status === "ready";
  const isDirty = Object.keys(edits).length > 0;
  const fieldValue = (key) => {
    if (key in edits) return String(edits[key]);
    return displayValue(value[key]);
  };
  const fieldInvalid = (f) => {
    if (f.kind !== "number" || !(f.key in edits)) return false;
    const raw = String(edits[f.key]).trim();
    return raw === "" || Number.isNaN(Number(raw));
  };
  const anyInvalid = GHOST_FIELDS.some(fieldInvalid);
  const setField = (key, raw) => {
    setEdits((prev) => ({ ...prev, [key]: raw }));
  };
  const save = async () => {
    if (anyInvalid) return;
    setBusy(true);
    try {
      for (const [key, raw] of Object.entries(edits)) {
        const def = GHOST_FIELDS.find((f) => f.key === key);
        let final = raw;
        if (def.kind === "number") final = Number(raw);
        else if (def.kind === "boolean") final = raw === true || raw === "true";
        else if (def.kind === "key") {
          const trimmed = String(raw).trim();
          if (trimmed === "") continue;
          final = trimmed;
        }
        await scope.set(key, final);
      }
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2e3);
    } finally {
      setBusy(false);
    }
  };
  const discard = () => setEdits({});
  const renderField = (f) => {
    const invalid = fieldInvalid(f);
    const inputClass = invalid ? "sgc-input sgc-inputInvalid" : "sgc-input";
    const control = f.kind === "boolean" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "select",
      {
        className: inputClass,
        id: `sgc-field-${f.key}`,
        value: fieldValue(f.key) === "true" ? "true" : "false",
        disabled: !writable || busy,
        onChange: (e) => setField(f.key, e.target.value === "true"),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "true", children: t.optionOn }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "false", children: t.optionOff })
        ]
      }
    ) : f.kind === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      KeyField,
      {
        id: `sgc-field-${f.key}`,
        value: fieldValue(f.key),
        disabled: !writable || busy,
        t,
        onChange: (spec) => setField(f.key, spec)
      }
    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        className: inputClass,
        id: `sgc-field-${f.key}`,
        type: "text",
        ...f.kind === "number" ? { inputMode: "numeric" } : {},
        ...invalid ? { "aria-invalid": true } : {},
        value: fieldValue(f.key),
        disabled: !writable || busy,
        onChange: (e) => setField(f.key, e.target.value)
      }
    );
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-fieldHead", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "sgc-label", htmlFor: `sgc-field-${f.key}`, children: f.label[lang] }) }),
      control,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: invalid ? "sgc-invalid" : "sgc-hint", children: invalid ? t.invalidNumber : f.hint[lang] })
    ] }, f.key);
  };
  const llmFields = GHOST_FIELDS.filter((f) => f.section === "llm");
  const historyFields = GHOST_FIELDS.filter((f) => f.section === "history");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: open ? "sgc-card sgc-cardOpen" : "sgc-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        className: "sgc-header",
        "aria-expanded": open,
        onClick: () => setOpen((o) => !o),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "sgc-headText", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-name", children: "Suggest ghost" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-description", children: t.description })
          ] }),
          isDirty && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-pending", children: t.unsaved }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronDown, { className: open ? "sgc-chevron sgc-chevronOpen" : "sgc-chevron" })
        ]
      }
    ),
    open && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-body", children: [
      !writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-readOnly", children: t.readOnly }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-section", children: t.sectionLlm }),
      llmFields.map(renderField),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-section", children: t.sectionHistory }),
      historyFields.map(renderField),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-footer", children: [
        saved && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-status", role: "status", children: t.saved }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "sgc-discard", disabled: !isDirty || busy, onClick: discard, children: t.discard }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "sgc-save", disabled: !writable || busy || !isDirty || anyInvalid, onClick: () => void save(), children: busy ? t.saving : t.save })
      ] })
    ] })
  ] });
}

// src/client/index.ts
var PROJECTION_KEY = "suggestGhost";
var OVERLAY_ID = "dsh-suggest-ghost-overlay";
var DEFAULT_ACCEPT_KEY = "Tab";
var SETTINGS_NAMESPACE = "suggest-ghost";
var name = "dsh-suggest-ghost";
var inject = ["conversation", "sessions"];
function isComposerTarget(target) {
  if (!(target instanceof HTMLTextAreaElement)) return false;
  return target.closest("[data-input-scroll]") !== null;
}
function lastCompletedTurn(turnEnds) {
  let last;
  for (const turn of turnEnds.keys()) last = turn;
  return last;
}
function parseAcceptKey(spec) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const mods = new Set(parts.slice(0, -1));
  const keyCode = keyCodeOf(spec);
  if (keyCode === void 0) return void 0;
  return (event) => event.code === keyCode && event.altKey === mods.has("alt") && event.ctrlKey === mods.has("ctrl") && event.metaKey === mods.has("meta") && event.shiftKey === mods.has("shift");
}
var GhostOverlay = class {
  el;
  textarea = null;
  onScroll;
  styleTag;
  constructor() {
    this.el = document.createElement("div");
    this.el.id = OVERLAY_ID;
    this.el.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "white-space:pre-wrap",
      "word-break:break-word",
      // 不设 overflow:hidden：它会贴着盒子边界裁掉 text-shadow 光晕（明显切割感）；
      // 换行安全已由 pre-wrap + break-word 保证，盒子高度自适应无需纵向裁剪。
      // 对齐官方 composer placeholder 的色阶（label-caption，全透明度），
      // 而非更重的 label-secondary：保证「幽灵」比正文明显更淡。
      "color:var(--dsw-alias-label-caption, #9aa0a6)",
      // 轻微同色泛光（贴身 1px + 8px 柔光晕）：与原生 placeholder 区分，
      // 提示这是「可采纳的建议」而非占位文案；同色晕不改变色相、暗/亮主题通用。
      "text-shadow:0 0 1px var(--dsw-alias-label-caption, #9aa0a6), 0 0 8px var(--dsw-alias-label-caption, #9aa0a6)",
      "z-index:1",
      "visibility:hidden"
    ].join(";");
    this.onScroll = () => this.align();
    this.styleTag = document.createElement("style");
    this.styleTag.dataset.pluginCss = "dsh-suggest-ghost";
    this.styleTag.textContent = ".dsh-suggest-ghost-active::placeholder{opacity:0}";
    if (typeof document !== "undefined") document.head.appendChild(this.styleTag);
  }
  /** 当前绑定的 textarea（未绑定时为 null）。 */
  get currentTextarea() {
    return this.textarea;
  }
  /** 绑定到当前 textarea（若变化则重建对齐）。 */
  attach(textarea) {
    if (this.textarea === textarea) return;
    this.detach();
    this.textarea = textarea;
    const parent = textarea.parentElement;
    if (parent !== null && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    textarea.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onScroll);
    if (parent !== null) parent.appendChild(this.el);
    this.align();
  }
  detach() {
    if (this.textarea !== null) {
      this.textarea.removeEventListener("scroll", this.onScroll);
      this.textarea.classList.remove("dsh-suggest-ghost-active");
      this.textarea = null;
    }
    window.removeEventListener("resize", this.onScroll);
    this.el.remove();
  }
  /** 对齐 overlay 到 textarea 内容区（含 padding 起点、跟随滚动）。 */
  align() {
    const ta = this.textarea;
    if (ta === null) return;
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    this.el.style.left = `${ta.offsetLeft + borderLeft + padLeft}px`;
    this.el.style.top = `${ta.offsetTop + borderTop + padTop - ta.scrollTop}px`;
    this.el.style.width = `${ta.clientWidth - padLeft - (parseFloat(style.paddingRight) || 0)}px`;
    this.el.style.fontFamily = style.fontFamily;
    this.el.style.fontSize = style.fontSize;
    this.el.style.lineHeight = style.lineHeight;
    this.el.style.fontWeight = style.fontWeight;
    this.el.style.letterSpacing = style.letterSpacing;
    this.el.style.boxSizing = "border-box";
  }
  /** 显示幽灵内容（对齐由滚动/尺寸事件持续维护）；隐藏 placeholder 避免重叠。 */
  show(content) {
    this.el.textContent = "";
    if (content.kind === "llm") {
      this.el.textContent = content.text;
    } else {
      const prefix = document.createElement("span");
      prefix.style.visibility = "hidden";
      prefix.textContent = content.prefix;
      const suffix = document.createElement("span");
      suffix.textContent = content.suffix;
      this.el.append(prefix, suffix);
    }
    this.el.style.visibility = "visible";
    this.textarea?.classList.add("dsh-suggest-ghost-active");
    this.align();
  }
  hide() {
    this.el.style.visibility = "hidden";
    this.el.textContent = "";
    this.textarea?.classList.remove("dsh-suggest-ghost-active");
  }
  dispose() {
    this.detach();
    this.styleTag.remove();
  }
};
function apply(ctx) {
  const sessions = ctx.get("sessions");
  if (sessions === void 0) return;
  const overlay = new GhostOverlay();
  let lastSessionId;
  let bound = null;
  let shown = null;
  let settings = {
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    wordAccept: true,
    suggestion: null,
    hot: null
  };
  const resolve = () => {
    const id = sessions.list.getSnapshot().current;
    if (id === void 0) {
      bound = null;
      lastSessionId = void 0;
      return;
    }
    if (id === lastSessionId && bound !== null) return;
    const actx = sessions.scope(id);
    if (actx === void 0) return;
    const session = sessions.sessionOf(actx);
    if (session === void 0) return;
    const conversation = actx.get("conversation");
    if (conversation === void 0) return;
    const input = conversation.input.for(actx);
    if (input === void 0) return;
    lastSessionId = id;
    bound = {
      session,
      input,
      projectionFace: session.projections.faceOf(PROJECTION_KEY)
    };
  };
  const ghostContent = () => {
    if (bound === null) return null;
    const snapshot = bound.session.getSnapshot();
    const draft = bound.input.state.getSnapshot().draft;
    if (settings.historyEnabled && draft.trim() !== "") {
      const contentDraft = stripCommandPrefix(draft);
      if (contentDraft.trim() === "") return null;
      const chatValues = snapshot.chat?.nodes?.values?.() ?? [];
      const history = extractHistory(chatValues.length > 0 ? chatValues : snapshot.nodes);
      const hot = settings.hot;
      const hotCounts = hot !== null && hot.length > 0 ? new Map(hot.map((h) => [normalizeForMatch(h.text), h.count])) : void 0;
      const full = historySuggestion(history, contentDraft, {
        minChars: settings.historyMinChars,
        maxEntries: settings.historyMaxEntries,
        hotCounts,
        extraCandidates: settings.historyCrossSession ? hot ?? void 0 : void 0
      });
      if (full === void 0) return null;
      const common = commonPrefixLength(contentDraft, full);
      return { kind: "history", prefix: draft, suffix: full.slice(common), full };
    }
    const suggestion = settings.suggestion;
    if (suggestion === null || suggestion === void 0) return null;
    const lastTurn = lastCompletedTurn(snapshot.turnEnds);
    const stale = snapshot.running || lastTurn === void 0 || suggestion.turn !== lastTurn;
    if (stale) return null;
    return { kind: "llm", text: suggestion.text, acceptKey: suggestion.acceptKey };
  };
  let cachedTextarea = null;
  const render = () => {
    resolve();
    const content = ghostContent();
    if (content === null) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      return;
    }
    const key = content.kind === "llm" ? `llm:${content.text}` : `hist:${content.prefix}|${content.suffix}`;
    if (shown !== null && shown.key === key) return;
    const attached = overlay.currentTextarea;
    let textarea = attached !== null && attached.isConnected ? attached : cachedTextarea !== null && cachedTextarea.isConnected ? cachedTextarea : document.querySelector("[data-input-scroll] textarea");
    if (textarea === null) return;
    cachedTextarea = textarea;
    overlay.attach(textarea);
    overlay.show(content);
    shown = { key, content };
  };
  const settingsScope = ctx.get("settingsScope");
  if (settingsScope !== void 0) {
    const scope = settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
    const applySettings = () => {
      const snap = scope.getSnapshot();
      const v = snap.value ?? {};
      let pushed = null;
      if (typeof v._push === "string" && v._push !== "") {
        try {
          pushed = JSON.parse(v._push);
        } catch {
          pushed = null;
        }
      }
      settings = {
        historyEnabled: typeof v.historyEnabled === "boolean" ? v.historyEnabled : true,
        historyCrossSession: typeof v.historyCrossSession === "boolean" ? v.historyCrossSession : false,
        historyMaxEntries: typeof v.historyMaxEntries === "number" ? v.historyMaxEntries : 50,
        historyMinChars: typeof v.historyMinChars === "number" ? v.historyMinChars : 1,
        wordAccept: typeof v.wordAccept === "boolean" ? v.wordAccept : true,
        suggestion: pushed?.suggestion === null || pushed?.suggestion === void 0 ? null : pushed.suggestion,
        hot: pushed?.hot === null || pushed?.hot === void 0 ? null : pushed.hot
      };
      render();
    };
    scope.subscribe?.(applySettings);
    applySettings();
  }
  const onKeyDown = (event) => {
    if (event.isComposing) return;
    if (shown === null) return;
    if (!(document.activeElement instanceof HTMLTextAreaElement)) return;
    if (!isComposerTarget(document.activeElement)) return;
    const content = shown.content;
    const acceptKey = content.kind === "llm" ? content.acceptKey : DEFAULT_ACCEPT_KEY;
    const matcher = parseAcceptKey(acceptKey);
    if (matcher !== void 0 && matcher(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (bound !== null) {
        let accepted;
        if (content.kind === "llm") {
          accepted = content.text;
        } else {
          const draftNow = bound.input.state.getSnapshot().draft;
          const contentDraft = stripCommandPrefix(draftNow);
          const head = contentDraft === "" ? draftNow : draftNow.slice(0, draftNow.length - contentDraft.length);
          const tailJoiner = head.endsWith(" ") || head === "" ? "" : " ";
          accepted = `${head}${tailJoiner}${content.full}`;
        }
        bound.input.setDraft(accepted);
      }
      overlay.hide();
      shown = null;
      return;
    }
    if (settings.wordAccept && event.code === "ArrowRight" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const ta = document.activeElement;
      const draftNow = bound !== null ? bound.input.state.getSnapshot().draft : "";
      const full = content.kind === "llm" ? content.text : content.full;
      if (ta.selectionStart !== draftNow.length || ta.selectionEnd !== draftNow.length) return;
      const matchBase = content.kind === "history" ? stripCommandPrefix(draftNow) : draftNow;
      if (!full.startsWith(matchBase) || matchBase.length >= full.length) return;
      const chunk = nextAcceptChunk(full.slice(matchBase.length));
      if (chunk === "") return;
      event.preventDefault();
      event.stopPropagation();
      let accepted;
      if (content.kind === "history") {
        const head = matchBase === "" ? draftNow : draftNow.slice(0, draftNow.length - matchBase.length);
        const tailJoiner = head.endsWith(" ") || head === "" ? "" : " ";
        accepted = `${head}${tailJoiner}${matchBase}${chunk}`;
      } else {
        accepted = draftNow + chunk;
      }
      if (bound !== null) bound.input.setDraft(accepted);
      if (accepted === full || content.kind === "history" && accepted.endsWith(full)) {
        overlay.hide();
        shown = null;
      }
    }
  };
  ctx.effect(() => {
    let unsubs = [];
    const rebind = () => {
      for (const un of unsubs) un();
      unsubs = [];
      resolve();
      if (bound !== null) {
        unsubs.push(
          bound.session.subscribe(render),
          bound.input.state.subscribe(render),
          bound.projectionFace.subscribe(render)
        );
      }
    };
    rebind();
    render();
    const onList = () => {
      const id = sessions.list.getSnapshot().current;
      if (id !== lastSessionId) rebind();
      render();
    };
    const unList = sessions.list.subscribe(onList);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      unList();
      for (const un of unsubs) un();
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.dispose();
    };
  }, "dsh-suggest-ghost: composer ghost render");
  const slots = ctx.get("slots");
  const settingsScopeForCard = ctx.get("settingsScope");
  if (slots === void 0 || settingsScopeForCard === void 0) return;
  const locale = ctx.get("locale");
  slots.inject("settings.plugin.item", () => slots.register({
    name: "settings.plugin.item",
    // keyed slot：必须给 key（宿主按命名空间 dispatch，entryKey=namespace）。
    key: SETTINGS_NAMESPACE,
    order: 30,
    inject: () => ({ scope: settingsScopeForCard.bind({ namespace: SETTINGS_NAMESPACE }), locale })
  }, SuggestGhostCard));
}

		return module.exports;
	}
});
