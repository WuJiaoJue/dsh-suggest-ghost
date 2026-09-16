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

import type {} from '@deepseek-ai/dsh-client-ui-conversation';
import type { Context } from '@deepseek-ai/cordis';
import type { SuggestGhostProjection, SuggestGhostSuggested } from '../domain.ts';
import { commonPrefixLength, extractHistory, historySuggestion, normalizeForMatch, stripCommandPrefix } from './history.ts';
import { nextAcceptChunk } from './chunk.ts';
import { keyCodeOf } from './keyspec.ts';
import { SuggestGhostCard } from './settings-card.tsx';
import type { LocaleFaceLike } from './useGhostT.ts';

/**
 * 宿主可观察快照的最小结构视图。不从 @deepseek-ai/dsh-client-runtime 导入：
 * 该包是 0.1.1 内核特有，0.1.2 已把快照存储拆到 dsh-client-store，这里只用到
 * getSnapshot / subscribe 两个成员，本地声明即可切断这条跨代漂移的类型依赖。
 */
interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** 投影键（与 host 端 PROJECTION_KEY 一致）。 */
const PROJECTION_KEY = 'suggestGhost';
/** 幽灵文本的 DOM 标记，用于定位/清理。 */
const OVERLAY_ID = 'dsh-suggest-ghost-overlay';
/** 默认采纳快捷键（与 host 默认一致）。 */
const DEFAULT_ACCEPT_KEY = 'Tab';
/** settings 命名空间（与 host 端一致）。 */
const SETTINGS_NAMESPACE = 'suggest-ghost';
/** 未获应答的 pull 最多重试次数（host 可能回一份不含历史的载荷；上限防自旋）。 */
const PULL_MAX_ATTEMPTS = 5;
/** pull 重试的基础退避（毫秒），第 n 次退避 = 基础值 × 2^n。 */
const PULL_RETRY_BASE_MS = 200;


/** 插件名（与 manifest id 一致）。 */
const name = 'dsh-suggest-ghost';
/** 所需服务：会话 face + 输入机 face（幽灵必需，rc.7 fiber 激活门控）。
 * settingsScope / slots / locale 为可选服务，在 apply 内用 ctx.get 可选读取，
 * 不在此声明——cordis 的 fiber 门控会在声明的服务缺失时把整个插件 park，
 * 以免其缺失时连带 park 幽灵逻辑（locale 缺失只应让卡片回退中文）。 */
const inject = ['conversation', 'sessions'];

/** composer 的双代选择器：≤0.1.1 是 textarea，0.1.2 起是 Lexical contenteditable
 * （`data-composer-input` 标记，属 data-input-scroll 容器）。 */
const COMPOSER_SELECTOR = '[data-input-scroll] textarea, [data-input-scroll] [data-composer-input]';

/** 元素是否为会话输入框（textarea 或 composer contenteditable，均须位于 data-input-scroll 内）。 */
function isComposerElement(el: Element | null): boolean {
  if (el === null) return false;
  const composer = el.closest('[data-input-scroll]') !== null
    && (el.matches('textarea') || (el instanceof HTMLElement && el.isContentEditable));
  return composer;
}

/** 事件目标是否为会话输入框。 */
function isComposerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && isComposerElement(target);
}

/** 光标是否位于输入框文本末尾：textarea 用 selectionStart/End，contenteditable 用 Selection API。 */
function caretAtComposerEnd(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) {
    return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  }
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  if (el.textContent === '') return true; // 空编辑器：光标必然在末尾（LLM 模式场景）
  const range = selection.getRangeAt(0);
  // 编辑器最后一个文本节点末尾
  let last: Node | null = el.lastChild;
  while (last !== null && last.lastChild !== null) last = last.lastChild;
  if (range.endContainer === last) {
    return range.endOffset === (last.textContent?.length ?? 0);
  }
  // 或光标落在编辑器最后一个子节点之后（Lexical 常见形态）
  return range.endContainer === el && range.endOffset === el.childNodes.length;
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

