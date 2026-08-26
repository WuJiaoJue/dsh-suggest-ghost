/**
 * SuggestGhost 设置卡片：渲染到 WebUI 设置 → Plugins 面板
 * （settings.plugin.item 槽位），编辑 `suggest-ghost` settings 命名空间。
 * React 组件，运行时从宿主解析 react（esbuild external）。
 *
 * 视觉对齐官方 PluginCard（dsh-client-ui-settings-plugins，私有组件无法
 * import，这里按其发布的 CSS 逐 token 自实现）：
 * - 卡片：bg-layer-3 底、12px 圆角、hover/展开时边框 label-dimmed、
 *   展开底色切 bg-layer-2，.16s 过渡；
 * - header：14px 16px 内边距、name 15px/600、description 13px tertiary、
 *   focus-visible 品牌色 outline；「未保存」为中性胶囊徽章（非彩色文字）；
 * - body：顶部分隔线两端内缩 16px（margin 0 16px）；
 * - 字段：纵向堆叠（标签在上、控件居中、提示在下，字段间分隔线），
 *   输入框 34px 高、8px 圆角、border-l2、bg-layer-3、focus 边框品牌色；
 * - footer：顶部分隔线、按钮靠右；保存按钮为官方单色样式
 *   （label-primary 底 + bg-layer-3 字，非蓝色）；数字字段带非法校验
 *   （label-error 提示，与官方 ValueField 行为一致）。
 * 样式经 <style> 注入（sgc- 前缀类名），与官方 CSS 注入方式相同。
 *
 * 文案双语：字段 label/hint 直接存 { zh, en } 双值，chrome 微文案由
 * zh 源字典 + en 映射类型约束键集一致；语言经 useGhostT 跟随宿主 DSH
 * 界面语言（locale 服务），切换无刷新重渲染，服务缺失回退中文。
 * @module dsh-suggest-ghost/client/settings-card
 */

import { useEffect, useState, type ReactElement } from 'react';
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime';
import { keyEventToSpec } from './keyspec.ts';
import { useGhostT, type GhostLang, type LocaleFaceLike } from './useGhostT.ts';

/** 字段输入形态。 */
export type FieldKind = 'number' | 'text' | 'boolean' | 'key';

/** 双语文案值（zh 为源语言）。 */
export interface Bilingual {
  readonly zh: string;
  readonly en: string;
}

/** 配置字段定义（key / 显示名 / 提示 / 输入形态 / 所属分组）。
 * label/hint 为 { zh, en } 双值，按 useGhostT 解析出的语言取用。 */
