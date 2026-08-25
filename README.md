# dsh-suggest-ghost

**DeepSeek Harness Web UI 输入预测插件**，双模式幽灵输入：

1. **历史补全（草稿非空）**：从当前会话历史找**前缀匹配**，按加权打分选最优——新近度为主（zsh autosuggestions 体感），会话内频次与跨会话热度频次为辅，后缀长度微调；匹配前先归一化（全/半角标点、空白折叠、大小写），幽灵显示剩余部分，**Tab** 采纳。例如历史里发过「我合并了这个pr，你同步一下本地对应分支」，再输入「我合并了这个」即补全剩余。
2. **LLM 预测（草稿为空）**：每个 agent 回合完成后，通过一次有界的辅助 LLM 调用生成**一条建议的下一条提示词**，幽灵文本渲染，**Tab** 采纳——Claude Code 同款体验。

零核心改动，纯插件挂载：host 端监听回合事件 + 注册 `suggestGhost` 会话投影；client 端 DOM overlay 渲染（**不依赖官方 `setGhost` 输入机能力**，在当前 rc.6 即可运行），显示幽灵时自动隐藏输入框原生 placeholder（CSS class 控制，不干扰 React）。

## 特性

- **双模式自动切换**：草稿为空 → LLM 预测；输入中 → 历史前缀补全（打分制排名：新近度为主、频次/热度为辅；归一化匹配，排除与草稿完全相同、去相邻重复）。
- **轻量默认**：建议模型默认继承主请求路由（`session.requestHeader()`），无需单独配置模型；每完成回合至多一次辅助请求，主请求零额外 token。
- **LLM 建议可按需关闭**（`llmEnabled`，默认开）：只想要历史补全的用户在设置卡片关掉即可，每回合不再调用建议模型，省 token。
- **只发最后一轮**：默认只把最后一轮的用户输入 + AI 最终回答发给建议模型（`maxRecentTurns: 1`），中间的工具调用/推理过程一律不发送。
- **有界调用**：字节/令牌/超时上限、转录预算、建议可见字符上限全部可配置。
- **安全**：转录发送前脱敏（AWS/OpenAI/GitHub/Slack/JWT/Stripe/私钥/Bearer 掩蔽）；输出净化（ANSI/控制符/双向覆盖符剥离、去引号围栏、单行化）+ 语义过滤（套话/助手口吻/问题/过长回复丢弃为「无建议」）。
- **无建议是常态**：模型回复为空或不合格时静默跳过——不报错、不写事件、不打扰。
- **热度表只记真实输入**：仅统计 `source.kind === 'user'` 的消息；`<system-reminder>` 包装块、runtime 快照等系统注入及超长文本（>2000 字符）不入热表、不入历史候选——避免污染 top-K 与推送载荷。同会话相邻重复只计一次频次（不虚增）；条目数有上限、最久未用者淘汰，长驻内存有界。
- **防重入**：同会话并发生成防重、新回合自动中止旧生成、插件卸载中止全部在途调用。
- **IME/焦点保护**：中文输入法组合期间不拦截；采纳键仅在输入框聚焦且显示幽灵时拦截。
- **逐词采纳**：幽灵显示时光标位于草稿末尾，按 → 每次采纳一个词——用 `Intl.Segmenter` 词典分词，中文自然成词（提交/一下/代码），英文按空格；环境缺失时退化为字符类切分（CJK 每片 ≤2 字）。词尾空格/标点跟随词收进片段；Tab 始终整条采纳；光标不在末尾或草稿与建议字面分歧时不劫持方向键（设置卡片可关）。
- **placeholder 不重叠**：幽灵激活时 CSS 隐藏原生 placeholder，不干扰 React 受控渲染。

## 安装

源码独立存放（如 `~/workspace/dsh-plugins/dsh-suggest-ghost`），web profile 以 `link:` 软链注册（改 lib 即生效，无需重装）：

```sh
# profile 的 package.json 中（路径换成你的插件目录）：
#   "dsh-suggest-ghost": "link:~/workspace/dsh-plugins/dsh-suggest-ghost"
cd ~/.dsh/profiles/web && pnpm install
# 重启 dsh web 后生效
dsh web
```

构建：插件根目录 `npm run build`（tsc 编译 host 端 + esbuild 打包 client 端到 `lib/`）。

安装后 `dsh-suggest-ghost` 自动追加为 web profile 的 bundle 层（`dsh.bundle.patch`），client 端经 `dsh.client` 声明进入 boot 图，无需手改任何文件。

## 配置

两个配置面，优先级从高到低：

