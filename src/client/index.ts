/**
 * dsh-suggest-ghost client 端：双模式幽灵输入——
 * 1. 历史补全（草稿非空）：从当前会话历史找前缀匹配，幽灵显示剩余部分，Tab 采纳；
 * 2. LLM 预测（草稿为空）：读取 `suggestGhost` 会话投影，幽灵显示下一条建议，Tab 采纳。
 * 纯 DOM overlay 渲染（不依赖官方 setGhost 能力），零核心改动。
 *
 * 编译说明：本文件以单文件 CommonJS 打包进 __ModuleLoader__.load，
 * 运行时零依赖（所有 @deepseek-ai 引用均为 type-only）。
 *
 * rc.7 兼容性说明：DSH rc.7 的 client runner 把插件 apply 包进
 * `dynamicCordisContext` 严格门控 Proxy——`ctx` 只暴露 `ctx.on / ctx.provide /
 * ctx.effect` 等 verbs 与 `inject` 数组声明的服务，**不再提供 `ctx.inject(...)`
 * 延迟注入方法**（rc.6 遗留写法；rc.7 下访问未声明的 `ctx.inject` 会触发
 * rejectGuard 抛错、导致整个 client 插件加载失败）。本文件已改为 rc.7 写法：
 * 所需服务通过模块级 `inject` 数组声明（fiber 激活门控），apply 内直接用
 * `ctx.get(name)` 读取；设置卡片依赖的 `slots` / `settingsScope` 为可选服务，
 * 用 `ctx.get()` 可选读取，缺失时不注册卡片、不阻塞幽灵逻辑。
 * @module dsh-suggest-ghost/client
 */

import type {} from '@deepseek-ai/dsh-client-runtime';
import type {} from '@deepseek-ai/dsh-client-ui-conversation';
import type { Context } from '@deepseek-ai/cordis';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime';
import type { SuggestGhostProjection, SuggestGhostSuggested } from '../domain.ts';
import { commonPrefixLength, extractHistory, historySuggestion, normalizeForMatch, stripCommandPrefix } from './history.ts';
import { nextAcceptChunk } from './chunk.ts';
import { keyCodeOf } from './keyspec.ts';
import { SuggestGhostCard } from './settings-card.tsx';
import type { LocaleFaceLike } from './useGhostT.ts';

/** 投影键（与 host 端 PROJECTION_KEY 一致）。 */
const PROJECTION_KEY = 'suggestGhost';
/** 幽灵文本的 DOM 标记，用于定位/清理。 */
const OVERLAY_ID = 'dsh-suggest-ghost-overlay';
/** 默认采纳快捷键（与 host 默认一致）。 */
const DEFAULT_ACCEPT_KEY = 'Tab';
/** settings 命名空间（与 host 端一致）。 */
const SETTINGS_NAMESPACE = 'suggest-ghost';

/** 插件名（与 manifest id 一致）。 */
const name = 'dsh-suggest-ghost';
/** 所需服务：会话 face + 输入机 face（幽灵必需，rc.7 fiber 激活门控）。
 * settingsScope / slots / locale 为可选服务，在 apply 内用 ctx.get 可选读取，
 * 不在此声明——cordis 的 fiber 门控会在声明的服务缺失时把整个插件 park，
 * 以免其缺失时连带 park 幽灵逻辑（locale 缺失只应让卡片回退中文）。 */
const inject = ['conversation', 'sessions'];

/** 事件目标是否为会话输入框 textarea（唯一位于 data-input-scroll 内的 textarea）。 */
function isComposerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLTextAreaElement)) return false;
  return target.closest('[data-input-scroll]') !== null;
}

/** 会话快照中最新已完成回合号。 */
function lastCompletedTurn(turnEnds: ReadonlyMap<number, number>): number | undefined {
  let last: number | undefined;
  for (const turn of turnEnds.keys()) last = turn;
  return last;
}

/** 快捷键匹配：修饰键 + 主键（主键表见 keyspec.ts），如 Tab、Alt+S、Ctrl+Enter。
 * 修复：字母/数字主键此前按 event.code === 'S' 匹配，实际 code 是 'KeyS'，
 * 导致单字符 spec 永远无法命中；现统一经 keyCodeOf 映射。 */
function parseAcceptKey(spec: string): ((event: KeyboardEvent) => boolean) | undefined {
  const parts = spec.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const mods = new Set(parts.slice(0, -1));
  const keyCode = keyCodeOf(spec);
  if (keyCode === undefined) return undefined;
  return (event) => event.code === keyCode
    && event.altKey === mods.has('alt')
    && event.ctrlKey === mods.has('ctrl')
    && event.metaKey === mods.has('meta')
    && event.shiftKey === mods.has('shift');
}