export const GHOST_FIELDS: ReadonlyArray<{
  readonly key: string;
  readonly label: Bilingual;
  readonly hint: Bilingual;
  readonly kind: FieldKind;
  readonly section: 'llm' | 'history';
}> = [
  // —— LLM 下一条建议 ——
  {
    key: 'maxOutputTokens',
    label: { zh: '输出令牌上限', en: 'Output token cap' },
    hint: {
      zh: '建议生成的最大输出 token（推理模型留足预算，如 512）',
      en: 'Max output tokens per suggestion (leave headroom for reasoning models, e.g. 512)',
    },
    kind: 'number',
    section: 'llm',
  },
  {
    key: 'maxSuggestionChars',
    label: { zh: '建议字符上限', en: 'Suggestion character cap' },
    hint: { zh: '幽灵文本可见字符数上限', en: 'Max visible characters of the ghost text' },
    kind: 'number',
    section: 'llm',
  },
  {
    key: 'maxRecentTurns',
    label: { zh: '参考回合数', en: 'Recent turns referenced' },
    hint: {
      zh: '转录尾部保留的最近完成回合数（1 = 只取最后一轮）',
      en: 'Completed turns kept from the transcript tail (1 = last turn only)',
    },
    kind: 'number',
    section: 'llm',
  },
  {
    key: 'maxTranscriptChars',
    label: { zh: '转录字符预算', en: 'Transcript character budget' },
    hint: {
      zh: '发送给建议模型的转录字符上限',
      en: 'Max transcript characters sent to the suggestion model',
    },
    kind: 'number',
    section: 'llm',
  },
  {
    key: 'timeoutMs',
    label: { zh: '超时（毫秒）', en: 'Timeout (ms)' },
    hint: {
      zh: '辅助 LLM 请求端到端截止时间',
      en: 'End-to-end deadline for the auxiliary LLM request',
    },
    kind: 'number',
    section: 'llm',
  },
  {
    key: 'acceptKey',
    label: { zh: '采纳快捷键', en: 'Accept shortcut' },
    hint: {
      zh: '点击后按下组合键；支持 Tab、字母/数字、F1-F12、方向键等（两个功能共用）',
      en: 'Click, then press a key combo; supports Tab, letters/digits, F1-F12, arrows, etc. (shared by both features)',
    },
    kind: 'key',
    section: 'llm',
  },
  {
    key: 'llmEnabled',
    label: { zh: '启用 LLM 建议', en: 'Enable LLM suggestions' },
    hint: {
      zh: '关闭后每回合不再调用建议模型（省 token）；历史前缀补全与热度不受影响',
      en: 'When off, no suggestion model call per turn (saves tokens); history completion and hotness are unaffected',
    },
    kind: 'boolean',
    section: 'llm',
  },
  {
    key: 'provider',
    label: { zh: 'Provider', en: 'Provider' },
    hint: {
      zh: '显式路由；留空继承主请求路由',
      en: 'Explicit routing; leave empty to inherit the main request route',
    },
    kind: 'text',
    section: 'llm',
  },
  {
    key: 'model',
    label: { zh: 'Model', en: 'Model' },
    hint: {
      zh: '显式路由；留空继承主请求路由',
      en: 'Explicit routing; leave empty to inherit the main request route',
    },
    kind: 'text',
    section: 'llm',
  },
  // —— 历史前缀补全 ——
  {
    key: 'historyEnabled',
    label: { zh: '启用历史补全', en: 'Enable history completion' },
    hint: {
      zh: '草稿非空时按历史消息前缀补全（打分制：最近优先 + 频次/热度加权）',
      en: 'Completes the draft from history-message prefixes while typing (scored: recency first, weighted by frequency/heat)',
    },
    kind: 'boolean',
    section: 'history',
  },
  {
    key: 'historyCrossSession',
    label: { zh: '跨会话搜索', en: 'Cross-session search' },
    hint: {
      zh: '关=候选仅当前会话；开=并入其他会话的高频历史。热度频次打分不受此开关影响',
      en: 'Off = candidates from this session only; on = merge frequent history from other sessions. Hotness frequency scoring is unaffected by this switch',
    },
    kind: 'boolean',
    section: 'history',
  },
  {
    key: 'historyMaxEntries',
    label: { zh: '最大历史条目', en: 'Max history entries' },
    hint: {
      zh: '最多参考的历史条目数（0 = 不限）',
      en: 'How many history entries to consider at most (0 = unlimited)',
    },
    kind: 'number',
    section: 'history',
  },
  {
    key: 'historyMinChars',
    label: { zh: '最少输入字符', en: 'Minimum typed characters' },
    hint: {
      zh: '草稿输入多少字符后才触发补全（避免过早弹框）',
      en: 'How many characters must be typed before completion kicks in (avoids popping up too early)',
    },
    kind: 'number',
    section: 'history',
  },
  {
    key: 'wordAccept',
    label: { zh: '逐词采纳', en: 'Word-by-word accept' },
    hint: {
      zh: '幽灵显示时按 → 每次采纳一个词（中文按词典分词）；Tab 始终整条采纳。对两种建议模式都生效',
      en: 'While the ghost shows, → accepts one word at a time (Chinese segments via dictionary); Tab always accepts the whole text. Applies to both suggestion modes',
    },
    kind: 'boolean',
    section: 'history',
  },
];

/** 卡片 chrome 微文案源字典（zh）：键集为唯一事实来源。 */
const zhStrings = {
  /** header 描述 */
  description: '输入预测：历史前缀补全 + LLM 下一条建议（草稿为空时）。改动保存后立即生效。',
  /** 未保存徽章 */
  unsaved: '未保存',
  /** 只读提示 */
  readOnly: '当前部署不可写（内存模式）',
  /** 分组标题 */
  sectionLlm: 'LLM 下一条建议',
  sectionHistory: '历史前缀补全',
  /** footer 状态与按钮 */
  saved: '已保存',
  discard: '放弃修改',
  saving: '保存中…',
  save: '保存',
  /** 数字字段校验错误 */
  invalidNumber: '请输入数字',
  /** 布尔字段选项 */
  optionOn: '开启',
  optionOff: '关闭',
  /** 快捷键控件 */
  keyCapturing: '按下组合键…（Esc 取消）',
  keyEmpty: '点击设置快捷键',
} as const;

/** en 字典：映射类型约束与 zh 键集完全一致（缺键/多键均为编译期错误）。 */
const enStrings: { [K in keyof typeof zhStrings]: string } = {
  description:
    'Input prediction: history prefix completion + LLM next suggestion (while the draft is empty). Changes take effect right after saving.',
  unsaved: 'Unsaved',
  readOnly: 'Not writable in this deployment (in-memory mode)',
  sectionLlm: 'LLM next suggestion',
  sectionHistory: 'History prefix completion',
  saved: 'Saved',
  discard: 'Discard changes',
  saving: 'Saving…',
  save: 'Save',
  invalidNumber: 'Enter a number',
  optionOn: 'On',
  optionOff: 'Off',
  keyCapturing: 'Press a key combo… (Esc to cancel)',
  keyEmpty: 'Click to set a shortcut',
};

