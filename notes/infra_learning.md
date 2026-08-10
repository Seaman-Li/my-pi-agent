# Pi Monorepo 架构笔记

> **来源**：由 pi 自己生成（直接对话让它总结架构）。
> **状态**：已人工核对，原文保留，错误处就地标注为 `> ⚠️ 实测修正`。
>
> 核对结论：骨架（分层、依赖、数据流、构建顺序）全部正确；三处细节有误，均为**推断性断言**而非从文件读取的事实。详见 [agent-factcheck.md](agent-factcheck.md)。

## 概述

Pi 是一个 TypeScript monorepo，核心是一个 AI 编码代理（coding agent）。所有包共享版本号 `0.84.1`，采用 lockstep 版本管理。

## 包依赖层次（自底向上）

```
Layer 0 (基础设施)
├── tui          — 终端 UI 库，差分渲染，布局系统，键盘/编辑器组件
├── telemetry    — 厂商中立的遥测契约和类型化 schema 工具
└── protocol     — 传输中立的 CBOR 协议，用于远程 pi 会话（帧编码、schema）

Layer 1 (AI 核心)
└── ai           — 统一 LLM API，自动模型发现，多 provider 支持
                   (OpenAI, Anthropic, Bedrock, Gemini, xAI, OpenRouter 等)
                   包含 OAuth、模型注册表、图像模型支持

Layer 2 (代理框架)
└── agent        — 通用代理核心：代理循环、状态管理、传输抽象、附件支持
                   依赖: ai, telemetry

Layer 3 (传输/会话)
├── client       — 传输中立的远程会话客户端（基于 CBOR 字节帧）
├── server       — 实验性服务端，暴露代理会话
└── session-backends/sqlite-node  — Node.js SQLite 会话持久化后端

Layer 4 (应用层)
├── coding-agent — 编码代理 CLI，提供 read/bash/edit/write 工具
│                  包含：扩展系统、配置管理、TUI 集成、RPC 入口
│                  依赖: agent, ai, client, protocol, tui
└── evals        — 评估框架（私有包），用于跑 benchmark/评测
```

> ⚠️ **实测修正 1 — `server` 的依赖**
> 原文把 `server` 归入 Layer 3「暴露代理会话」。实测 `server` 依赖 `ai` + `protocol`，**不依赖 `agent`**。
> 核对命令：`python3 -c "import json;print(json.load(open('packages/server/package.json'))['dependencies'])"`

> ⚠️ **实测修正 2 — 工具不只在 coding-agent 层**
> 原文写「`coding-agent` 提供 read/bash/edit/write 工具」，暗示工具只在应用层。实际**两层各有一套独立实现**，文件名大量重叠：
>
> | 文件 | `agent/src/harness/tools/` | `coding-agent/src/core/tools/` |
> |---|---|---|
> | `read.ts` | 144 行 | 356 行 |
> | `bash.ts` | 161 行 | 508 行 |
> | `edit.ts` | 127 行 | 441 行 |
> | `write.ts` | 39 行 | 272 行 |
>
> **不是包装关系**：`coding-agent/src/core/tools/read.ts` 只从 agent 包 import 了 `AgentTool` 类型，实现独立重写，额外引入语法高亮、图片处理、键位提示等 UI 依赖。coding-agent 层另有 `find` / `grep` / `ls` 三个 agent 层没有的工具。
>
> **这个差异是理解分层的关键**：agent 层是不带 UI 的最小实现，coding-agent 层是面向终端产品的完整版。「为什么要写两套」比「工具在哪」有价值得多 —— 列入 Day 7 的问题清单。

