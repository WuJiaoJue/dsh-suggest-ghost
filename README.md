<div align="center">
  <img src="docs/banner.png?v=2" alt="dsh-suggest-ghost — ghost autocomplete for DeepSeek Harness Web"/>
</div>

# dsh-suggest-ghost

[English](README.en.md) | **简体中文**

[![version](https://img.shields.io/badge/version-0.3.0-0EA5E9)](https://github.com/WuJiaoJue/dsh-suggest-ghost)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

> DeepSeek Harness Web 输入预测插件：回合结束后用一次辅助 LLM 调用预测你的下一条提示词，草稿为空时以幽灵文本显示在输入框里；输入过程中则从当前会话历史找前缀补全。Tab 整条采纳，→ 逐词采纳。

## 这是什么

纯插件挂载（host 监听回合事件 + client 端 DOM overlay），不改 DSH 任何核心代码。两个模式自动切换：

- **LLM 下一条建议**（草稿为空）：每个回合完成后，把最后一轮对话脱敏后发给建议模型（默认继承主请求路由，不额外配置），产出一条「你大概率会输入的下一句」——Claude Code 同款体验。
- **历史前缀补全**（草稿非空）：zsh autosuggestions 式——从会话历史找前缀命中项，按新近度为主、会话内频次与跨会话热度为辅打分取最优，灰色显示剩余部分。全/半角标点、空白、大小写差异不影响匹配。

幽灵文本是 DOM overlay 近似渲染（跟随输入框字体、跟随滚动），不依赖官方 `setGhost` 输入机能力，rc.6 即可运行；中文输入法组合期间不拦截按键。

## 效果预览

![实操演示：逐字输入，幽灵浮现，Tab 一键采纳](docs/demo.gif)

**① 历史前缀补全**（草稿非空）——输入「列出 do」，幽灵自动补全这条历史消息的剩余部分：

![历史前缀补全实拍](docs/mode-history-real.png)

**② LLM 下一条建议**（草稿为空，回合结束自动预测下一步）：

![LLM 下一条建议实拍](docs/mode-llm-real.png)

深色文字 = 已输入；灰色 = 幽灵建议。**Tab** 整条采纳，**→** 逐词采纳。幽灵文本跟随输入框字体与滚动渲染，不遮挡、不抢焦点；不合意就无视它，继续打字即消失——零成本。

## 安装

**npm 安装（推荐，预构建产物，无需授权）：**

```bash
dsh plugin --profile web add dsh-suggest-ghost
```

从 GitHub 一行安装（构建产物已随仓库提交，无需本地构建）：

```bash
dsh plugin --profile web add "github:WuJiaoJue/dsh-suggest-ghost"
```

或者源码方式：

```bash
git clone https://github.com/WuJiaoJue/dsh-suggest-ghost.git
cd dsh-suggest-ghost && pnpm install && pnpm run build
dsh plugin --profile web add .
```

装完重启 dsh web，页面 Ctrl+Shift+R 硬刷新。开箱即用，无需任何配置。

## 配置

全部设置在 Settings → Plugins 面板的 Suggest ghost 卡片，保存后即时生效：
卡片文案（字段 label/hint、按钮、徽章）跟随宿主 DSH 界面语言（中文 / English），
设置页切换语言后实时跟随，无需刷新；旧宿主无 locale 服务时回退中文。

| 分组 | 字段 |
|---|---|
| LLM 下一条建议 | 启用开关、输出令牌上限、建议字符上限、参考回合数、转录字符预算、超时（毫秒）、采纳快捷键、provider / model 路由（留空继承主请求） |
| 历史前缀补全 | 启用开关、跨会话搜索、最大历史条目、最少输入字符、逐词采纳 |
| 热度管理 | 跨会话高频短语列表：固定（不参与淘汰、候选恒置顶）、删除、手工新增（默认固定）、清空全部——即时生效，无需保存 |

也可以在 cordis.patch.yml 按 id 覆盖（作为上述项的初始值）：

```yaml
- id: suggest-ghost
  config:
    maxInputBytes: 4096        # 框架化用户提示字节上限
    maxOutputTokens: 512       # 建议输出令牌上限
    timeoutMs: 60000           # 辅助请求截止时间（毫秒）
    maxRecentTurns: 1          # 送入建议模型的最近完成回合数
    maxTranscriptChars: 12000  # 转录字符预算
    maxSuggestionChars: 240    # 建议可见字符上限
    acceptKey: Tab             # 采纳快捷键
    llmEnabled: true           # LLM 建议开关
```



<div align="center">
  <img src="docs/settings-card.png?v=3" width="640" alt="Suggest ghost 设置卡片（Settings → Plugins）"/>
</div>

## 安全

- 只把最后一轮对话发给建议模型，发送前自动脱敏常见凭据；输出经净化，不合格回复静默丢弃
- 全程有界：输入字节 / 输出 token / 超时封顶；同回合防重入，新回合作废旧生成，卸载即中止在途请求

## 兼容性

两代内核均实测通过（2026-09-07）：

| DSH 内核 | host 入口链接 | 运行时符号 | 真实启动（headless） | 真实启动（web） |
|---|---|---|---|---|
| `0.1.1-rc.2` | ✅ | ✅ 8/8 | ✅ 过插件阶段 | ✅ client bundle HTTP 200 |
| `0.1.2-rc.1` | ✅ | ✅ 8/8 | ✅ 过插件阶段 | ✅ client bundle HTTP 200 |

peer 依赖写成 `^0.1.1-rc.2 || ^0.1.2-rc.1` 这种**逐代枚举**，而不是 `>=0.1.1-rc.2`：node-semver 默认不把预发布版算进任何范围，只有比较符带同一 `[major.minor.patch]` 元组时才放行，所以 `^0.1.1-rc.2` 对 `0.1.2-rc.1` 为假、`*` 同样为假 —— 跨代没有区间写法。**上游每发布一个新的 rc 代次，peer 就要补一个枚举项**，否则安装期即因 peer 不满足而失败。

一份代码跨代所依赖的三处取舍：

- **不用 `settingsNamespace()`**：该 helper 在 `0.1.2` 已被删除，运行时导入会让整个模块链接失败。它只是校验后原样返回 brand 字符串，故改用 `'suggest-ghost' as SettingsNamespace` 字面量断言，格式校验仍由两代的 `ctx.settings.register()` 内部执行。
- **不导入 `deepFreeze`**：`0.1.1` 由 `dsh-llm` 导出，`0.1.2` 把它迁到新增的 `dsh-util-values` 并停止转发，而该包在 `0.1.1` 内核中不存在 —— 换导入源只会反向破坏另一代，因此 `src/generate.ts` 自带一份等价实现（迭代遍历、循环引用安全、跳过 `AbortSignal`）。
- **client 端不从 `@deepseek-ai/dsh-client-runtime` 取类型**：该包是 `0.1.1` 内核特有，`0.1.2` 已拆走。`lib/client.js` 实测零内核导入，跨代无关。

复现方式：为待测内核建隔离 profile（`$DSH_HOME` 指向临时目录，`node_modules` 用 `cp -al` 硬链接对应内核树，避免向上解析撞到另一代的树），先 `dsh --profile <p> --dump-config` 校验 manifest 组装，再 `dsh --profile <p> "say hi"` 与 `dsh --profile <p> -- --no-open --port <p>` 观察插件加载。两代 headless 启动都停在 `MISSING_CREDENTIAL`（临时 home 无凭据），该点在插件加载之后。

## 开发

```
src/index.ts         host 入口：turn/end(completed) → 有界生成建议
src/coldstart.ts     冷启动语义（纯函数）：日志取环种子、回合语义校验、_push 回读、建议追踪
src/generate.ts      转录提取 → 脱敏 → ctx.llm.stream → 净化
src/transcript.ts    转录纯逻辑：字符 + UTF-8 字节双预算裁剪（纯函数，可单测）
src/sanitize.ts      脱敏 / 净化 / 语义过滤 / 截断（纯函数）
src/settings.ts      settings 命名空间 + host→client 推送（_push）与 client→host 操作通道（_ops，尾写合并）
src/hotness.ts       跨会话热度表（增量去重、最小堆淘汰、内存上界、固定/管理 API）
src/hotness-store.ts 热度持久化（storageDomain 域、回合边界合并落盘、重启恢复合并、管理 ops 应用）
src/projection.ts    suggestGhost 投影 last-wins fold
src/client/          幽灵渲染、历史匹配、逐词切分、快捷键、设置卡片
scripts/             冒烟测试与会话日志回放
```

### 冷启动语义（重启后为何立即可用）

重启后「没有数据」并非真的没数据：**建议在 `settings.yaml` 的 `_push` 里，历史在会话日志里**。
所谓冷启动问题，本质是判据选错了——旧实现用「时间」（重启即作废、事件到达才播种）当判据，
于是留下两个空窗。现在统一改为**语义**判据：

- **历史环**是会话日志的缓存：pull 到达时未命中就从日志现算（`ringFor`），不存在「播种时机」，
  也就没有「pull 抢在首个事件之前 → 回空」的竞态。会话活跃期间由 `session/event` 增量维护。
- **建议**是否可用，取决于它对应的回合是否仍是该会话的最后一个已完成回合（`suggestionIsCurrent`）。
  启动时回读盘上残留并据此校验：有效则原样恢复（打开页面即见上一轮建议，不等新回合）；
  可判定为陈旧则清场；会话尚未进店（持久化懒恢复未发生）则**不猜测、不覆盖**，留给首次 pull 对账。
- 三条推送路径（启动对账 / pull 应答 / 热度恢复补推）共用同一份状态组装（`statePushOf`），
  不再各写各的；client 侧 pull 统一在会话绑定成功处发起，冷启动、切会话、会话晚就绪三合一。
- 热度表恢复完成后（`whenReady`）补推一次完整快照，关掉「恢复窗口内推送了不完整频次」的窗口。

```bash
pnpm run build       # tsc 编译 host + esbuild 打包 client → lib/
pnpm run test:smoke  # 纯函数冒烟测试（含热度持久化语义、冷启动语义）
pnpm run test:e2e    # 真实栈端到端：热度落盘→重启恢复；冷启动重启对账/pull 应答
pnpm run replay      # 用真实会话日志回放补全管线
```

## 已知限制

- 跨会话热度表已持久化（宿主 storage 域，落 `~/.dsh/storages/suggest_ghost_hotness.json`）：重启后频次恢复，不再从零累积；宿主无 storage 域（如旧版本）时自动降级为内存态，重启清零
- 重启后历史补全与上一轮建议立即可用（判据是语义而非重启时机）；但**新回合**的建议仍需等该回合跑完才能生成——这是「预测下一条」的固有代价，不是启动延迟
- 热度管理面板显示并过滤的是推送的 top-K 快照（默认 50 条，「共 N 条」展示全量）；更大范围的主机侧搜索未做
- 删除只清当前统计——再次输入同文本会重新计入；「固定」才是不被淘汰的语义
- LLM 建议只覆盖当前会话；把其他会话文本并作候选需开启「跨会话搜索」
- 每个完成回合都会调一次建议模型（与输入框是否有内容无关），不需要时可在设置里关闭省 token

## 许可

MIT © wujue。安全与生成管线参考 [dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt)（MIT）实现。


<div align="center">
  <img src="docs/logo-peek.png?v=1" width="150" alt=""/>
</div>