/** 当前应显示的幽灵内容：LLM 建议（完整文本）或历史补全（已输入前缀 + 剩余后缀）。 */
type GhostContent =
  | { kind: 'llm'; text: string; acceptKey: string }
  | { kind: 'history'; prefix: string; suffix: string; full: string };

/** 幽灵文本 overlay 管理器：在 textarea 上创建/更新/移除灰色覆盖层。 */
class GhostOverlay {
  private readonly el: HTMLDivElement;
  private textarea: HTMLTextAreaElement | null = null;
  private readonly onScroll: () => void;
  private readonly styleTag: HTMLStyleElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = OVERLAY_ID;
    this.el.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'white-space:pre-wrap',
      'word-break:break-word',
      // 不设 overflow:hidden：它会贴着盒子边界裁掉 text-shadow 光晕（明显切割感）；
      // 换行安全已由 pre-wrap + break-word 保证，盒子高度自适应无需纵向裁剪。
      // 对齐官方 composer placeholder 的色阶（label-caption，全透明度），
      // 而非更重的 label-secondary：保证「幽灵」比正文明显更淡。
      'color:var(--dsw-alias-label-caption, #9aa0a6)',
      // 轻微同色泛光（贴身 1px + 8px 柔光晕）：与原生 placeholder 区分，
      // 提示这是「可采纳的建议」而非占位文案；同色晕不改变色相、暗/亮主题通用。
      'text-shadow:0 0 1px var(--dsw-alias-label-caption, #9aa0a6), 0 0 8px var(--dsw-alias-label-caption, #9aa0a6)',
      'z-index:1',
      'visibility:hidden',
    ].join(';');
    this.onScroll = () => this.align();
    // 幽灵激活时隐藏 textarea 原生 placeholder（二者同位置，避免重叠）。
    // 用 class + CSS 而非改写 placeholder 属性：不干扰 React 对输入框的
    // 受控渲染，重渲染后样式依然生效。
    this.styleTag = document.createElement('style');
    this.styleTag.dataset.pluginCss = 'dsh-suggest-ghost';
    this.styleTag.textContent = '.dsh-suggest-ghost-active::placeholder{opacity:0}';
    if (typeof document !== 'undefined') document.head.appendChild(this.styleTag);
  }

  /** 绑定到当前 textarea（若变化则重建对齐）。 */
  private attach(textarea: HTMLTextAreaElement): void {
    if (this.textarea === textarea) return;
    this.detach();
    this.textarea = textarea;
    const parent = textarea.parentElement;
    if (parent !== null && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    textarea.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll);
    if (parent !== null) parent.appendChild(this.el);
    this.align();
  }

  private detach(): void {
    if (this.textarea !== null) {
      this.textarea.removeEventListener('scroll', this.onScroll);
      this.textarea.classList.remove('dsh-suggest-ghost-active');
      this.textarea = null;
    }
    window.removeEventListener('resize', this.onScroll);
    this.el.remove();
  }

  /** 对齐 overlay 到 textarea 内容区（含 padding 起点、跟随滚动）。 */
  private align(): void {
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
    // 继承输入区字体与行高，保证幽灵文本视觉一致。
    this.el.style.fontFamily = style.fontFamily;
    this.el.style.fontSize = style.fontSize;
    this.el.style.lineHeight = style.lineHeight;
    this.el.style.fontWeight = style.fontWeight;
    this.el.style.letterSpacing = style.letterSpacing;
    this.el.style.boxSizing = 'border-box';
  }

  /** 显示幽灵内容（对齐由滚动/尺寸事件持续维护）；隐藏 placeholder 避免重叠。 */
  show(content: GhostContent): void {
    this.el.textContent = '';
    if (content.kind === 'llm') {
      this.el.textContent = content.text;
    } else {
      // 历史补全：已输入前缀用透明占位（宽度自然对齐），剩余部分灰色显示。
      const prefix = document.createElement('span');
      prefix.style.visibility = 'hidden';
      prefix.textContent = content.prefix;
      const suffix = document.createElement('span');
      suffix.textContent = content.suffix;
      this.el.append(prefix, suffix);
    }
    this.el.style.visibility = 'visible';
    this.textarea?.classList.add('dsh-suggest-ghost-active');
    this.align();
  }

  hide(): void {
    this.el.style.visibility = 'hidden';
    this.el.textContent = '';
    this.textarea?.classList.remove('dsh-suggest-ghost-active');
  }

  dispose(): void {
    this.detach();
    this.styleTag.remove();
  }
}

