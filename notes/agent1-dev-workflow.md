# Agent 1：文件结构与开发流程

> 配套 [agent1-travel-plan.md](./agent1-travel-plan.md)。那份定「做什么」,这份定「怎么组织、怎么一次对话一次对话地推」。
> **约束**:每次对话产出的代码 ≤ 500 行,300 行左右最佳。

---

## 一、复用边界:provider 层直接用 pi-ai

`@earendil-works/pi-ai` 已发布到 npm(0.84.2)。适配层不自己写。

```jsonc
{
  "dependencies": {
    "@earendil-works/pi-ai": "0.84.2"   // 版本钉死,不用 ^
  }
}
```

### 它给你什么

| 拿来即用 | 来源 |
|---|---|
| `Message` / `UserMessage` / `AssistantMessage` / `ToolResultMessage` | `packages/ai/src/types.ts:407-448` |
| `Context { systemPrompt?, messages, tools? }` | `types.ts:502` |
| `Tool { name, description, parameters }`(typebox schema) | `types.ts:495` |
| `AssistantMessageEvent` —— 14 种事件,`text_*`/`thinking_*`/`toolcall_*`/`done`/`error` | `types.ts:516` |
| `StopReason` / `Usage` / `ToolCall` / `Model<Api>` | `types.ts` |
| `streamSimple(model, context, options)` —— 一个函数,SSE 解析 + 事件合成全在里面 | `api/openai-completions.ts:616` |
| `Type` / `Static` / `TSchema`(转出的 typebox) | `index.ts` |
| `uuidv7()` / `retry` / `validation` / `overflow` 小工具 | `utils/` |

调用长这样(**这就是全部的 provider 代码**):

```ts
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model, Context } from "@earendil-works/pi-ai";

const model: Model<"openai-completions"> = {
  id: "qwen3.7-plus", name: "Qwen 3.7 Plus",
  api: "openai-completions", provider: "dashscope",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  reasoning: true, input: ["text"],
  contextWindow: 1_000_000, maxTokens: 65_536,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const stream = streamSimple(model, context, { apiKey, signal });
for await (const event of stream) { /* 14 种事件 */ }
```

用 `api/openai-completions` 这个深路径而不是 `/compat`:只加载 OpenAI 兼容那一条路径,不会把 anthropic/google/bedrock 的 SDK 一起拽起来。

### 相应地,原计划的 S0/S1 作废

「手写 fetch + SSE 解析 + 事件合成」这一天从计划里删掉。省下的时间加到 S2(loop)和 S6/S7。

**代价要认**:pi-ai 的 `dependencies` 里有 anthropic/google/mistral/bedrock/openai 五套 SDK,`npm i` 会很大。用不上但装着。既然不关注适配层,这个价可以付。

### 边界铁律

**pi-ai 的类型可以到处用,但只有 `core/model.ts` 能 import 它的函数。**
loop、tool、session、feature 一律不许直接调 `streamSimple`——它们只认 `core/model.ts` 导出的 `stream(ctx, opts)`。
换模型/换 provider/以后想自己写适配层,都只动那一个文件。

---

## 二、文件结构

```
agent1-travel/
├── package.json              deps 只有 pi-ai
├── tsconfig.json             只为编辑器,不参与运行
├── DEVELOPMENT.md            ← 本文件,进项目根
├── BACKLOG.md                冒出来的新想法丢这,当次不做
├── README.md                 每个 Step 的验收命令表
├── prompts/
│   └── system.md
├── src/
│   ├── core/                 ★ 通用层,不含任何「旅行」字样,Agent 2 直接搬
│   │   ├── types.ts          Tool / ToolResult / StepContext / Hook 上下文
│   │   ├── model.ts          模型配置 + 取 key + 唯一的 pi-ai 调用点
│   │   ├── registry.ts       工具注册表
│   │   ├── hooks.ts          Hook 注册表(4 个挂载点)
│   │   └── loop.ts           ★ agent loop —— Step 2 之后只读
│   ├── session/
│   │   ├── types.ts          Entry 定义
│   │   └── store.ts          JSONL append-only + parentId 回溯
│   ├── features/             ★ 一个文件 = 一块积木,只通过 hooks 挂进去
│   │   ├── memory.ts         S6
│   │   └── compaction.ts     S7
│   ├── tools/                ★ 旅行域
│   │   ├── amap.ts           高德 REST 客户端(不是 tool)
│   │   ├── truncate.ts       双限制截断
│   │   ├── weather.ts
│   │   ├── search-poi.ts
│   │   ├── search-hotel.ts
│   │   ├── estimate-budget.ts
│   │   └── save-plan.ts
│   ├── report.ts             TripPlan → 自包含 HTML
│   ├── compose.ts            ★ 唯一接线处
│   └── cli.ts                入口
├── data/                     gitignore:sessions/*.jsonl, memory.json
└── out/                      gitignore:生成的 HTML
```

### 三层依赖方向(只允许往下)

```
cli.ts / compose.ts          ← 知道一切
   ↓
features/  tools/  report.ts ← 知道 core,不知道彼此
   ↓
core/  session/              ← 什么都不知道
```

**自查命令**(每个 Step 收尾跑一次,应该无输出):

```sh
grep -rn "城市\|景点\|旅行\|trip\|amap" src/core src/session   # core 被污染了
grep -rn "from \"\.\./features\|from \"\.\./tools" src/core     # 依赖倒挂
grep -rn "streamSimple\|pi-ai/api" src/ --include=*.ts | grep -v "core/model.ts"  # 绕过 provider 边界
```

### 两个关键文件的形状(现在只定接口,不写实现)

