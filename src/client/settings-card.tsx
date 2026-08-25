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
 * @module dsh-suggest-ghost/client/settings-card
 */

import { useEffect, useState } from 'react';
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime';
import { keyEventToSpec } from './keyspec.ts';

/** 字段输入形态。 */
export type FieldKind = 'number' | 'text' | 'boolean' | 'key';

/** 配置字段定义（key / 显示名 / 提示 / 输入形态 / 所属分组）。 */
export const GHOST_FIELDS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly kind: FieldKind;
  readonly section: 'llm' | 'history';
}> = [
  // —— LLM 下一条建议 ——
  { key: 'maxOutputTokens', label: '输出令牌上限', hint: '建议生成的最大输出 token（推理模型留足预算，如 512）', kind: 'number', section: 'llm' },
  { key: 'maxSuggestionChars', label: '建议字符上限', hint: '幽灵文本可见字符数上限', kind: 'number', section: 'llm' },
  { key: 'maxRecentTurns', label: '参考回合数', hint: '转录尾部保留的最近完成回合数（1 = 只取最后一轮）', kind: 'number', section: 'llm' },
  { key: 'maxTranscriptChars', label: '转录字符预算', hint: '发送给建议模型的转录字符上限', kind: 'number', section: 'llm' },
  { key: 'timeoutMs', label: '超时（毫秒）', hint: '辅助 LLM 请求端到端截止时间', kind: 'number', section: 'llm' },
  { key: 'acceptKey', label: '采纳快捷键', hint: '点击后按下组合键；支持 Tab、字母/数字、F1-F12、方向键等（两个功能共用）', kind: 'key', section: 'llm' },
  { key: 'llmEnabled', label: '启用 LLM 建议', hint: '关闭后每回合不再调用建议模型（省 token）；历史前缀补全与热度不受影响', kind: 'boolean', section: 'llm' },
  { key: 'provider', label: 'Provider', hint: '显式路由；留空继承主请求路由', kind: 'text', section: 'llm' },
  { key: 'model', label: 'Model', hint: '显式路由；留空继承主请求路由', kind: 'text', section: 'llm' },
  // —— 历史前缀补全 ——
  { key: 'historyEnabled', label: '启用历史补全', hint: '草稿非空时按历史消息前缀补全（打分制：最近优先 + 频次/热度加权）', kind: 'boolean', section: 'history' },
  { key: 'historyCrossSession', label: '跨会话搜索', hint: '关=候选仅当前会话；开=并入其他会话的高频历史。热度频次打分不受此开关影响', kind: 'boolean', section: 'history' },
  { key: 'historyMaxEntries', label: '最大历史条目', hint: '最多参考的历史条目数（0 = 不限）', kind: 'number', section: 'history' },
  { key: 'historyMinChars', label: '最少输入字符', hint: '草稿输入多少字符后才触发补全（避免过早弹框）', kind: 'number', section: 'history' },
  { key: 'wordAccept', label: '逐词采纳', hint: '幽灵显示时按 → 每次采纳一个词（中文按词典分词）；Tab 始终整条采纳。对两种建议模式都生效', kind: 'boolean', section: 'history' },
];

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
}

/** 会话状态快照的值类型。 */
type Value = Record<string, unknown>;
/** 未改动项的原始值 -> 显示用字符串。 */
function displayValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === undefined || v === null ? '' : String(v);
}

/** 与官方 PluginCard 视觉一致的 chevron-down 图标（内联 SVG，零依赖）。 */
function ChevronDown({ className }: { className?: string }): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 快捷键捕获控件：点击进入录制态，按下组合键即写入规范 spec（Esc 取消）。
 * 录制经 keyspec.keyEventToSpec，产出与幽灵匹配端（parseAcceptKey）同一张表。 */
function KeyField({ id, value, disabled, onChange }: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (spec: string) => void;
}): React.ReactElement {
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
      {capturing ? '按下组合键…（Esc 取消）' : value === '' ? '点击设置快捷键' : value}
    </button>
  );
}

/** 设置卡片：读取/编辑/保存 suggest-ghost 命名空间（默认收起，点击头部展开）。 */
export function SuggestGhostCard({ scope }: SuggestGhostCardProps): React.ReactElement | null {
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

  const renderField = (f: (typeof GHOST_FIELDS)[number]): React.ReactElement => {
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
        <option value="true">开启</option>
        <option value="false">关闭</option>
      </select>
    ) : f.kind === 'key' ? (
      <KeyField
        id={`sgc-field-${f.key}`}
        value={fieldValue(f.key)}
        disabled={!writable || busy}
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
          <label className="sgc-label" htmlFor={`sgc-field-${f.key}`}>{f.label}</label>
        </div>
        {control}
        <p className={invalid ? 'sgc-invalid' : 'sgc-hint'}>{invalid ? '请输入数字' : f.hint}</p>
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
          <span className="sgc-description">
            输入预测：历史前缀补全 + LLM 下一条建议（草稿为空时）。改动保存后立即生效。
          </span>
        </span>
        {isDirty && <span className="sgc-pending">未保存</span>}
        <ChevronDown className={open ? 'sgc-chevron sgc-chevronOpen' : 'sgc-chevron'} />
      </button>
      {open && (
        <div className="sgc-body">
          {!writable && <p className="sgc-readOnly">当前部署不可写（内存模式）</p>}
          <div className="sgc-section">LLM 下一条建议</div>
          {llmFields.map(renderField)}
          <div className="sgc-section">历史前缀补全</div>
          {historyFields.map(renderField)}
          <div className="sgc-footer">
            {saved && <span className="sgc-status" role="status">已保存</span>}
            <button className="sgc-discard" disabled={!isDirty || busy} onClick={discard}>放弃修改</button>
            <button className="sgc-save" disabled={!writable || busy || !isDirty || anyInvalid} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