/** 幽灵文本 overlay 管理器：在输入框（textarea / Lexical contenteditable）上
 * 创建/更新/移除灰色覆盖层。 */
class GhostOverlay {
  private readonly el: HTMLDivElement;
  private composer: HTMLElement | null = null;
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
    // 幽灵激活时隐藏原生 placeholder（二者同位置，避免重叠）。
    // 幽灵显示期间隐藏占位文案（二者同位置，避免重叠）。关键：状态标记打在
    // **我们自己的 overlay 节点**上（data-shown），经 body:has() 关联占位元素
    // ——React/Lexical 重渲染会剥掉编辑器上的外来类（实测发生过），而 overlay
    // 是插件私有节点不受影响，且与 DOM 顺序、textarea/contenteditable 形态
    // 无关。规则覆盖两代 composer：
    //  - textarea：原生 ::placeholder 伪元素；
    //  - contenteditable（0.1.2 Lexical）：placeholder 兄弟节点带
    //    `data-composer-placeholder` 稳定属性钩子。
    this.styleTag = document.createElement('style');
    this.styleTag.dataset.pluginCss = 'dsh-suggest-ghost';
    this.styleTag.textContent = [
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]) [data-composer-placeholder]{opacity:0}',
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]) textarea::placeholder{opacity:0}',
    ].join('\n');
    if (typeof document !== 'undefined') document.head.appendChild(this.styleTag);
  }

  /** 当前绑定的输入框（未绑定时为 null）。 */
  get currentTextarea(): HTMLElement | null {
    return this.composer;
  }

  /** 绑定到当前输入框（若变化则重建对齐）。 */
  private attach(composer: HTMLElement): void {
    if (this.composer === composer) return;
    this.detach();
    this.composer = composer;
    const parent = composer.parentElement;
    if (parent !== null && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    composer.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll);
    if (parent !== null) parent.appendChild(this.el);
    this.align();
  }

  private detach(): void {
    if (this.composer !== null) {
      this.composer.removeEventListener('scroll', this.onScroll);
      this.composer = null;
    }
    this.el.dataset.shown = '0';
    window.removeEventListener('resize', this.onScroll);
    this.el.remove();
  }

  /** 对齐 overlay 到输入框内容区（含 padding 起点、跟随滚动）。 */
  private align(): void {
    const ta = this.composer;
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
    this.el.dataset.shown = '1';
    this.align();
  }

  hide(): void {
    this.el.style.visibility = 'hidden';
    this.el.textContent = '';
    this.el.dataset.shown = '0';
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
  /** IME 组词进行中（compositionstart~end 之间）：组合预览文本与幽灵后缀
   * 会叠在同一位置，必须抑制幽灵显示（Cursor/VSCode 同款处理）。 */
  let composing = false;

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
    /** host 实时推送：当前会话的最近用户输入文本（时间序，历史补全文本源）。 */
    history: readonly string[];
    /** history 所属会话；与当前会话不符时不做会话内补全（退化为纯热度候选）。 */
    historySessionId: string | null;
    /** 建议所属会话；与当前会话不符时隐藏 LLM 建议。 */
    suggestionSessionId: string | null;
  } = {
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    wordAccept: true,
    suggestion: null,
    hot: null,
    history: [],
    historySessionId: null,
    suggestionSessionId: null,
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
    if (actx === undefined) return; // 会话未就绪：不推进 lastSessionId，下次列表事件重试
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
    // 绑定成功即拉取该会话的权威状态（历史环 + 建议）：这是「会话就绪」的
    // 唯一出口，冷启动、切会话、会话晚就绪三条路径在这里汇合成一次请求，
    // 不再依赖 effect 初始化的那一拍（那时会话常常尚未就绪，请求会落空）。
    pullHistory(id);
  };

  /** 计算当前应显示的幽灵内容（null = 不显示）。 */
  const ghostContent = (): GhostContent | null => {
    if (bound === null) return null;
    if (composing) return null; // IME 组词中：组合预览与幽灵后缀重叠，抑制显示
    // 0.1.2 会话快照只余 lifecycle 字段；本插件用到的仅剩 `running`。
    const snapshot = bound.session.getSnapshot() as { running: boolean };
    const draft = bound.input.state.getSnapshot().draft;
    const currentId = sessions.list.getSnapshot().current as string | undefined;

    // 模式 1：草稿非空 → 历史前缀补全（打分制：新近度为主、频次/热度为辅）。
    if (settings.historyEnabled && draft.trim() !== '') {
      // 草稿是斜杠命令整行时（如 `/later +3m 我重新部署了…`），用命令名之后
      // 的「内容」部分去匹配历史。`/later` `recordInput:false`，历史里只有
      // 到点注入的内容部分；保留时间参数只会让所有候选 startsWith 失败。
      // 非命令整行（普通用户消息）时 stripCommandPrefix 原样返回 draft。
      const contentDraft = stripCommandPrefix(draft);
      if (contentDraft.trim() === '') return null;
      // 数据源：host 经 `_push` 推送的当前会话历史环（0.1.2 会话快照已不对
      // 插件暴露对话 nodes）。会话不符时退化为纯热度候选（跨会话模式仍有
      // 完整体验）。
      const history = settings.historySessionId !== null && settings.historySessionId === currentId
        ? settings.history
        : [];
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
      if (full === undefined) return null; // 无候选（前缀超限/低于阈值等），本帧不显示
      // 渲染按「原始草稿 + 候选」公共前缀对齐（宽度/空白差异时仍正确）；
      // 对斜杠命令场景，prefix=draft 让幽灵对齐到已输入字符（含命令前缀），
      // suffix 从 contentDraft 与 full 的归一化匹配段截尾——见 historySuggestion。
      const common = commonPrefixLength(contentDraft, full);
      return { kind: 'history', prefix: draft, suffix: full.slice(common), full };
    }

    // 模式 2：草稿为空 → LLM 建议（host 实时推送）。过期判据（0.1.2 形态）：
    // agent 运行中隐藏；建议属于其他会话时隐藏（host 推送按会话标记；运行中
    // 的会话由 running 隐藏，回合结束的推送要么更新建议要么清空，无需再比
    // 对会话快照里已移除的 turnEnds）。
    const suggestion = settings.suggestion;
    if (suggestion === null || suggestion === undefined) return null;
    const stale = snapshot.running
      || (settings.suggestionSessionId !== null && settings.suggestionSessionId !== currentId);
    if (stale) return null;
    return { kind: 'llm', text: suggestion.text, acceptKey: suggestion.acceptKey };
  };

  /** 缓存的上一次输入框查询结果（React 可能重建节点；isConnected 校验兜底）。 */
  let cachedComposer: HTMLElement | null = null;

  /** 渲染幽灵 overlay。 */
  const render = (): void => {
    resolve();
    retryPendingPull();
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
    // 复用已绑定的输入框；仅当缓存失效（React 重建/首次）时才查询 DOM。
    // 双代选择器：textarea（≤0.1.1）或 contenteditable（0.1.2 Lexical）。
    const attached = overlay.currentTextarea;
    let composer = attached !== null && attached.isConnected
      ? attached
      : cachedComposer !== null && cachedComposer.isConnected
        ? cachedComposer
        : document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
    if (composer === null) return; // 输入框尚未挂载，等待下次通知
    cachedComposer = composer;
    overlay.attach(composer);
    overlay.show(content);
    shown = { key, content };
  };

  // 读取/订阅设置命名空间（可选服务；缺失时保持默认并继续幽灵逻辑）。
  // 注意：必须放在 render 等函数定义之后，否则同步调用 applySettings 会触发
  // const 函数声明前的 TDZ（原 rc.6 版靠 ctx.inject 的异步延迟规避，rc.7 下
  // 需要显式保证顺序）。
  /** settingsScope 写面（经 `_ops` 反向通道请求 host 推送历史环）。 */
  let ghostPullScope: { set: (key: string, value: unknown) => void } | null = null;
  let pullRev = 0;
  let lastPulledSessionId: string | undefined;
  /** 尚未确认收到应答的 pull（见 retryPendingPull）；null = 无待确认请求。 */
  let pendingPull: { sessionId: string; attempts: number } | null = null;
  /** 待确认 pull 的退避定时器（仅在有 pendingPull 时存在）。 */
  let pullRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 请求 host 推送某会话的权威状态（历史环 + 建议 + 热度）——这也是 host 侧的
   * **对账请求**：本页打开后该会话收到过什么，只有 host 说了算。
   *
   * 因此判据是「本次页面生命周期内是否已为本会话请求过」（lastPulledSessionId），
   * 而**不能**拿本地残留的 `settings.historySessionId` 当「已经有了」的证据：
   * 那份数据可能来自上一个进程，而 host 这次可能因为「会话尚未进店」而整个跳过
   * 了启动对账推送（见 index.ts），此时若据此跳过请求，就再也没有对账机会了。
   *
   * 若写入抢跑在 host 的 `_ops` 监听注册之前，host 启动对账会补消费这条遗留
   * 请求（consumeOps 的遗留补跑），不会丢。
   */
  const pullHistory = (sessionId: string): void => {
    if (ghostPullScope === null) return;
    if (sessionId === lastPulledSessionId) return;
    lastPulledSessionId = sessionId;
    pendingPull = { sessionId, attempts: 0 };
    pullRev += 1;
    void ghostPullScope.set('_ops', JSON.stringify({ rev: pullRev, ops: [{ op: 'pull', sessionId }] }));
    schedulePullRetry(); // 未被应答时按退避重试（见 retryPendingPull）
  };

  /**
   * 未得到应答的 pull 重试：host 可能因「会话尚未进店 / 环尚不可得」而只回了一
   * 份不含历史的载荷，而请求本身已被消费（`_ops` 被清空）——没有重试就再没有
   * 对账机会。用退避定时器驱动（render 不保证还会被触发），上限
   * {@link PULL_MAX_ATTEMPTS} 次后放弃，避免会话真的不存在时自旋。
   */
  const retryPendingPull = (): void => {
    const pending = pendingPull;
    if (pending === null || ghostPullScope === null) return;
    // 只有当前仍绑定该会话时才值得重试（切走后由新会话的 pull 接管）。
    if (lastSessionId !== pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (settings.historySessionId === pending.sessionId) {
      pendingPull = null; // 已收到该会话的权威状态，对账完成
      return;
    }
    if (pending.attempts >= PULL_MAX_ATTEMPTS) {
      pendingPull = null;
      return;
    }
    pending.attempts += 1;
    pullRev += 1;
    void ghostPullScope.set('_ops', JSON.stringify({ rev: pullRev, ops: [{ op: 'pull', sessionId: pending.sessionId }] }));
    schedulePullRetry();
  };

  /** 为待确认的 pull 排下一次退避重试（已存在定时器时不重复排）。 */
  const schedulePullRetry = (): void => {
    if (pendingPull === null || pullRetryTimer !== null) return;
    const delay = PULL_RETRY_BASE_MS * 2 ** pendingPull.attempts;
    pullRetryTimer = setTimeout(() => {
      pullRetryTimer = null;
      retryPendingPull();
    }, delay);
  };
  const settingsScope = ctx.get('settingsScope');
  if (settingsScope !== undefined) {
    const scope = settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
    const applySettings = (): void => {
      const snap = scope.getSnapshot();
      const v = snap.value ?? {};
      let pushed: {
        suggestion?: unknown;
        hot?: unknown;
        history?: unknown;
        historySessionId?: unknown;
        suggestionSessionId?: unknown;
      } | null = null;
      if (typeof v._push === 'string' && v._push !== '') {
        try {
          pushed = JSON.parse(v._push) as typeof pushed;
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
        // history 省略 = host 本次推送不携带历史（保留现值）。启动对账推送正是
        // 这种形态：它只负责恢复建议，历史留给紧随其后的 pull 应答，此时若把
        // 本地历史清成 [] 会把「切回会话仍有历史」的体验一起清掉。
        history: Array.isArray(pushed?.history)
          ? (pushed?.history as unknown[]).filter((t): t is string => typeof t === 'string')
          : settings.history,
        historySessionId: Array.isArray(pushed?.history)
          ? (typeof pushed?.historySessionId === 'string' ? pushed.historySessionId : null)
          : settings.historySessionId,
        suggestionSessionId: typeof pushed?.suggestionSessionId === 'string' ? pushed.suggestionSessionId : null,
      };
      render();
    };
    scope.subscribe?.(applySettings);
    ghostPullScope = scope;
    applySettings();
  }

  /** Tab（或配置键）整条采纳；幽灵显示时裸 → 逐词采纳。 */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (shown === null) return;
    // 焦点必须在会话输入框内（textarea 或 0.1.2 contenteditable composer）。
    const focused = document.activeElement;
    if (!(focused instanceof HTMLTextAreaElement)
      && !(focused instanceof HTMLElement && focused.isContentEditable)) return;
    if (!isComposerTarget(focused)) return;
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
      const ta = focused;
      const draftNow = bound !== null ? bound.input.state.getSnapshot().draft : '';
      const full = content.kind === 'llm' ? content.text : content.full;
      // 光标必须在草稿末尾：textarea 用 selectionStart/End，contenteditable
      // 用 Selection API（caretAtComposerEnd 统一两代）。
      if (!caretAtComposerEnd(ta)) return;
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
    let deferredRenders: Array<ReturnType<typeof setTimeout>> = [];
    const scheduleDeferredRenders = (): void => {
      for (const t of deferredRenders) clearTimeout(t);
      // React 提交会话视图晚于 list store 更新：rebind 时 composer 可能尚未
      // 挂载，show() 会找不到编辑器；错峰补渲染覆盖这个竞态（幽灵显示后
      // 幂等，重复渲染无副作用）。
      deferredRenders = [60, 300, 900].map((ms) => setTimeout(render, ms));
    };
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
      scheduleDeferredRenders();
    };
    rebind();
    render(); // 初始渲染：不依赖订阅触发（修复：会话打开即检查幽灵）
    // 历史环的拉取在 resolve() 绑定成功处统一发起（冷启动经上面的 rebind），
    // 这里不再补发——旧的「初始化时拉一次」在会话尚未就绪时必然落空。
    const onList = (): void => {
      // 会话切换（current 变化）→ 重绑订阅（resolve 内即发起 pull）；否则仅渲染。
      const id = sessions.list.getSnapshot().current as string | undefined;
      if (id !== lastSessionId) rebind();
      render();
    };
    const unList = sessions.list.subscribe(onList);
    // IME 组词抑制：捕获监听（编辑器内组合事件会冒泡到 window）。组词开始
    // 立即隐藏幽灵；结束（候选上屏）后按已提交草稿重新渲染。
    const onCompositionStart = (): void => {
      composing = true;
      render();
    };
    const onCompositionEnd = (): void => {
      composing = false;
      render();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('compositionstart', onCompositionStart, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    return () => {
      unList();
      for (const un of unsubs) un();
      for (const t of deferredRenders) clearTimeout(t);
      if (pullRetryTimer !== null) clearTimeout(pullRetryTimer);
      pullRetryTimer = null;
      pendingPull = null;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('compositionstart', onCompositionStart, true);
      window.removeEventListener('compositionend', onCompositionEnd, true);
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
