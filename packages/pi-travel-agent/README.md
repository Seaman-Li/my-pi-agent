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

配置在 `.env`（`cp .env.example .env`，不进 git）：模型 id、baseUrl、上下文窗口、
以及**取 key 的方式**（`!<cmd>` 执行命令 / `env:<NAME>` 读环境变量）——存的是取法，不是 key 本身。
dashscope 的 OpenAI 兼容差异不在 .env 里：那是协议事实，写死在 `src/core/model.ts`。

## 验收表

每次对话收尾从上往下跑一遍，防回归。

| Step | 命令 | 期望 |
|---|---|---|
| 1 | `node src/cli.ts "你好，用一句话介绍你自己"` | 逐字输出回复，末行打印 in/out token 和 stopReason |
| 1 | `node src/cli.ts --thinking "北京到成都坐高铁大概多久"` | 先出灰色 `[思考]` 段，再出正文 |
| 1 | `node src/cli.ts --model nope "x"` | 报「未知模型」，退出码 1 |
| 1 | `mv .env .env.bak && node src/cli.ts hi; mv .env.bak .env` | 报「缺少环境变量 TRAVEL_MODEL_ID」 |
| 2a | `node src/cli.ts "成都和重庆明天天气怎么样，对比一下"` | 两次 `[tool] weather(...)`，末行 `2 step / end completed` |
| 2b | `node src/cli.ts --trace "成都明天天气怎么样"` | stderr 出现 `beforeStep`/`beforeToolCall`/`afterToolCall`/`afterStep` 四种 hook 行 |
| 2b | `node src/cli.ts "成都明天天气怎么样"` | 不带 `--trace` 时输出和 2a 一致，没有 hook 行 |
| 3a | `node src/cli.ts "成都有哪些值得去的历史景点，明天天气怎么样"` | 真数据：POI 带评分/地址，天气带日期，`[假数据]` 前缀消失 |
| 3a | `node --input-type=module -e 'process.loadEnvFile("./.env"); import { fetchForecast } from "./src/tools/amap.ts"; try { await fetchForecast("火星") } catch (e) { console.log(e.message) }'` | 报「查不到城市」，**消息里没有 key** |

## 目录

```
src/
├── core/          通用层，不出现「旅行」字样，Agent 2 直接搬
│   ├── types.ts   Tool / ToolResult / AgentEvent / EventSink / TurnEndReason / textOf
│   ├── model.ts   ★ 唯一 import pi-ai 函数的文件
│   ├── registry.ts 工具注册表
│   ├── hooks.ts   四个挂载点 + 串接规则
│   └── loop.ts    ★ agent loop —— 只读，想改它说明缺 hook
├── features/      一个文件 = 一块积木，只通过 hooks 挂进去
│   └── trace.ts   --trace，Step 9 扩成完整版
├── tools/         旅行域
│   ├── amap.ts    高德 REST 客户端（不是 tool）★ key 只在这里出现
│   ├── truncate.ts 双限制截断，永不返回半行
│   ├── weather.ts
│   └── search-poi.ts
├── compose.ts     ★ 唯一装配处，加一块积木 = 加一行
└── cli.ts         入口
```

三层依赖只许往下：`cli/compose` → `features/tools/report` → `core/session`。
自查（应无输出）：

```sh
grep -rn "城市\|景点\|旅行\|trip\|amap" src/core | grep -vE ':[0-9]+:\s*(\*|//|/\*)'   # 域污染（跳过注释）
grep -rn '^import ' src | grep '@earendil-works/pi-ai' | grep -v 'import type'          # pi-ai 值导入
grep -rn 'AMAP_KEY\|restapi.amap.com' src | grep -v 'tools/amap.ts'                     # key 和 URL 只许待在 amap.ts
find src -name '*.ts' -exec sh -c 'head -1 "$1" | grep -q "^/\*\*" || echo "缺文件头: $1"' _ {} \;
find src -name '*.ts' -exec awk '/^(export )?(async )?function /{ if (prev !~ /\*\//) print FILENAME":"FNR": 缺注释 "$0 } { prev=$0 }' {} \;
```

- **文件头**：第一行写职责（一句话 + 层 + 边界，上限 8 行）。写不出一句话职责，就是该拆的信号。
- **函数注释**：每个函数都要有，会抛就写 `@throws`。判据是「说代码没说的东西」——
  复述函数名的注释算负资产。