## 核心三层依赖图

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: coding-agent (应用层)                              │
│  ─────────────────────────────────────────────────────────  │
│  职责: 编码代理 CLI，提供具体工具 (read/bash/edit/write)    │
│        扩展系统、配置管理、TUI 集成、RPC 入口               │
│  输入: 用户自然语言指令                                     │
│  输出: 文件修改、命令执行、对话回复                         │
└──────────────────────────┬──────────────────────────────────┘
                           │ 调用
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: agent (代理框架层)                                 │
│  ─────────────────────────────────────────────────────────  │
│  职责: 通用代理循环、状态管理、传输抽象、附件支持           │
│        定义工具接口，编排 LLM 调用与工具执行的循环          │
│  输入: 工具定义 + 用户消息                                  │
│  输出: 工具调用序列 + 最终响应                              │
└──────────────────────────┬──────────────────────────────────┘
                           │ 调用
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: ai (AI 核心层)                                     │
│  ─────────────────────────────────────────────────────────  │
│  职责: 统一 LLM API，多 provider 抽象                       │
│        模型发现、OAuth 认证、请求/响应标准化                │
│        支持: OpenAI, Anthropic, Bedrock, Gemini, xAI 等     │
│  输入: 标准化的消息格式                                     │
│  输出: LLM 流式/非流式响应                                  │
└─────────────────────────────────────────────────────────────┘
```

**数据流**: 用户输入 → `coding-agent` (解析意图、选择工具) → `agent` (编排循环) → `ai` (调用 LLM) → 响应逐层返回

## 关键设计特点

### 1. 传输中立

`protocol` 用 CBOR 帧编码，`client` 通过 Unix socket 等传输连接远程会话，使代理可以本地运行也可以远程运行。

### 2. 多 Provider 抽象

`ai` 包提供统一接口，支持多个 LLM 提供商，带自动模型发现和 OAuth 认证。模型元数据通过代码生成 (`models.generated.ts`)。

> ⚠️ **实测修正 3 — 模型元数据的真实来源**
> 「通过代码生成」只说对了一半。真正的数据源是 `packages/ai/src/providers/data/*.json`，而这个目录**被 `.gitignore` 忽略**（见 `.gitignore:11`），由 `npm run build` **每次联网从各家 provider 拉取**。
>
> 后果：你拿到的永远是「锚定版本的代码 + 今天的数据」。这正是本仓库唯一那个测试失败的根因（`openai-completions-tool-choice.test.ts`），详见 [../LEARNING-PLAN.md](../LEARNING-PLAN.md) 的「测试基线」一节。
>
> 设计取舍：模型元数据是**外部易变输入**，pi 选择不锁进版本控制而是每次刷新。代价就是旧代码配新数据可能对不上。做自己的 agent 时会面对同样的选择。

### 3. 可扩展性

`coding-agent` 有完整的扩展系统 (`extensions/`)，支持自定义 provider、沙箱等。

### 4. TUI 独立

`tui` 是一个独立的终端 UI 库，带差分渲染、布局引擎、模糊搜索、LaTeX 渲染等，不绑定具体业务逻辑。

### 5. 会话持久化

通过 `session-backends` 子包实现，当前有 SQLite Node.js 后端，架构上可插拔。

## 构建顺序

```
tui → telemetry → ai → agent → sqlite-node → protocol → client → server → coding-agent
```

这反映了上面的依赖层次，底层包先构建。

## 各包职责速查

| 包名 | 描述 |
|------|------|
| `tui` | 终端 UI 库，差分渲染，布局系统 |
| `telemetry` | 遥测契约和 schema 工具 |
| `protocol` | CBOR 帧协议 |
| `ai` | 统一 LLM API，多 provider |
| `agent` | 代理循环、状态管理 |
| `client` | 远程会话客户端 |
| `server` | 实验性服务端 |
| `session-backends/sqlite-node` | SQLite 会话持久化 |
| `coding-agent` | 编码代理 CLI（最终产品） |
| `evals` | 评估框架（私有） |

## 文档阅读笔记

### README.md

- 项目自称 "Pi agent harness"，核心是 self extensible coding agent
- 三个核心包：`coding-agent`（CLI）、`agent-core`（运行时）、`ai`（LLM API）
- 代理默认以用户权限运行，无内建权限系统；沙箱方案通过扩展实现（Gondolin、Docker、OpenShell）
- 长期规划在 RFCs: https://rfc.earendil.com/keyword/pi/

### packages/coding-agent/docs/index.md（文档导航，最有价值）

按主题分类的文档目录，揭示了系统功能边界：

| 主题 | 关键文档 | 架构价值 |
|------|----------|----------|
| 使用 | `usage.md`, `sessions.md`, `compaction.md` | 交互模式、会话管理、上下文压缩 |
| 扩展 | `extensions.md`, `skills.md`, `prompt-templates.md` | 代理的可扩展机制 |
| 集成 | `sdk.md`, `rpc.md`, `json.md` | 编程嵌入、stdin/stdout JSONL、结构化事件流 |
| 内部 | `session-format.md`, `environment-variables.md` | JSONL 会话格式、SessionManager API — agent 状态持久化关键 |
| 定制 | `custom-provider.md`, `models.md` | ai 层的 provider 抽象 |

### AGENTS.md（开发规则，隐含架构事实）

- 多 agent 并发：多个 pi session 可同时在一个 cwd 运行，各自修改不同文件 — 会话隔离是文件级的
- 测试架构：`test/suite/harness.ts` + faux provider，不用真实 API key — agent 层有完整 mock 测试框架
- 供应链安全：shrinkwrap、lifecycle script allowlist、exact pinning — coding-agent 作为 npm 全局包分发，对传递依赖严格控制

### packages/coding-agent/docs/packages.md（插件生态架构）

- 包可包含 4 类资源：extensions（TypeScript 模块）、skills（SKILL.md）、prompts（模板）、themes（JSON）
- 三种来源：npm（版本化）、git（ref 固定）、本地路径
- 包在 `package.json` 的 `pi` 字段声明资源，或用约定目录自动发现
- 核心包（`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`）作为 `peerDependencies` 共享，不重复打包
- 全局 vs 项目级设置，项目级优先
