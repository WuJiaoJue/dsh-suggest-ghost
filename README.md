<div align="center">

<img src="docs/logo.png?v=2" width="128" alt="dsh-suggest-ghost logo"/>

# dsh-suggest-ghost

**让 DeepSeek Harness 的输入框学会「接话」**

输入到一半，剩下的句子自动浮现；回合刚结束，下一步建议已经就位。
**Tab** 整条采纳，**→** 逐词采纳——Claude Code 同款幽灵输入。

`v0.1.0` · `MIT` · `DSH Web 0.1.0-rc.6`

</div>

---

## 👀 它长什么样

![输入「这个插件」，幽灵文本自动补全出「让输入框学会接话」](docs/screenshot-history.png)

*历史补全模式实拍——灰色部分是来自会话历史的建议，**Tab** 一键补全。
草稿为空时切换到 LLM 模式：回合结束后自动预测你的下一句，同样的幽灵样式、同样的 Tab 采纳。*

幽灵文本跟随输入框字体与滚动渲染，不遮挡、不抢焦点；不合意就无视它，继续打字即消失——零成本。

## 💡 为什么需要它

- **高频指令重复敲**：「跑一下测试」「看下日志」「提交这个 pr」，每天打十几遍
- **接话有成本**：AI 刚干完活，你还得想下一步怎么措辞
- **理想状态**：手指还没动，句子已经浮在那里；想要就 Tab,不想要就无视

## ✨ 核心特性

### 双模式自动切换

| 模式 | 触发 | 行为 |
|---|---|---|
| 📜 **历史补全** | 草稿非空 | 从会话历史找前缀匹配，zsh autosuggestions 式打分：新近度主导、频次与跨会话热度加权；全/半角标点、空白、大小写差异不影响命中 |
| 🔮 **LLM 下一条建议** | 草稿为空且回合结束 | 一次有界辅助调用预测你自然会输入的下一条提示词，中英文自动跟随会话语言 |

### 克制的工程

- 🪶 **只发最后一轮**：默认仅最后一轮对话送入建议模型（工具调用与中间推理不出本地）
- 🔐 **发送前脱敏**：AWS / OpenAI / GitHub / Slack / JWT / Stripe / 私钥 / Bearer 自动掩蔽；输出净化（ANSI/控制符/双向覆盖符剥离）+ 语义过滤（客套话、助手口吻、反问句一律丢弃）
- 🤫 **无建议是常态**：模型没把握就静默跳过，绝不硬凑
- ⏱️ **全程有界**：输入字节 / 输出 token / 超时全部封顶；同回合防重入，新回合自动作废旧生成，卸载即中止在途请求

### 贴心的细节

- 中文输入法组合期间不拦截任何按键
- 幽灵显示时自动避让原生 placeholder，不干扰 React 渲染
- 光标在末尾时按 **→** 逐词采纳（中文按词典分词），Tab 始终整条
- 所有设置在 WebUI 卡片实时生效，不用重启

## 🚀 快速开始

```sh
# 1. 克隆并构建
git clone http://192.168.4.77:3000/dsh-plugins/dsh-suggest-ghost.git
cd dsh-suggest-ghost && pnpm install && pnpm run build

# 2. 在 DSH web profile（~/.dsh/profiles/web/package.json）注册软链
#    "dsh-suggest-ghost": "link:/path/to/dsh-suggest-ghost"
cd ~/.dsh/profiles/web && pnpm install

# 3. 重启生效
dsh web
```

装好后**无需任何配置**——Settings → Plugins → *Suggest ghost* 即可按喜好调整。

## ⚙️ 配置

<details>
<summary><b>cordis.patch.yml 插件配置（可选，作为 WebUI 初值）</b></summary>

```yaml
- id: suggest-ghost
  config:
    maxInputBytes: 4096        # 框架化用户提示字节上限
    maxOutputTokens: 512       # 建议输出令牌上限（推理模型留足预算）
    timeoutMs: 60000           # 辅助请求截止时间（毫秒）
    maxRecentTurns: 1          # 送入建议模型的最近完成回合数
    maxTranscriptChars: 12000  # 转录字符预算
    maxSuggestionChars: 240    # 建议可见字符上限
    acceptKey: Tab             # 采纳快捷键（修饰键+主键，支持 Tab/字母/F 键/方向键等）
    llmEnabled: true           # LLM 下一条建议开关
    # provider: deepseek-official   # 显式路由；省略则继承主请求
    # model: deepseek-v4-flash
```

</details>

<details>
<summary><b>WebUI 设置卡片字段一览（保存即时生效）</b></summary>

| 分组 | 字段 | 说明 |
|---|---|---|
| LLM 建议 | 输出令牌上限 / 建议字符上限 / 参考回合数 / 转录预算 / 超时 | 生成策略边界 |
| LLM 建议 | 启用 LLM 建议 | 关闭后不再每回合调用模型（历史补全不受影响） |
| LLM 建议 | Provider / Model / 采纳快捷键 | 留空继承主请求路由 |
| 历史补全 | 启用历史补全 / 最少输入字符 / 最大历史条目 | 触发与候选范围 |
| 历史补全 | 跨会话搜索 | 开启后并入其他会话的高频历史作候选 |
| 历史补全 | 逐词采纳 | → 键按词前进（中文词典分词） |

</details>

## 🧠 工作原理

<details>
<summary><b>架构与数据流（点开查看）</b></summary>

```
dsh-suggest-ghost
├── src/index.ts         host 入口：turn/end(completed) → 生成建议
├── src/generate.ts      有界辅助生成：转录提取 → 脱敏 → ctx.llm.stream → 净化
├── src/sanitize.ts      脱敏 / 净化 / 语义过滤 / 截断（纯函数）
├── src/settings.ts      suggest-ghost settings 命名空间 + host→client 推送通道
├── src/hotness.ts       跨会话热度表（增量去重、内存上界）
├── src/projection.ts    suggestGhost 投影 last-wins fold + zod schema
├── src/domain.ts        事件/投影类型 + 模块扩展
└── src/client/          浏览器端：幽灵渲染、历史匹配、逐词切分、快捷键、设置卡片
```

数据流：`turn/end`(completed) → host 有界辅助 LLM 生成建议 → 经 settings `_push`
实时推送给 client（指纹幂等，无变化不写盘）→ 草稿为空且 agent 空闲时渲染幽灵；
草稿非空时走本地历史打分匹配。零核心改动，纯插件挂载。

</details>

## ⚠️ 已知限制

- 针对 DSH `0.1.0-rc.6` 开发测试；client 端已按 rc.7 严格门控适配，跨版本升级需回归验证
- 跨会话热度表为纯内存态：DSH 重启后从零累积（会话内历史补全不受影响）
- LLM 下一条建议仅覆盖当前会话；跨会话候选需手动开启「跨会话搜索」

## 📄 许可

MIT © wujue —— 安全管线设计参考了 [dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt)（MIT）

