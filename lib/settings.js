/**
 * `suggest-ghost` settings 命名空间：把插件配置暴露到 WebUI 设置页
 * （Settings → Plugins 面板的 Suggest ghost 卡片），用户无需手改 cordis.patch.yml。
 * 当前 DSH 的 apiproxy 经 settings.describe() 把**所有已注册命名空间**暴露给
 * client（无 allowlist）；插件注册即出现在设置页，卡片由本包 client 端提供。
 * @module dsh-suggest-ghost/settings
 */
import z from '@deepseek-ai/schemastery';
/**
 * 品牌命名空间名（Web allowlist 必须列出同一字符串：suggest-ghost）。
 * 不用官方 settingsNamespace() helper——它在 DSH 0.1.2 内核已被删除，运行时导入
 * 会让本模块链接失败；该 helper 仅是校验后原样返回，同样的格式校验 register 内部两代都做。
 */
export const SUGGEST_GHOST_NAMESPACE = 'suggest-ghost';
/** `_push` 的空载荷（JSON 字符串的 null 表示）。 */
export const EMPTY_PUSH = 'null';
/** 命名空间 section 的 schemastery schema（WebUI 据此渲染配置表单）。 */
export const SuggestGhostSettingsSchema = z.object({
    maxOutputTokens: z.natural().min(1).default(512),
    maxSuggestionChars: z.natural().min(1).default(240),
    maxRecentTurns: z.natural().min(1).default(1),
    maxTranscriptChars: z.natural().min(1).default(12_000),
    timeoutMs: z.natural().min(1).default(60_000),
    acceptKey: z.string().min(1).default('Tab'),
    provider: z.string(),
    model: z.string(),
    llmEnabled: z.boolean().default(true),
    historyEnabled: z.boolean().default(true),
    historyCrossSession: z.boolean().default(false),
    historyMaxEntries: z.natural().min(0).default(50),
    historyMinChars: z.natural().min(1).default(1),
    wordAccept: z.boolean().default(true),
    _push: z.string().default(EMPTY_PUSH).hidden(),
    _ops: z.string().default(EMPTY_PUSH).hidden(),
});
/**
 * 注册命名空间，返回 owner scope（host 生成建议时读取 live 值，
 * WebUI 里改动立即生效——applies: 'live'）。
 * @param ctx - 上下文（需已组合 settings 服务）。
 * @param base - 基线值（来自 cordis 插件配置 / 默认值）。
 */
export function registerSuggestGhostSettings(ctx, base) {
    // base 只传用户关心的字段；路由对（provider/model）成对继承自插件配置。
    const baseSettings = {
        maxOutputTokens: base.maxOutputTokens,
        maxSuggestionChars: base.maxSuggestionChars,
        maxRecentTurns: base.maxRecentTurns,
        maxTranscriptChars: base.maxTranscriptChars,
        timeoutMs: base.timeoutMs,
        acceptKey: base.acceptKey,
        // 插件配置（cordis.patch.yml）的 llmEnabled 作为 base 初值；
        // WebUI 卡片保存后写入 user layer，实时覆盖 base（applies: 'live'）。
        llmEnabled: base.llmEnabled ?? true,
        ...(base.provider !== undefined && base.model !== undefined
            ? { provider: base.provider, model: base.model }
            : { provider: '', model: '' }),
        // 历史补全配置与生成策略无关，固定走默认值（用户可在 WebUI 调整）。
        historyEnabled: true,
        historyCrossSession: false,
        historyMaxEntries: 50,
        historyMinChars: 1,
        wordAccept: true,
        _push: EMPTY_PUSH,
        _ops: EMPTY_PUSH,
    };
    return ctx.settings.register(SUGGEST_GHOST_NAMESPACE, SuggestGhostSettingsSchema, {
        base: baseSettings,
        applies: 'live',
    });
}
/**
 * 把 settings 的 live 值合并回生成配置：路由对为空串时回退到插件配置的
 * 继承语义（不显式传 provider/model → generateSuggestion 继承主请求路由）。
 */
export function effectiveConfig(plugin, live) {
    const route = live.provider.trim() !== '' && live.model.trim() !== ''
        ? { provider: live.provider.trim(), model: live.model.trim() }
        : (plugin.provider !== undefined && plugin.model !== undefined
            ? { provider: plugin.provider, model: plugin.model }
            : {});
    return {
        maxInputBytes: plugin.maxInputBytes,
        maxOutputTokens: live.maxOutputTokens,
        timeoutMs: live.timeoutMs,
        maxRecentTurns: live.maxRecentTurns,
        maxTranscriptChars: live.maxTranscriptChars,
        maxSuggestionChars: live.maxSuggestionChars,
        acceptKey: live.acceptKey,
        llmEnabled: live.llmEnabled,
        ...route,
    };
}