/** 单语言 chrome 文案字典类型（zh/en 通用）。 */
export type GhostStrings = { [K in keyof typeof zhStrings]: string };

/** 全部语言字典（键集一致，由 enStrings 的映射类型保证）。 */
const GHOST_STRINGS: Record<GhostLang, GhostStrings> = { zh: zhStrings, en: enStrings };

/** 卡片样式（对齐官方 PluginCard 的 token 与规格；sgc- 前缀防冲突）。 */
const CARD_CSS = [
  '.sgc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
  '.sgc-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
  '.sgc-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
  '.sgc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}',
  '.sgc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.sgc-headText{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}',
  '.sgc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
  '.sgc-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
  '.sgc-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;flex:none}',
  '.sgc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
  '.sgc-chevronOpen{transform:rotate(180deg)}',
  '.sgc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
  '.sgc-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
  '.sgc-section{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;line-height:1.5;margin:14px 0 0}',
  '.sgc-section+.sgc-field{border-top:0}',
  '.sgc-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
  '.sgc-field+.sgc-field{border-top:1px solid var(--dsw-alias-border-l2)}',
  '.sgc-fieldHead{display:flex;align-items:center;gap:8px}',
  '.sgc-label{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}',
  '.sgc-input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
  '.sgc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
  '.sgc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  '.sgc-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}',
  '.sgc-key{box-sizing:border-box;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
  '.sgc-key:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
  '.sgc-key:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  '.sgc-keyCapturing,.sgc-keyCapturing:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
  '.sgc-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}',
  '.sgc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
  '.sgc-footer{border-top:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px}',
  '.sgc-status{flex:1;min-width:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5}',
  '.sgc-save,.sgc-discard{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
  '.sgc-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
  '.sgc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}',
  '.sgc-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
  '.sgc-save:disabled,.sgc-discard:disabled{opacity:.4;cursor:default}',
  '.sgc-save:focus-visible,.sgc-discard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
].join('');

/** 样式注入标记（幂等：重复加载不重复插入）。 */
const STYLE_ID = 'dsh-suggest-ghost-card-css';
if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.dataset.pluginCss = 'dsh-suggest-ghost/settings-card';
  tag.textContent = CARD_CSS;
  document.head.appendChild(tag);
}

/** 卡片组件 props：由槽位注册的 inject 提供。 */
export interface SuggestGhostCardProps {
  scope: SettingsScope<Record<string, unknown>>;
  /** 宿主 locale 服务 face（可选增强；缺失或旧宿主回退中文）。 */
  locale?: LocaleFaceLike;
}

/** 会话状态快照的值类型。 */
type Value = Record<string, unknown>;
/** 未改动项的原始值 -> 显示用字符串。 */
function displayValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === undefined || v === null ? '' : String(v);
}

/** 与官方 PluginCard 视觉一致的 chevron-down 图标（内联 SVG，零依赖）。 */
function ChevronDown({ className }: { className?: string }): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 快捷键捕获控件：点击进入录制态，按下组合键即写入规范 spec（Esc 取消）。
 * 录制经 keyspec.keyEventToSpec，产出与幽灵匹配端（parseAcceptKey）同一张表。 */
function KeyField({ id, value, disabled, t, onChange }: {
  id: string;
  value: string;
  disabled: boolean;
  t: GhostStrings;
  onChange: (spec: string) => void;
}): ReactElement {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const spec = keyEventToSpec(event); // 纯修饰键返回 undefined，继续等待主键
      if (spec !== undefined) {
        onChange(spec);
        setCapturing(false);
      }
    };
    const cancel = (): void => setCapturing(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', cancel);
    };
  }, [capturing, onChange]);
  return (
    <button
      type="button"
      id={id}
      className={capturing ? 'sgc-key sgc-keyCapturing' : 'sgc-key'}
      disabled={disabled}
      onClick={() => setCapturing(c => !c)}
    >
      {capturing ? t.keyCapturing : value === '' ? t.keyEmpty : value}
    </button>
  );
}

/** 设置卡片：读取/编辑/保存 suggest-ghost 命名空间（默认收起，点击头部展开）。
 * 文案跟随宿主界面语言（locale 缺失回退中文），语言切换实时重渲染。 */
