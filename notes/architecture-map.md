# packages/ 架构地图

> 10 个包，约 11.6 万行 TS。行数统计只算 `src/**/*.ts`（不含 test/dist），基于 `v0.84.1`。
> 目的：知道**每个包负责什么、谁依赖谁、要找某类逻辑该去哪个包**。不求读完。

## 一张图

```
                    ┌──────────────┐
                    │  telemetry   │  935   零依赖，被所有人用
                    └──────────────┘
                           ▲
            ┌──────────────┴───────────────┐
            │                              │
      ┌─────────┐                    ┌──────────┐
      │   ai    │ 22365              │ protocol │ 1236   typebox 定义的线上协议
      │ 模型接入 │                    └──────────┘
      └─────────┘                       ▲     ▲
            ▲                           │     │
            │                    ┌──────────┐ │
      ┌─────────┐                │  client  │ │ 1225
      │  agent  │ 12191          └──────────┘ │
      │ 循环+harness│                  ▲       │
      └─────────┘                      │  ┌────────┐
            ▲                          │  │ server │ 2298
            │        ┌──────┐          │  └────────┘
            └────────┤ tui  │ 16202    │      ▲
                     └──────┘          │      │
                        ▲              │      │
                  ┌─────┴──────────────┴──────┴──┐
                  │        coding-agent          │ 58672
                  │   产品层（bin: pi）           │
                  └──────────────────────────────┘
```

依赖是**严格单向**的，没有回边。验证方式：

```bash
# ai 里 0 处引用 agent；agent 里 0 处引用 coding-agent
grep -rl "@earendil-works/pi-agent-core" packages/ai/src   # → 空
```

| 包 | 被谁引用（文件数） |
|---|---|
| `pi-ai` | agent 17、coding-agent 48、server 1 |
| `pi-agent-core` | coding-agent 32 |
| `pi-tui` | coding-agent 62 |

**`tui` 不依赖 `ai` 也不依赖 `agent`**（→ai:0 →agent:0）——它是纯终端渲染库，对 agent 一无所知，只有 coding-agent 把两边缝在一起。这是本仓库分层最干净的一处证据。

---

## 三个主力包各自装了什么

### `ai`（22365）—— 把 N 家模型收敛成一套概念

| 子目录 | 行 | 内容 |
|---|---|---|
| `api/` | 10736 | **协议适配层**，6 个协议族，见 [adapter-layer.md](adapter-layer.md) |
| `auth/` | 3510 | OAuth / 各家凭证获取 |
| `providers/` | 2430 | 87 个文件，多为生成的 provider 元数据 |
| `utils/` | 1832 | |
| `models.ts` | 944 | 模型目录、能力查询 |
| `types.ts` | 821 | **全仓最基础的类型定义**（Message / Content / Model / Context） |

对外只暴露两件事：**统一的 `Message` 类型**和**统一的流式事件**。上层不知道底下是谁。

### `agent`（12191）—— 循环本体 + harness

| 文件/目录 | 行 | 内容 |
|---|---|---|
| `harness/` | 9824 | 会话持久化、状态归约、压缩、执行环境、内置工具 |
| `agent-loop.ts` | 796 | **主循环**，见 [agent-loop.md](agent-loop.md) |
| `agent.ts` | 592 | Agent 类，包装循环 + 状态 |
| `types.ts` | 443 | AgentMessage / AgentTool / AgentEvent |
| `proxy.ts` | 369 | |

`harness/` 里的重点（Day 6 主线）：

```
reducer.ts        667   事件 → 状态的归约
compaction/       1128  上下文压缩（含 branch-summarization）
session/          2000+ 持久化，JSONL 编解码 + 一致性测试(conformance 993)
env/nodejs.ts     695   执行环境抽象
tools/            1190  内置工具的「参考实现」← 见下方注意
```

`env/` 这个抽象值得注意：工具不直接调 `child_process`，而是通过 `ExecutionEnv`。**这是为了让同一套工具能跑在本地、容器、远端三种环境里。**

### `coding-agent`（58672）—— 占全仓一半的产品层

| 子目录 | 行 | 内容 |
|---|---|---|
| `modes/interactive/` | 17362 | **交互式 TUI 模式**，最大的单块 |
| `core/` | 28640 | 会话、配置、扩展、工具、模型运行时 |
| `utils/` | 3519 | |
| `cli/` | 1814 | 命令行子命令 |
| `modes/rpc/` | 1765 | RPC 模式 |
| `extensions/` | 1414 | |
| `main.ts` | 972 | 入口（那个 400 行的 main 函数在这） |

`core/` 里最大的几个：

```
agent-session.ts     3342  ← 把 agent 循环接到 UI/持久化上
package-manager.ts   2677
extensions/types.ts  1727
session-manager.ts   1714
settings-manager.ts  1272
resource-loader.ts   1096
compaction/          969
model-runtime.ts     787   ← Day 3 读过
model-resolver.ts    775
provider-composer.ts 572
```

三种运行模式并列在 `modes/` 下：`interactive`（默认 TUI）、`rpc`、`print-mode`（169 行，一次性输出）。**同一套 core，三个前端。**

