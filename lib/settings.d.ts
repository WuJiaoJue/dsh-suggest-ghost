/**
 * `suggest-ghost` settings 命名空间：把插件配置暴露到 WebUI 设置页
 * （Settings → Plugins 面板的 Suggest ghost 卡片），用户无需手改 cordis.patch.yml。
 * 当前 DSH 的 apiproxy 经 settings.describe() 把**所有已注册命名空间**暴露给
 * client（无 allowlist）；插件注册即出现在设置页，卡片由本包 client 端提供。
 * @module dsh-suggest-ghost/settings
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { SettingsScope, SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type { Config } from './generate.js';
/**
 * 品牌命名空间名（Web allowlist 必须列出同一字符串：suggest-ghost）。
 * 不用官方 settingsNamespace() helper——它在 DSH 0.1.2 内核已被删除，运行时导入
 * 会让本模块链接失败；该 helper 仅是校验后原样返回，同样的格式校验 register 内部两代都做。
 */
export declare const SUGGEST_GHOST_NAMESPACE: SettingsNamespace;
/** settings 命名空间的取值类型。 */
export interface SuggestGhostSettings {
    maxOutputTokens: number;
    maxSuggestionChars: number;
    maxRecentTurns: number;
    maxTranscriptChars: number;
    timeoutMs: number;
    acceptKey: string;
    provider: string;
    model: string;
    /** 是否启用 LLM 下一条建议（草稿为空时的幽灵预测）；关闭后不再每回合调用建议模型。 */
    llmEnabled: boolean;
    /** 是否启用历史前缀补全（草稿非空时按历史补全剩余句子）。 */
    historyEnabled: boolean;
    /** 是否跨会话搜索历史（false = 仅当前会话；true = 含本工作区其他会话）。 */
    historyCrossSession: boolean;
    /** 历史补全最多参考的历史条目数（0 = 不限）。 */
    historyMaxEntries: number;
    /** 草稿至少输入多少字符才触发历史补全（避免过早弹框）。 */
    historyMinChars: number;
    /** 幽灵显示时允许 → 逐词采纳（Tab 始终整条采纳）。 */
    wordAccept: boolean;
    /**
     * host → client 的实时推送载荷（不落会话日志，经 settings 通道 live 送达）。
     * 存为 JSON 字符串：包含最新 LLM 建议与跨会话热度快照；`rev` 递增标识新值。
     * 仅供只读消费，不参与 WebUI 表单（`hidden`）。
     */
    _push: string;
    /**
     * client → host 的热度管理操作队列（管理面板「热度管理」分组写入）。
     * 存为 JSON 字符串：`{ rev, ops: [{op:'delete'|'pin'|'add', text, pinned?}] }`。
     * host 经 `scope.watch` 消费：应用到热表并持久化后**立即清空**本字段——
     * 一来防宿主重启后旧操作重放（如陈旧的 clear 把新数据清掉），二来清空本身
     * 就是「已消费」信号；host 推回的最新 `_push` 即权威状态（client 无需 ACK）。
     * 操作本身幂等（delete/pin/add 重复执行无副作用），rev 仅用于 client 侧递增。
     */
    _ops: string;
}
/** `_push` 的空载荷（JSON 字符串的 null 表示）。 */
export declare const EMPTY_PUSH = "null";
/** 命名空间 section 的 schemastery schema（WebUI 据此渲染配置表单）。 */
export declare const SuggestGhostSettingsSchema: z<SuggestGhostSettings>;
/**
 * 注册命名空间，返回 owner scope（host 生成建议时读取 live 值，
 * WebUI 里改动立即生效——applies: 'live'）。
 * @param ctx - 上下文（需已组合 settings 服务）。
 * @param base - 基线值（来自 cordis 插件配置 / 默认值）。
 */
export declare function registerSuggestGhostSettings(ctx: Context, base: Config): SettingsScope<SuggestGhostSettings>;
/**
 * 把 settings 的 live 值合并回生成配置：路由对为空串时回退到插件配置的
 * 继承语义（不显式传 provider/model → generateSuggestion 继承主请求路由）。
 */
export declare function effectiveConfig(plugin: Config, live: SuggestGhostSettings): Config;