```ts
// core/hooks.ts —— 全部内容不超过 60 行
export interface Hooks {
  beforeStep:     ((c: StepContext) => Promise<void> | void)[];        // 改模型看到的东西
  beforeToolCall: ((c: ToolCallContext) => Promise<ToolResult | void>)[]; // 返回值 = 拦截
  afterToolCall:  ((c: AfterToolContext) => Promise<void> | void)[];
  afterStep:      ((c: StepContext) => Promise<void> | void)[];        // 压缩判定在这
}
```

```ts
// compose.ts —— 唯一接线处,加一块积木 = 加一行
export function compose(opts: ComposeOptions) {
  const hooks = emptyHooks();
  const tools = new Registry();
  registerTravelTools(tools, opts);
  if (opts.memory)     installMemory(hooks, tools, opts);   // Step 6
  if (opts.compaction) installCompaction(hooks, opts);      // Step 7
  return { hooks, tools };
}
```

`compose.ts` 里的 `if` 才是真正的「拼积木」——git 分支只能线性叠加,验证「只开 memory 不开压缩」得靠开关。

### 运行方式:零构建

Node v22.22.1 原生剥类型,不需要 tsc、不需要 bundler:

```sh
node src/cli.ts "你好"          # 22.18+ 默认开启;报错就加 --experimental-strip-types
```

代价是**只能用可擦除语法**:相对 import 必须写全 `.ts` 后缀;不许 `enum`、`namespace`、构造函数参数属性。踩到了就换写法,不要为此上构建。

---

## 三、开发流程

### 三级单位

| 单位 | 是什么 | 边界 |
|---|---|---|
| **Step** | 一次对话 = 一个 Step = 一个 commit | **≤500 行,目标 300** |
| **分支** | 若干 Step,跑得起来的一个版本 | 验收通过 → merge 进 main + 打 tag |
| **main** | 只有验收通过的版本 | 永远能跑 |

```
main ──┬── v1-chat        (Step 1-2)  能对话、能调工具
       ├── v2-tools       (Step 3-4)  6 个工具 + HTML 报告
       ├── v3-session     (Step 5)    Entry 树 + --resume
       ├── v4-memory      (Step 6)    跨会话偏好
       └── v5-compaction  (Step 7)    上下文压缩
```

叠加式:`v2` 从 `v1` merge 后的 main 开出来。每个分支自带 README 里的一行验收命令。

### Step 清单

| # | 分支 | 做什么 | 行数 | 验收命令 |
|---|---|---|---|---|
| 1 | v1-chat | `core/types.ts` + `core/model.ts` + 最小 `cli.ts`,直出 pi-ai 事件流 | ~250 | `node src/cli.ts "你好"` 逐字输出 |
| 2 | v1-chat | `hooks.ts` + `registry.ts` + **`loop.ts`** + `tools/weather.ts` + `compose.ts` | ~350 | `node src/cli.ts "成都和重庆明天天气对比"` → 两次 toolCall |
| 3 | v2-tools | `tools/amap.ts` + `truncate.ts` + POI/酒店/预算 4 个 tool | ~350 | `node src/cli.ts "3天成都,预算3000,爱历史不爱爬山"` |
| 4 | v2-tools | `TripPlan` schema + `save_plan` + `report.ts` | ~300 | `out/*.html` 双击可读 |
| 5 | v3-session | `session/types.ts` + `store.ts` + `--resume` | ~300 | 退出重进,历史还在 |
| 6 | v4-memory | `features/memory.ts` + `remember` tool | ~250 | 新会话不推荐爬山 |
| 7 | v5-compaction | `features/compaction.ts`(阈值调到 20k) | ~250 | JSONL 里出现 compaction entry |

合计约 2050 行。超预算的 Step 当场拆成 a/b 两次对话,不要硬塞。

### 每次对话的固定协议

**开场**(直接复制,只改 Step 号):

```
读 /Users/simonli/Downloads/MyProjects/agent1-travel/DEVELOPMENT.md,执行 Step N。
只改 Step N 列的文件。写完跑验收命令并贴输出。
新想法记进 BACKLOG.md,不当场做。
```

**收尾三件事**:

1. `git diff --stat` —— 超 500 行说明拆错了,停下来拆
2. 跑**本 Step 的验收命令 + 之前所有 Step 的验收命令**(它们都只要几秒)—— 防回归,这就是测试
3. `git commit -m "stepN(scope): ..."` —— 不 push

### 红线

- **一次对话只做一个 Step。** 顺手改别的 = 下次 diff 读不懂 = 分支不再是干净的积木
- **Step 2 之后 `core/loop.ts` 只读。** 想改它说明缺 hook —— 先加 hook 再挂功能。合并前 `git diff main -- src/core/loop.ts` 应为空(Step 2 除外)
- **不提前抽象。** 第二次出现同一个形状才抽
- **不装计划外的依赖、不动 tsconfig、不 push。** 需要时先说
- 卡住超 40 分钟 → 记进 BACKLOG.md,跳过,往下走

### README.md 长这样

一张表,每行是一个已完成 Step 的验收命令。收尾时从上到下跑一遍。

```md
| Step | 命令 | 期望 |
|---|---|---|
| 1 | `node src/cli.ts "你好"` | 逐字输出模型回复 |
| 2 | `node src/cli.ts "成都和重庆明天天气对比"` | 两次 [tool] weather |
```

---

## 四、开工前要确认的两件事

1. **高德 Web 服务 key** —— Step 3 卡这。[console.amap.com](https://console.amap.com/) 申请,选「Web服务」不是「JS API」
2. **dashscope key 的取法** —— 沿用 pi 的 `!command` 约定:`security find-generic-password -ws pi-dashscope`。`core/model.ts` 里读

两件都不影响 Step 1-2(Step 2 的 weather 可以先返回假数据跑通循环)。