---

## 解决 Day 7 的遗留问题：工具为什么有两份实现

之前发现 `agent/harness/tools/`（1190 行）和 `coding-agent/core/tools/`（4142 行）名字重复。查清楚了：

| | agent 层 | coding-agent 层 |
|---|---|---|
| bash | 161 | 508 |
| read | 144 | 356 |
| edit | 127 | 441 |
| write | 39 | 272 |
| grep/find/ls | **没有** | 390/380/230 |

**不是包装关系，是两套独立实现，服务两类调用方：**

- `coding-agent/core/tools/` → **pi CLI 实际使用的**，带权限确认、TUI 渲染、输出截断、diff 展示
- `agent/harness/tools/` → **给 SDK 使用者的最小实现**，只做事不管展示

唯一同时用到两边的是 `src/server/create-harness.ts`：它从 `pi-agent-core` 拿工具**实现**，却从 `coding-agent/core/tools/` 拿工具的**系统提示词片段**（`bashToolSystemPromptContribution` 等）。

```ts
// server/create-harness.ts:1-18
import { createBashTool, ... } from "@earendil-works/pi-agent-core";   // 实现来自 agent 层
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts"; // 提示词来自产品层
```

注意 `createCodingAgentHarness` **全仓只有 test 在调**（`test/server/create-harness.test.ts`），src 里零调用——又一个「符号存在 ≠ 被调用」的例子，它是留给 SDK 使用者的对外入口。查法：

```bash
grep -rn "createCodingAgentHarness" packages | grep -v node_modules | grep -v dist
```

**结论：agent 层的 tools 是"给别人用的参考实现"，coding-agent 层的是"pi 自己用的完整版"。行数差 2–7 倍，差的全是产品化的部分（权限、渲染、截断）。**

---

## 四个边缘包（合计不到 6000 行，可以先不看）

| 包 | 行 | 是什么 |
|---|---|---|
| `protocol` | 1236 | typebox 定义的 RPC 消息格式，纯类型 + schema |
| `client` | 1225 | 连 server 的客户端，只依赖 protocol |
| `server` | 2298 | HTTP/RPC 服务端 |
| `telemetry` | 935 | 埋点，零依赖 |
| `evals` | 1277 | 评测 |
| `session-backends` | 0 | **空包**（src 下 0 个 ts 文件），占位 |

`protocol` + `client` + `server` 三件套是把 pi 跑成服务的那条路径，和本地 CLI 是并列的两种形态。

---

## 找东西该去哪个包

| 想改/想找 | 去哪 |
|---|---|
| 支持一家新模型厂商 | `ai/src/api/` + `ai/src/types.ts` 的 `KnownApi` |
| 改 agent 循环的终止/重试逻辑 | `agent/src/agent-loop.ts` |
| 改上下文压缩策略 | `agent/src/harness/compaction/` |
| 改会话怎么存 | `agent/src/harness/session/` |
| 加一个 pi 的内置工具 | `coding-agent/src/core/tools/` |
| 改终端界面 | `tui/` + `coding-agent/src/modes/interactive/` |
| 改命令行参数 | `coding-agent/src/main.ts` |
| 加扩展/插件 | `coding-agent/src/core/extensions/` |

---

## `agent` vs `coding-agent`：能力清单

Day 6 查清的。**核心结论：`packages/agent` 是通用 agent 库，`coding-agent` 是它的一个具体产品实例。你完全可以只用前者做别的类型的 agent——这就是它的主要用途。**

`packages/agent/README.md` 的 Quick Start 就是干这个的，20 行造一个 agent：

```ts
const agent = new Agent({
	initialState: { systemPrompt: "You are a helpful assistant.", model },
	streamFn: models.streamSimple.bind(models),
});
agent.subscribe((event) => { /* 渲染 */ });
await agent.prompt("Hello!");
```

**README 513 行里一次都没提 `harness`**——讲的全是 `Agent` 类、事件流、工具、自定义消息类型。印证那条规律：**`Agent` 类是现在给外部用的稳定 API，`AgentHarness` 是将来的。**

### 两个包的分工

| | `packages/agent`（12191） | `packages/coding-agent`（58672） |
|---|---|---|
| 定位 | **通用 agent 库** | **一个具体产品**（编码助手 CLI） |
| npm 名 | `@earendil-works/pi-agent-core` | `@earendil-works/pi-coding-agent`（`bin: pi`） |
| 核心 | `agent-loop.ts` 796 + `agent.ts` 592 | `agent-session.ts` 3342（缝合层） |
| 工具 | 4 个最小实现（1190） | 10 个产品级（4142，带权限/渲染/截断） |
| UI | ❌ 无 | ✅ `modes/interactive` 17362 + 依赖 tui |
| 配置系统 | ❌ 无 | ✅ `settings-manager` 1272 + `models.json` |
| 扩展机制 | ❌ 无 | ✅ `extensions/` 1414 |
| 测试 | 20 文件 / 8260 行 | 221 文件 / 49251 行 |

**后者是前者的 4.8 倍——这个比例说明「从内核到产品」要补多少东西。**

### `agent` 现在**能**给你