export function SuggestGhostCard({ scope, locale }: SuggestGhostCardProps): ReactElement | null {
  const lang = useGhostT(locale);
  const t = GHOST_STRINGS[lang];
  const [snap, setSnap] = useState(scope.getSnapshot());
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [edits, setEdits] = useState<Record<string, string | boolean | number>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // 折叠状态（卡片本地）：默认收起；折叠不丢失 staged edits。
  const [open, setOpen] = useState(false);

  if (snap.status === 'unavailable') return null; // 命名空间未暴露时不显示卡片
  const value = (snap.value ?? {}) as Value;
  const writable = snap.writable && snap.status === 'ready';
  const isDirty = Object.keys(edits).length > 0;

  const fieldValue = (key: string): string => {
    if (key in edits) return String(edits[key]);
    return displayValue(value[key]);
  };
  /** 数字字段的暂存值是否非法（空或非数字）；与官方 ValueField 校验一致。 */
  const fieldInvalid = (f: (typeof GHOST_FIELDS)[number]): boolean => {
    if (f.kind !== 'number' || !(f.key in edits)) return false;
    const raw = String(edits[f.key]).trim();
    return raw === '' || Number.isNaN(Number(raw));
  };
  const anyInvalid = GHOST_FIELDS.some(fieldInvalid);
  const setField = (key: string, raw: string | boolean | number): void => {
    setEdits(prev => ({ ...prev, [key]: raw }));
  };
  const save = async (): Promise<void> => {
    if (anyInvalid) return;
    setBusy(true);
    try {
      for (const [key, raw] of Object.entries(edits)) {
        const def = GHOST_FIELDS.find(f => f.key === key)!;
        let final: string | number | boolean = raw;
        if (def.kind === 'number') final = Number(raw);
        else if (def.kind === 'boolean') final = raw === true || raw === 'true';
        else if (def.kind === 'key') {
          const trimmed = String(raw).trim();
          if (trimmed === '') continue; // host 端 zod 要求非空，空 spec 直接丢弃
          final = trimmed;
        }
        await scope.set(key, final);
      }
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };
  const discard = (): void => setEdits({});

  const renderField = (f: (typeof GHOST_FIELDS)[number]): ReactElement => {
    const invalid = fieldInvalid(f);
    const inputClass = invalid ? 'sgc-input sgc-inputInvalid' : 'sgc-input';
    const control = f.kind === 'boolean' ? (
      <select
        className={inputClass}
        id={`sgc-field-${f.key}`}
        value={fieldValue(f.key) === 'true' ? 'true' : 'false'}
        disabled={!writable || busy}
        onChange={e => setField(f.key, e.target.value === 'true')}
      >
        <option value="true">{t.optionOn}</option>
        <option value="false">{t.optionOff}</option>
      </select>
    ) : f.kind === 'key' ? (
      <KeyField
        id={`sgc-field-${f.key}`}
        value={fieldValue(f.key)}
        disabled={!writable || busy}
        t={t}
        onChange={spec => setField(f.key, spec)}
      />
    ) : (
      <input
        className={inputClass}
        id={`sgc-field-${f.key}`}
        type="text"
        {...(f.kind === 'number' ? { inputMode: 'numeric' as const } : {})}
        {...(invalid ? { 'aria-invalid': true } : {})}
        value={fieldValue(f.key)}
        disabled={!writable || busy}
        onChange={e => setField(f.key, e.target.value)}
      />
    );
    return (
      <div key={f.key} className="sgc-field">
        <div className="sgc-fieldHead">
          <label className="sgc-label" htmlFor={`sgc-field-${f.key}`}>{f.label[lang]}</label>
        </div>
        {control}
        <p className={invalid ? 'sgc-invalid' : 'sgc-hint'}>{invalid ? t.invalidNumber : f.hint[lang]}</p>
      </div>
    );
  };

  const llmFields = GHOST_FIELDS.filter(f => f.section === 'llm');
  const historyFields = GHOST_FIELDS.filter(f => f.section === 'history');

  return (
    <li className={open ? 'sgc-card sgc-cardOpen' : 'sgc-card'}>
      <button
        type="button"
        className="sgc-header"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="sgc-headText">
          <span className="sgc-name">Suggest ghost</span>
          <span className="sgc-description">{t.description}</span>
        </span>
        {isDirty && <span className="sgc-pending">{t.unsaved}</span>}
        <ChevronDown className={open ? 'sgc-chevron sgc-chevronOpen' : 'sgc-chevron'} />
      </button>
      {open && (
        <div className="sgc-body">
          {!writable && <p className="sgc-readOnly">{t.readOnly}</p>}
          <div className="sgc-section">{t.sectionLlm}</div>
          {llmFields.map(renderField)}
          <div className="sgc-section">{t.sectionHistory}</div>
          {historyFields.map(renderField)}
          <div className="sgc-footer">
            {saved && <span className="sgc-status" role="status">{t.saved}</span>}
            <button className="sgc-discard" disabled={!isDirty || busy} onClick={discard}>{t.discard}</button>
            <button className="sgc-save" disabled={!writable || busy || !isDirty || anyInvalid} onClick={() => void save()}>
              {busy ? t.saving : t.save}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
