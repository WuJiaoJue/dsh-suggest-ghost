/**
 * dsh-suggest-ghost host 端：监听已完成回合，有界生成下一条建议并写入
 * 会话日志，注册 `suggestGhost` 会话投影。零核心改动，纯插件挂载。
 * @module dsh-suggest-ghost
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Config as GenerateConfig } from './generate.js';
/** 配置 schema（cordis 插件约定，config catalog 会原样粘贴声明）。全部字段带默认值，开箱即用；可按需覆盖。 */
export declare const Config: z<Schemastery.ObjectS<{
    /** 最终框架化用户提示的最大 UTF-8 字节数。 */
    maxInputBytes: z<number, number>;
    /** 建议生成输出令牌上限（推理模型需留足预算，如 512）。 */
    maxOutputTokens: z<number, number>;
    /** 辅助请求端到端截止时间（毫秒）。 */
    timeoutMs: z<number, number>;
    /** 转录尾部保留的最近完成回合数（默认 1：只取最后一轮）。 */
    maxRecentTurns: z<number, number>;
    /** 转录字符预算。 */
    maxTranscriptChars: z<number, number>;
    /** 建议可见字符上限。 */
    maxSuggestionChars: z<number, number>;
    /** LLM 下一条建议开关（默认开）；作为 settings base 初值，WebUI 卡片可实时覆盖。 */
    llmEnabled: z<boolean, boolean>;
    /** 显式路由对；同时省略则继承主请求最近记录的路由。 */
    provider: z<string, string>;
    model: z<string, string>;
    /** 采纳建议的输入框快捷键（默认 Tab）。 */
    acceptKey: z<string, string>;
}>, Schemastery.ObjectT<{
    /** 最终框架化用户提示的最大 UTF-8 字节数。 */
    maxInputBytes: z<number, number>;
    /** 建议生成输出令牌上限（推理模型需留足预算，如 512）。 */
    maxOutputTokens: z<number, number>;
    /** 辅助请求端到端截止时间（毫秒）。 */
    timeoutMs: z<number, number>;
    /** 转录尾部保留的最近完成回合数（默认 1：只取最后一轮）。 */
    maxRecentTurns: z<number, number>;
    /** 转录字符预算。 */
    maxTranscriptChars: z<number, number>;
    /** 建议可见字符上限。 */
    maxSuggestionChars: z<number, number>;
    /** LLM 下一条建议开关（默认开）；作为 settings base 初值，WebUI 卡片可实时覆盖。 */
    llmEnabled: z<boolean, boolean>;
    /** 显式路由对；同时省略则继承主请求最近记录的路由。 */
    provider: z<string, string>;
    model: z<string, string>;
    /** 采纳建议的输入框快捷键（默认 Tab）。 */
    acceptKey: z<string, string>;
}>>;
/** 所需服务：LLM 路由 + 会话存储。 */
export declare const inject: string[];
/** 插件名（与 cordis 条目 id 及 manifest 一致）。 */
export declare const name = "dsh-suggest-ghost";
/**
 * 挂载插件：监听完成回合、按会话生成建议、注册投影单元，并把配置暴露
 * 到 WebUI 设置页（settings 命名空间，live 生效）。
 * @param ctx - 提供 LLM 与会话服务的 cordis 上下文。
 * @param config - 必填的有界生成策略。
 */
export declare function apply(ctx: Context, config: GenerateConfig): void;