| 能力 | 在哪 | 状态 |
|---|---|---|
| Agent 循环（工具调用、终止、错误回喂） | `agent-loop.ts` | ✅ 见 [agent-loop.md](agent-loop.md) |
| 状态管理 + 事件订阅 | `agent.ts` | ✅ |
| steering / followUp 队列 | `agent.ts:125` | ✅ |
| 中断（AbortSignal） | 全程 | ✅ |
| 自定义消息类型（声明合并） | `types.ts:316` | ✅ |
| 换模型 / 换上下文 | `prepareNextTurn` | ✅ |
| 工具前后钩子（权限拦截、结果改写） | `beforeToolCall`/`afterToolCall` | ✅ |
| bash / read / edit / write 四个基础工具 | `harness/tools/` | ✅ 可直接用 |
| 上下文压缩 | `harness/compaction/` | ✅ 848 行 + 测试 |
| 会话持久化（JSONL） | `harness/session/` | ✅ 993 行一致性测试 |
| Skills / 提示词模板 | `harness/skills.ts`、`prompt-templates.ts` | ✅ |
| 执行环境抽象（本地/容器/远端） | `harness/env/` | ✅ 695 行 |
| 埋点 | `harness/telemetry.ts` | ✅ |

### `agent` **不能**给你

| 缺什么 | 后果 | 谁补 |
|---|---|---|
| **任何 UI** | 终端/Web/Slack 前端全自己写 | 你 |
| **配置系统** | model 得代码里硬写或自己读文件 | 你 |
| **凭证管理** | `getApiKey` 是空钩子（见 [provider-loading.md](provider-loading.md)） | 你 |
| **provider 目录 + 覆盖** | 得自己组 `Model` 对象 | 你，或抄 `model-runtime.ts` |
| **grep / find / ls 工具** | 只有 bash/read/edit/write | 你 |
| **权限确认交互** | 钩子有了，UI 没有 | 你 |
| **崩溃恢复 / 会话树 / 多 lane / 子 agent** | `AgentHarness` 22 方法 reject | **等 pi**，或按 `harness.md` 自己实现 |

### 关于 `harness/` 的成熟度——一个要点

> 📖 harness 的数据模型（Session / Lane / Entry / Record、树与分支、恢复流程）
> 单独记在 [harness-model.md](./harness-model.md)。

「pi 不用 harness」≠「harness 没做完」。**除顶层 `agent-harness.ts` 外全部是真实现**：

```
模块                       行数   未实现标记   测试
reducer.ts                  667      0        ✅
compaction/compaction.ts    848      0        ✅
session/（8 文件）          2000+     0        ✅ 含 993 行 conformance
skills.ts / prompt-templates 637      0        ✅
env/nodejs.ts               695      0        ✅
tools/                     1190      0        ✅
telemetry.ts                615      0        ✅
──────────────────────────────────────────────────
agent-harness.ts            508     22 处     ⚠️ scaffold
```

**积木都做好了，缺的是把它们串起来的指挥。** 上游（`v0.84.2`，比我们的锚点新 208 个提交）17 个 harness 提交全落在 `session/` 和新增的 `events.ts`，`reducer.ts` 与 `agent-harness.ts` **一个字未改**。

开发顺序自下而上，对应 `packages/agent/docs/harness.md`（上游新增的 2941 行规格书，v0.84.1 里没有）：

```
Part 1 Storage         ← 现在在这（session/ 在猛改）
Part 2 Tree            ← session/types.ts 在改
Part 3 State machine   ← reducer.ts，写好了但没接
Part 4 Recovery        ← 还没
Part 5 Public surface  ← agent-harness.ts，接口定了，实现全空
```

---

## 改造成自己的项目时的取舍

按「保留 / 替换 / 丢弃」分三档：

**直接复用（约 3.5 万行，自己写不划算）**
`ai` 全部 + `agent/agent-loop.ts` + `agent.ts` + `harness/{session,compaction,tools,env}`。协议适配和会话持久化是纯苦力活，没有产品特色。

**参考后重写（约 1.5 万行）**
`coding-agent/core/tools/` —— 工具集是产品定位的体现，你的场景大概率不是 coding。
`coding-agent/core/model-runtime.ts` + `provider-composer.ts` —— **凭证与 provider 组合逻辑值得整段抄**，`agent` 层没有替代品。
`coding-agent/core/agent-session.ts` —— 3342 行缝合层，逻辑要看懂但代码要自己写。

**多半用不上（约 5 万行）**
`tui` + `modes/interactive` + `package-manager` + `extensions`。除非也要做终端交互产品。

**⚠️ 不要动 `AgentHarness`** —— 半成品，接上去会跟着上游一起变。要崩溃恢复/会话树这些能力，按 `packages/agent/docs/harness.md` 自己实现，或者等它做完。

```
你的 agent = packages/ai                          原样用
           + packages/agent 的 Agent + agent-loop  原样用
           + harness/{tools, compaction, session}  挑着用
           + 抄一份 model-runtime 的凭证/provider 逻辑
           + 你自己的工具集      ← 产品定位在这
           + 你自己的前端        ← 最大工作量
```