/** 浏览器插件主体。 */
function apply(ctx: Context): void {
  // rc.7：所需核心服务已由 `inject` 声明，fiber 激活门控保证可用；ctx.get 可选读取。
  const sessions = ctx.get('sessions');
  if (sessions === undefined) return;
  const overlay = new GhostOverlay();
  let lastSessionId: string | undefined;
  let bound: {
    session: ObservableSnapshot<unknown>;
    input: { state: ObservableSnapshot<{ draft: string }>; setDraft: (text: string) => void };
    projectionFace: ObservableSnapshot<unknown>;
  } | null = null;
  let shown: { key: string; content: GhostContent } | null = null;

  /** live 设置值（来自 suggest-ghost 命名空间；缺失时用默认）。 */
  let settings: {
    historyEnabled: boolean;
    historyCrossSession: boolean;
    historyMaxEntries: number;
    historyMinChars: number;
    /** 幽灵显示时允许 → 逐词采纳（Tab 始终整条采纳）。 */
    wordAccept: boolean;
    /** host 实时推送：最新 LLM 建议（rev 递增识别新值）。 */
    suggestion: {
      turn: number;
      baseSeq: number;
      text: string;
      truncated: boolean;
      acceptKey: string;
    } | null;
    /** host 实时推送：跨会话热度快照。 */
    hot: readonly { text: string; count: number }[] | null;
  } = {
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    wordAccept: true,
    suggestion: null,
    hot: null,
  };

  /** 解析当前会话绑定（会话切换时重建）。 */
  const resolve = (): void => {
    const id = sessions.list.getSnapshot().current as string | undefined;
    if (id === undefined) {
      bound = null;
      lastSessionId = undefined;
      return;
    }
    if (id === lastSessionId && bound !== null) return;
    const actx = sessions.scope(id);
    if (actx === undefined) return;
    const session = sessions.sessionOf(actx);
    if (session === undefined) return;
    const conversation = actx.get('conversation');
    if (conversation === undefined) return;
    const input = conversation.input.for(actx);
    if (input === undefined) return;
    lastSessionId = id;
    bound = {
      session: session as unknown as ObservableSnapshot<unknown>,
      input: input as unknown as { state: ObservableSnapshot<{ draft: string }>; setDraft: (text: string) => void },
      projectionFace: session.projections.faceOf(PROJECTION_KEY),
    };
  };

  /** 计算当前应显示的幽灵内容（null = 不显示）。 */
  const ghostContent = (): GhostContent | null => {
    if (bound === null) return null;
    const snapshot = bound.session.getSnapshot() as {
      running: boolean;
      turnEnds: ReadonlyMap<number, number>;
      nodes: readonly unknown[];
      chat?: { nodes?: { values?: () => readonly unknown[] } };
    };
    const draft = bound.input.state.getSnapshot().draft;

    // 模式 1：草稿非空 → 历史前缀补全（打分制：新近度为主、频次/热度为辅）。
    if (settings.historyEnabled && draft.trim() !== '') {
      // 草稿是斜杠命令整行时（如 `/later +3m 我重新部署了…`），用命令名之后
      // 的「内容」部分去匹配历史。`/later` `recordInput:false`，历史里只有
      // 到点注入的内容部分；保留时间参数只会让所有候选 startsWith 失败。
      // 非命令整行（普通用户消息）时 stripCommandPrefix 原样返回 draft。
      const contentDraft = stripCommandPrefix(draft);
      if (contentDraft.trim() === '') return null;
      // 数据源：当前会话优先 chat.nodes（新装配视图），回退 legacy nodes（兼容）。
      const chatValues = (snapshot as { chat?: { nodes?: { values?: () => readonly unknown[] } } }).chat?.nodes?.values?.() ?? [];
      const history = extractHistory(chatValues.length > 0 ? chatValues : snapshot.nodes);
      // C：全局热度频次始终参与打分（host 无条件推送）；「跨会话搜索」开关
      // 只决定是否把其他会话的高频文本并入候选列表。
      const hot = settings.hot;
      const hotCounts = hot !== null && hot.length > 0
        ? new Map(hot.map(h => [normalizeForMatch(h.text), h.count] as const))
        : undefined;
      const full = historySuggestion(history, contentDraft, {
        minChars: settings.historyMinChars,
        maxEntries: settings.historyMaxEntries,
        hotCounts,
        extraCandidates: settings.historyCrossSession ? hot ?? undefined : undefined,
      });
      if (full === undefined) return null;
      // 渲染按「原始草稿 + 候选」公共前缀对齐（宽度/空白差异时仍正确）；
      // 对斜杠命令场景，prefix=draft 让幽灵对齐到已输入字符（含命令前缀），
      // suffix 从 contentDraft 与 full 的归一化匹配段截尾——见 historySuggestion。
      const common = commonPrefixLength(contentDraft, full);
      return { kind: 'history', prefix: draft, suffix: full.slice(common), full };
    }

    // 模式 2：草稿为空 → LLM 建议（host 实时推送），要求回合已结束且 agent 空闲。
    const suggestion = settings.suggestion;
    if (suggestion === null || suggestion === undefined) return null;
    const lastTurn = lastCompletedTurn(snapshot.turnEnds);
    const stale = snapshot.running
      || lastTurn === undefined
      || suggestion.turn !== lastTurn;
    if (stale) return null;
    return { kind: 'llm', text: suggestion.text, acceptKey: suggestion.acceptKey };
  };

  /** 渲染幽灵 overlay。 */
  const render = (): void => {
    resolve();
    const content = ghostContent();
    if (content === null) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      return;
    }
    // 内容指纹：LLM 用文本，历史用 prefix+suffix。
    const key = content.kind === 'llm'
      ? `llm:${content.text}`
      : `hist:${content.prefix}|${content.suffix}`;
    if (shown !== null && shown.key === key) return; // 无变化
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-input-scroll] textarea');
    if (textarea === null) return; // 输入框尚未挂载，等待下次通知
    overlay.attach(textarea);
    overlay.show(content);
    shown = { key, content };
  };

  // 读取/订阅设置命名空间（可选服务；缺失时保持默认并继续幽灵逻辑）。
  // 注意：必须放在 render 等函数定义之后，否则同步调用 applySettings 会触发
  // const 函数声明前的 TDZ（原 rc.6 版靠 ctx.inject 的异步延迟规避，rc.7 下
  // 需要显式保证顺序）。
  const settingsScope = ctx.get('settingsScope');
  if (settingsScope !== undefined) {
    const scope = settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
    const applySettings = (): void => {
      const snap = scope.getSnapshot();
      const v = snap.value ?? {};
      let pushed: { suggestion?: unknown; hot?: unknown } | null = null;
      if (typeof v._push === 'string' && v._push !== '') {
        try {
          pushed = JSON.parse(v._push) as { suggestion?: unknown; hot?: unknown };
        } catch {
          pushed = null;
        }
      }
      settings = {
        historyEnabled: typeof v.historyEnabled === 'boolean' ? v.historyEnabled : true,
        historyCrossSession: typeof v.historyCrossSession === 'boolean' ? v.historyCrossSession : false,
        historyMaxEntries: typeof v.historyMaxEntries === 'number' ? v.historyMaxEntries : 50,
        historyMinChars: typeof v.historyMinChars === 'number' ? v.historyMinChars : 1,
        wordAccept: typeof v.wordAccept === 'boolean' ? v.wordAccept : true,
        suggestion: pushed?.suggestion === null || pushed?.suggestion === undefined
          ? null
          : (pushed.suggestion as typeof settings.suggestion),
        hot: pushed?.hot === null || pushed?.hot === undefined
          ? null
          : (pushed.hot as typeof settings.hot),
      };
      render();
    };
    scope.subscribe?.(applySettings);
    applySettings();
  }

  /** Tab（或配置键）整条采纳；幽灵显示时裸 → 逐词采纳。 */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (shown === null) return;
    if (!(document.activeElement instanceof HTMLTextAreaElement)) return;
    if (!isComposerTarget(document.activeElement)) return;
    const content = shown.content;
    const acceptKey = content.kind === 'llm' ? content.acceptKey : DEFAULT_ACCEPT_KEY;
    const matcher = parseAcceptKey(acceptKey);
    if (matcher !== undefined && matcher(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (bound !== null) {
        // LLM 下一条建议：直接覆盖草稿（用户空草稿时按 Tab，本就无前缀）。
        // 历史补全：若草稿是斜杠命令整行（如 `/later +3m 我`），`full` 是历史
        // 里的「内容」部分（命令 `recordInput:false`，不含命令名+参数）。
        // 此时采纳必须把命令前缀一并回填，否则用户命令意图被破坏——只剩
        // 内容部分，需要重新键入 `/later +3m ` 才能执行。
        let accepted: string;
        if (content.kind === 'llm') {
          accepted = content.text;
        } else {
          const draftNow = bound.input.state.getSnapshot().draft;
          const contentDraft = stripCommandPrefix(draftNow);
          // 命令整行：contentDraft 是「内容部分」，它不包含命令名+参数。
          // 还原时把 draftNow 头部到 contentDraft 之前的那段（含命令名、
          // 时间参数、以及它们之间的空白）一并保留，再接 content.full。
          const head = contentDraft === ''
            ? draftNow
            : draftNow.slice(0, draftNow.length - contentDraft.length);
          const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
          accepted = `${head}${tailJoiner}${content.full}`;
        }
        bound.input.setDraft(accepted);
      }
      overlay.hide();
      shown = null;
      return;
    }
    // 逐词采纳：裸右方向键、光标位于草稿末尾时每次前进一个分词片段。
    // 其余情况一律不拦截（保留浏览器光标移动/焦点行为）；草稿与建议原文
    // 字面分歧（归一化等价但字符不同）时也不劫持，避免拼接出重复片段。
    // 历史补全下若草稿是斜杠命令整行（如 `/later +3m 我`），命令名+参数段
    // 不在候选 `full` 里，要用剥前缀后的 contentDraft 做前缀匹配；采纳后
    // 把命令前缀段（含时间参数）一并保留，避免命令意图被破坏。
    if (settings.wordAccept
      && event.code === 'ArrowRight'
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const ta = document.activeElement;
      const draftNow = bound !== null ? bound.input.state.getSnapshot().draft : '';
      const full = content.kind === 'llm' ? content.text : content.full;
      if (ta.selectionStart !== draftNow.length || ta.selectionEnd !== draftNow.length) return;
      const matchBase = content.kind === 'history'
        ? stripCommandPrefix(draftNow)
        : draftNow;
      if (!full.startsWith(matchBase) || matchBase.length >= full.length) return;
      const chunk = nextAcceptChunk(full.slice(matchBase.length));
      if (chunk === '') return;
      event.preventDefault();
      event.stopPropagation();
      let accepted: string;
      if (content.kind === 'history') {
        // 命令整行：draftNow 头部到 matchBase 之前是命令前缀段（含时间参数），
        // 需要随逐词采纳保留。
        const head = matchBase === ''
          ? draftNow
          : draftNow.slice(0, draftNow.length - matchBase.length);
        const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
        accepted = `${head}${tailJoiner}${matchBase}${chunk}`;
      } else {
        accepted = draftNow + chunk;
      }
      if (bound !== null) bound.input.setDraft(accepted);
      if (accepted === full || (content.kind === 'history'
        && accepted.endsWith(full))) {
        overlay.hide();
        shown = null;
      }
    }
  };

  ctx.effect(() => {
      // 订阅：会话列表（切换信号）、会话快照、输入草稿、投影值。
    let unsubs: Array<() => void> = [];
    const rebind = (): void => {
      for (const un of unsubs) un();
      unsubs = [];
      resolve();
      if (bound !== null) {
        unsubs.push(
          bound.session.subscribe(render),
          bound.input.state.subscribe(render),
          bound.projectionFace.subscribe(render),
        );
      }
    };
    rebind();
    render(); // 初始渲染：不依赖订阅触发（修复：会话打开即检查幽灵）
    const onList = (): void => {
      // 会话切换（current 变化）→ 重绑订阅；否则仅渲染。
      const id = sessions.list.getSnapshot().current as string | undefined;
      if (id !== lastSessionId) rebind();
      render();
    };
    const unList = sessions.list.subscribe(onList);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unList();
      for (const un of unsubs) un();
      window.removeEventListener('keydown', onKeyDown, true);
      overlay.dispose();
    };
  }, 'dsh-suggest-ghost: composer ghost render');

  // 设置卡片：独立读取 slots/settingsScope（可选服务，缺失时不阻塞幽灵逻辑）。
  // locale 同为可选增强（卡片文案跟随宿主界面语言）：经 ctx.get 无门控可选
  // 读取后随槽位 inject 下发；缺失/旧宿主组合由 useGhostT 回退中文。
  const slots = ctx.get('slots');
  const settingsScopeForCard = ctx.get('settingsScope');
  if (slots === undefined || settingsScopeForCard === undefined) return;
  const locale = ctx.get('locale') as LocaleFaceLike | undefined;
  slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    // keyed slot：必须给 key（宿主按命名空间 dispatch，entryKey=namespace）。
    key: SETTINGS_NAMESPACE,
    order: 30,
    inject: () => ({ scope: settingsScopeForCard.bind({ namespace: SETTINGS_NAMESPACE }), locale }),
  }, SuggestGhostCard));
}

export { apply, inject, name };