1. **WebUI 设置卡片**（推荐）：Settings → Plugins → *Suggest ghost*，改动保存后立即生效（live），无需重启。LLM 建议组：输出令牌上限、建议字符上限、参考回合数、转录字符预算、超时、采纳快捷键、启用 LLM 建议、provider/model 路由；历史补全组：启用历史补全、跨会话搜索、最大历史条目、最少输入字符、逐词采纳。
2. **`cordis.patch.yml` 插件配置**（按 id 覆盖，作为上述设置项的 base 初值）。全部字段有默认值，开箱即用：

```yaml
- id: suggest-ghost
  config:
    maxInputBytes: 4096        # 框架化用户提示字节上限
    maxOutputTokens: 512       # 建议输出令牌上限（推理模型留足预算）
    timeoutMs: 60000           # 辅助请求截止时间（毫秒）
    maxRecentTurns: 1          # 转录保留的最近完成回合数
    maxTranscriptChars: 12000  # 转录字符预算
    maxSuggestionChars: 240    # 建议可见字符上限
    # provider: deepseek-official   # 显式路由；省略则继承主请求
    # model: deepseek-v4-flash
    acceptKey: Tab             # 采纳快捷键：修饰键+主键，主键支持 Tab/Enter/Space/Slash、字母/数字、F1-F12、方向键及常用标点（设置卡片为按键捕获式录入）
    llmEnabled: true           # LLM 下一条建议开关；关闭后每回合不再调用建议模型（省 token，历史补全不受影响）
```

注意：历史补全的细粒度开关（`historyEnabled` / `historyCrossSession` / `historyMaxEntries` / `historyMinChars` / `wordAccept`）只在 WebUI 设置卡片暴露，不走插件配置。

## 架构

```
dsh-suggest-ghost
├── src/index.ts         host 入口：turn/end(completed) → 生成建议；注册 suggestGhost 投影
├── src/generate.ts      有界辅助生成：转录提取 → 脱敏 → ctx.llm.stream → 净化 → append 事件
├── src/sanitize.ts      脱敏 / 净化 / 语义过滤 / 截断 / CJK 检测（纯函数）
├── src/settings.ts      suggest-ghost settings 命名空间（WebUI 配置面 + host→client 推送通道）
├── src/hotness.ts       跨会话历史热度表（增量、去重、内存上界）
├── src/projection.ts    suggestGhost 投影 last-wins fold + zod schema
├── src/domain.ts        事件/投影类型 + SessionEventMap/SessionProjectionMap 模块扩展
├── src/client/index.ts  浏览器端：双模式幽灵渲染 + 快捷键采纳（纯 JS，零运行时依赖）
├── src/client/history.ts     历史提取 / 打分制前缀匹配纯函数（独立单测）
├── src/client/chunk.ts       逐词采纳切分（Intl.Segmenter，含回退）
├── src/client/keyspec.ts     快捷键 spec 解析/录制（两端共用一张键表）
└── src/client/settings-card.tsx  WebUI 设置卡片（对齐官方 PluginCard 视觉）
```

数据流：`turn/end`(completed) → host 有界辅助 LLM 生成建议（转录脱敏 → 净化 → 语义过滤）→ 经 settings `_push` 实时推给 client（指纹幂等：无新建议且热度未变不重复写盘；插件启动/重载时清空残留建议，避免旧回合幽灵复现）→ client 草稿为空且 agent 空闲时渲染幽灵文本，Tab 采纳；草稿非空时走 `historySuggestion` 打分制前缀匹配（热度频次经 `_push` 随建议一同送达，始终参与打分；「跨会话搜索」开关决定是否并入跨会话候选文本）。`suggestGhost` 投影单元仍注册（last-wins fold），作为事件通道/未来官方哨兵能力的后备；当前建议的实际投递走 settings 通道。

## 已知限制

- **版本兼容**：针对 DSH `0.1.0-rc.6` 开发与测试（peerDependencies 表达依赖区间）；client 端写法已按 rc.7 的严格门控 context 适配（见源码注释），跨版本升级需回归验证。
- 跨会话热度表为纯内存、无持久化：DSH 重启后从零累积（会话内历史补全不受影响）。
- LLM 下一条建议仅覆盖当前会话（跨会话不共享）；历史补全的热度索引为跨会话汇总（仅「跨会话搜索」开启时才会把其他会话文本并作候选）。
- **历史补全读取会话快照窗口内的消息**（与 dsh-input-history 同源限制）——窗口外的旧消息不参与前缀匹配；频繁复用的消息天然在窗口内。
- 幽灵文本为 DOM overlay 近似（rc.6 无官方 ghost 输入机），多行建议自动换行、跟随 textarea 滚动；等官方 `setGhost` 能力落地后可平滑切换。
- 每个完成回合都会生成 LLM 建议（与输入框是否有内容无关），幽灵只在草稿为空且 agent 空闲时显示。

## 许可

MIT。参考了 [dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt)（MIT）的安全管线设计。
