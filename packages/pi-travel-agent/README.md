# pi-travel-agent

用 pi 的架构从零手写的旅行助手。计划和笔记在
[`notes/travel-agent-notes/`](../../notes/travel-agent-notes/)：
[实施计划](../../notes/travel-agent-notes/agent1-travel-plan.md) ·
[文件结构与开发流程](../../notes/travel-agent-notes/agent1-dev-workflow.md)。

## 跑

```sh
cd packages/pi-travel-agent
node src/cli.ts "成都三天怎么玩"
```

零构建：Node 22.18+ 直接跑 `.ts`。`@earendil-works/pi-ai` 走 workspace 里的
`packages/ai`，不需要额外 `npm install`。

模型：dashscope `qwen3.7-plus`。key 取自 keychain
（`security find-generic-password -ws pi-dashscope`），换模型 id 用 `TRAVEL_MODEL_ID`。

## 验收表

每次对话收尾从上往下跑一遍，防回归。

| Step | 命令 | 期望 |
|---|---|---|
| 1 | `node src/cli.ts "你好，用一句话介绍你自己"` | 逐字输出回复，末行打印 in/out token 和 stopReason |
| 1 | `node src/cli.ts --thinking "北京到成都坐高铁大概多久"` | 先出灰色 `[思考]` 段，再出正文 |
| 1 | `node src/cli.ts --model nope "x"` | 报「未知模型」，退出码 1 |

## 目录

```
src/
├── core/          通用层，不出现「旅行」字样，Agent 2 直接搬
│   ├── types.ts   对外事件 AgentEvent / EventSink
│   └── model.ts   ★ 唯一 import pi-ai 函数的文件
└── cli.ts         入口
```

三层依赖只许往下：`cli/compose` → `features/tools/report` → `core/session`。
自查（应无输出）：

```sh
grep -rn "城市\|景点\|旅行\|trip\|amap" src/core
grep -rn "streamSimple\|pi-ai/api" src --include=*.ts | grep -v "core/model.ts"
```
