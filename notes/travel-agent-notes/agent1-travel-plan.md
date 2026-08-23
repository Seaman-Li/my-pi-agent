# Agent 1：智能旅行助手 —— 实施计划

> 目标不是复刻 [hello-agents 第十三章](https://github.com/datawhalechina/hello-agents/blob/main/docs/chapter13/%E7%AC%AC%E5%8D%81%E4%B8%89%E7%AB%A0%20%E6%99%BA%E8%83%BD%E6%97%85%E8%A1%8C%E5%8A%A9%E6%89%8B.md)，
> 是**用读 pi 两周学到的架构，从零手写一遍**。参考文档只借用「旅行助手」这个业务场景。
>
> 配套笔记就在同目录。每个阶段都标了对应哪一章——**卡住先回去翻笔记**。

---

## 零、已定的三件事

| | 选择 | 理由 |
|---|---|---|
| **语言** | **TypeScript** | 两周读的全是 TS；agent loop / tool / memory 这套代码 Agent 2 能直接复用；harness 只有 TS 版 |
| **交付形态** | **CLI + 自包含 HTML 报告** | 主线精力放在 agent 架构上；HTML 让产物「能给别人看」 |
| **架构** | **单 agent + 多 tool** | 和 pi 一致。参考文档那 4 个「专家 Agent」本质就是 4 次工具调用，套一层 agent 反而多绕一圈 |

### 和参考文档的差异（有意为之）

| | hello-agents ch13 | 本计划 |
|---|---|---|
| 语言 | Python | **TypeScript** |
| 框架 | HelloAgents + MCP | **零框架，手写** |
| 架构 | 4 专家 Agent + Planner 协调 | **1 个循环 + 6 个 tool** |
| 工具接入 | amap-mcp-server | **直接调高德 REST**（S8 再选做 MCP 对比） |
| 前端 | Vue3 + FastAPI | **CLI + 静态 HTML** |
| 流程 | 固定串行 | **模型自主决策调哪个、调几次** |

---

## 一、环境与选型

### 已经有的

```
Node   v22.22.1          支持 --experimental-strip-types，写 TS 直接跑，零构建
LLM    dashscope / qwen3.7-plus
       baseUrl  https://dashscope.aliyuncs.com/compatible-mode/v1
       api      openai-completions（OpenAI 兼容）
       key      security find-generic-password -ws pi-dashscope
       上下文    1,000,000   maxTokens 65,536
```

**1M 上下文意味着 S6 的压缩功能在这个项目里几乎用不上**——但还是要做，因为 Agent 2 需要，而且这是理解 harness 的必经之路。做的时候把阈值调低（比如 20k）来触发。

### 需要新申请的

| 服务 | 用途 | 备注 |
|---|---|---|
| **高德 Web 服务 API key** | POI 搜索、天气、静态地图 | [console.amap.com](https://console.amap.com/) 申请，选 **「Web服务」** 类型（不是 JS API）。个人免费额度够用 |
| Unsplash Access Key | 景点配图（可选，S5） | 免费版 50 次/小时 |

### 依赖（刻意保持极少）

```jsonc
{
  "dependencies": {
    "typebox": "*"        // 和 pi 一致，Static<typeof schema> 那套已经懂了
  }
}
```

**不装** LLM SDK、不装 HTTP 库、不装 agent 框架。
`fetch` 和 SSE 解析手写——**因为 [adapter-layer.md](./adapter-layer.md) 读了但没自己写过**。

---

## 二、目录结构

代码放在**兄弟目录**，笔记留在 PiAgent：

```
/Users/simonli/Downloads/MyProjects/
├── PiAgent/                    ← 笔记 + 本计划，不动
└── agent1-travel/              ← 新建
    ├── src/
    │   ├── llm/
    │   │   ├── types.ts        消息/事件/工具的类型定义      ≈ pi 的 ai/types.ts
    │   │   ├── stream.ts       fetch + SSE 解析 + 事件合成    ≈ pi 的 adapter 层
    │   │   └── config.ts       provider 配置 + 取 key
    │   ├── loop.ts             ★ agent loop 主体
    │   ├── tools/
    │   │   ├── types.ts        Tool 接口定义
    │   │   ├── registry.ts     工具注册表
    │   │   ├── amap.ts         高德 REST 封装（非 tool，纯 API 客户端）
    │   │   ├── search-poi.ts
    │   │   ├── weather.ts
    │   │   ├── hotel.ts
    │   │   ├── budget.ts
    │   │   └── save-plan.ts
    │   ├── session/
    │   │   ├── types.ts        Entry 定义
    │   │   └── store.ts        JSONL 读写
    │   ├── memory.ts           跨会话偏好
    │   ├── compaction.ts       上下文压缩
    │   ├── report.ts           生成 HTML
    │   └── cli.ts              入口
    ├── prompts/
    │   └── system.md
    ├── data/                   ← gitignore
    │   ├── sessions/*.jsonl
    │   └── memory.json
    └── out/                    ← 生成的 HTML 报告
```

---

## 三、八个阶段

**每个阶段结束都必须是可运行的东西。** 不允许「写完三个模块再一起跑」。

预计总量 **6–8 个半天**。

---

### S0 · 跑通一次 LLM 调用（半天）

> 对应笔记：[adapter-layer.md](./adapter-layer.md)、[provider-loading.md](./provider-loading.md)

**做什么**

1. `src/llm/config.ts` —— 读 provider 配置，从 keychain 取 key
   ```ts
   // 直接抄 pi 的思路：!command 前缀表示「执行这个命令拿输出」
   // security find-generic-password -ws pi-dashscope
   ```
2. `src/llm/types.ts` —— 先只定义三个：`UserMessage` / `AssistantMessage` / `Message`
3. `src/llm/stream.ts` —— **非流式**，`fetch` POST 到 `/chat/completions`，返回整段文本
4. `src/cli.ts` —— 读一行输入，打印回复

**验收**

```bash
node --experimental-strip-types src/cli.ts "你好"
# 输出模型回复
```

**要点**：这一步刻意不做流式。先确认 key、baseUrl、请求体格式都对，再加复杂度。

---

### S1 · 流式 + 事件（半天）

> 对应笔记：[adapter-layer.md](./adapter-layer.md) 响应方向那节、[agent-loop.md](./agent-loop.md) 第七节（emit）

**做什么**

1. `stream.ts` 改成 `stream: true`，手写 SSE 解析：
   ```
   逐块读 response.body → 按 \n\n 切 → 剥 "data: " 前缀 → 遇 [DONE] 结束
   ```
2. **合成事件**——这是关键，也是 pi 的 `openai-completions.ts` 干的事：
   ```
   OpenAI 的 chunk 里没有事件类型，只有 delta.content / delta.tool_calls / delta.reasoning_content
   → 靠「哪个字段非空」判断当前在输出什么
   → 自己造出 text_start / text_delta / text_end
   ```
3. 定义 `EventSink`：
   ```ts
   type EventSink = (event: AgentEvent) => Promise<void> | void;
   ```
   **注意返回类型写成联合**，理由见 [ts-notes 第 23 条](./ts-notes.md)
4. CLI 里逐字打印

**验收**

- 终端能看到逐字输出
- 三种 block（text / thinking / toolCall）都能正确识别边界
- 把 sink 换成一个 `await sleep(100)` 的版本，输出明显变慢 —— 但**变慢的原因不是背压**。
  Step 1 实测：pi-ai 的 `EventStream.push()` 是同步入队（`packages/ai/src/utils/event-stream.ts:22`），
  生产端不会因为 sink 慢而少读网络；慢 sink 下 producer 4.4s 就读完了，consumer 到 10.7s 才追上。
  `await sink()` 换来的是**按序交付 + 异步 sink 不浮空**，不是背压。真背压得自己消费 fetch body。

**要点**：`*_start` / `*_end` **是你自己造的**，OpenAI 那边没有。这一步做完，adapter-layer.md 就从「读过」变成「写过」。

---

### S2 · Agent Loop + 第一个工具（一天）★ 核心

> 对应笔记：[agent-loop.md](./agent-loop.md) 全文

**做什么**

1. `tools/types.ts` —— 抄 pi 的形状：
   ```ts
   interface Tool<S extends TSchema = TSchema> {
     name: string;
     description: string;        // 这两个直接发给 LLM
     parameters: S;
     execute(id: string, params: Static<S>, signal?: AbortSignal): Promise<ToolResult>;
   }
   interface ToolResult {
     content: { type: "text"; text: string }[];   // 给 LLM 看
     details?: unknown;                            // 给 UI / 报告看，不进上下文
   }
   ```
   **`content` / `details` 的二分从第一天就分清**，后面 HTML 报告全靠 `details`。

2. `loop.ts` —— **默认停，继续才需要理由**：
   ```ts
   let hasMoreToolCalls = true;                    // 进来先置真，为了至少跑一次
   while (hasMoreToolCalls) {
     hasMoreToolCalls = false;                     // 进循环体立刻打回假
     const response = await stream(model, context, { onEvent: emit });
     context.messages.push(response);
     const toolCalls = response.content.filter(c => c.type === "toolCall");
     if (toolCalls.length > 0) {
       const results = await executeTools(toolCalls);
       context.messages.push(...results);
       hasMoreToolCalls = true;
     }
   }
   ```

3. 工具参数校验：`Value.Convert` 先转换（`"5"` → `5`）**再** `Check`——模型经常把数字写成字符串

4. 第一个工具 `weather`（最简单，高德天气 API 一次调用出结果）

**验收**

```
> 成都明天天气怎么样
[tool] weather(成都) → 晴 12~24°C
成都明天晴，白天 24 度...
```

- 问「成都和重庆天气对比」→ **模型自己发两次 toolCall**
- 故意让工具抛错 → 循环不崩，错误进 toolResult 回灌给模型

**要点**：`execute` 里**不写 try/catch**，抛出去由循环包成 error 结果。这是 pi 的约定，照抄。

---

### S3 · 工具集补齐（一天）

> 对应笔记：[architecture-map.md](./architecture-map.md) `tools/` 那节

**做什么**

`tools/amap.ts` 先封一层高德 REST 客户端（**不是 tool**，纯 HTTP）：

| 高德接口 | 用途 |
|---|---|
| `/v3/place/text` | POI 搜索（景点、酒店、餐厅） |
| `/v3/weather/weatherInfo` | 天气（`extensions=all` 拿预报） |
| `/v3/staticmap` | 静态地图图片（S5 用） |

> 参数细节以[官方文档](https://lbs.amap.com/api/webservice/summary)为准，写的时候对一遍。

然后是 6 个 tool：

| tool | 参数 | 返回 content | 返回 details |
|---|---|---|---|
| `search_poi` | `{ city, keyword, type?, limit? }` | 精简列表文本 | 完整 POI 数组（含经纬度） |
| `weather` | `{ city, days? }` | 文本 | 结构化预报 |
| `search_hotel` | `{ city, area?, priceLevel? }` | 精简列表 | 完整酒店数组 |
| `estimate_budget` | `{ items: [...] }` | 总额 + 分类 | 明细表 |
| `save_plan` | `{ plan: TripPlan }` | "已保存" | 完整 plan |
| `web_search`（可选） | `{ query }` | 摘要 | 原始结果 |

**三个必须做的工程细节**（都是 pi 里踩过的坑）：

1. **输出截断** —— POI 搜索能返回几十条，全塞进上下文很贵。
   参考 `truncate.ts`：双限制（行数 / 字节数）谁先撞谁生效，**永不返回半行**
2. **`content` 精简，`details` 完整** —— 给模型看的只要「名称 + 地址 + 门票」，
   经纬度和图片 URL 放 `details`，HTML 报告去取
3. **参数描述写在 schema 里**：
   ```ts
   Type.String({ description: "城市名，如「成都」。不要带「市」字" })
   ```
   这段文字会直接发给模型——**它是 prompt 的一部分**

**验收**

```
> 帮我规划 3 天成都行程，预算 3000，喜欢历史文化，不爱爬山
```

模型自主完成：搜景点 → 查天气 → 找酒店 → 算预算 → 输出 Markdown 行程。
**你没有写任何流程编排代码**——这就是单 agent + 多 tool 和多 agent 协作的区别。

---

### S4 · 结构化产出 + HTML 报告（一天）

**做什么**

1. `TripPlan` 类型（用 typebox 定义，同时得到运行时校验 + TS 类型）：
   ```
   Location → Attraction / Meal / Hotel → DayPlan → TripPlan
   ```
   层次直接借参考文档的，那部分设计是合理的

2. `save_plan` 工具接收完整 `TripPlan`——**让模型把结果吐成结构化数据，而不是解析它的 Markdown**

3. `report.ts` 生成自包含 HTML：
   - 行程概览 + 预算表
   - 每日行程卡片
   - 高德静态地图（`/v3/staticmap` 返回图片，标注当天景点）
   - 天气条
   - **全部内联**，一个文件双击能开

**验收**

- `out/成都-3天-2026xxxx.html` 双击打开完整可读
- 断网也能看（图片用 data URI 内嵌，或接受地图图片失效）

**要点**：不要写 Vue/React。模板字符串拼 HTML 就够，200 行以内。

---

### S5 · 会话持久化（半天）

> 对应笔记：[harness-model.md](./harness-model.md) 第一~六节

**做什么**

**只做 Entry 树，不做 Record 带子。**

```ts
interface EntryBase { type: string; id: string; seq: number; parentId: string | null; timestamp: number }
type Entry = MessageEntry | ModelChangeEntry | CompactionEntry | CustomEntry;
```

- JSONL 一行一条，append-only
- `id` 用 `crypto.randomUUID()`（想对齐 pi 就实现个 uuidv7，时间有序）
- 一个「当前 leafId」指针
- 取上下文 = 沿 `parentId` 回溯再反转
- CLI 加 `--resume <sessionId>`

**验收**

- 退出重进，历史还在
- 手动改 JSONL 加一条 entry，重进能看到
- **`parentId` 链断了要报错**，别静默跳过

**要点**：**先不做 lane、不做 record、不做崩溃恢复。** 那些是 Agent 2 的事。
这一步只要「树 + 一个指针」，就已经比大多数玩具 agent 强了。

---

### S6 · Memory（半天）

**做什么**

区分两种记忆——**这是 memory 这个词最容易含混的地方**：

| | 存哪 | 生命周期 | 怎么进上下文 |
|---|---|---|---|
| **会话内记忆** | Entry 树 | 单次会话 | 天然就在（S5 已完成） |
| **跨会话记忆** | `data/memory.json` | 永久 | 每轮拼进 system prompt |

跨会话记忆存什么：

```jsonc
{
  "preferences": ["喜欢历史文化景点", "不爱爬山", "预算敏感"],
  "visited": [{ "city": "成都", "date": "2026-03", "planPath": "out/xxx.html" }],
  "constraints": ["素食", "不坐红眼航班"]
}
```

两个写入口：

1. **显式** —— `remember` 工具，模型觉得该记就调
2. **隐式** —— 每次会话结束跑一次抽取，把新偏好并进去

**验收**

- 第一次说「我不爱爬山」
- 新开会话规划另一个城市 → **它不推荐爬山景点**
- `memory.json` 人能看懂、能手改

**要点**：memory 不是越多越好。**每条都占 system prompt 的 token**，
设个上限（比如 20 条），超了让模型自己合并。

---

### S7 · 上下文压缩（半天）

> 对应笔记：[harness-model.md](./harness-model.md) 第十一节②

**做什么**

抄 pi 的三行判定：

```ts
function shouldCompact(contextTokens: number, contextWindow: number, reserveTokens = 16384): boolean {
  return contextTokens > contextWindow - reserveTokens;
}
```

压缩产物是**一条 `CompactionEntry`**：

```ts
{ type: "compaction", summary: string, retainedTail: Message[], tokensBefore: number }
```

取上下文时**不读过压缩点**：

```ts
// 从后往前找最近的 compaction，找到就从它切
return compaction === undefined ? entries : [compaction, ...entries.slice(idx + 1)];
```

三个触发原因：`manual`（`/compact`）/ `threshold` / `overflow`。
**防死循环的闸必须做**：压完还超就别再压。

**验收**

- 阈值调到 20k（qwen 的 1M 上下文平时压不到）
- 连续追问十几轮触发压缩
- **压缩后追问前面的细节，它还答得上来** ← 检验摘要质量
- JSONL 里能看到那条 `compaction` entry

---

### S8 · 打磨（半天，选做）

按需挑：

| 项 | 对应 pi 的什么 |
|---|---|
| Ctrl-C 中断（`AbortSignal` 传到 fetch 和 tool） | `agent-loop.ts` 的 signal 贯穿 |
| 429 / 网络错误自动重试（指数退避） | `compaction.ts` 的 `completeSimpleWithRetries` |
| 工具执行前确认（写文件类的） | `beforeToolCall` hook |
| 并行工具调用（`Promise.all`） | `executeToolCallsParallel` |
| 改用高德 MCP server 接入 | 和直接 REST 对比，理解 MCP 多了/少了什么 |

---

## 四、和 Agent 2 的复用边界

**写 Agent 1 时就按这个边界组织代码**，别到时候再拆：

```
✅ 直接搬到 Agent 2
   src/llm/          整个目录（类型、SSE 解析、provider 配置）
   src/loop.ts       agent loop 主体
   src/tools/types.ts + registry.ts
   src/session/      Entry 树
   src/compaction.ts

🔄 换实现，接口不变
   tools/*.ts        旅行工具 → read/write/edit/bash/grep
   report.ts         HTML 报告 → diff 渲染
   memory.ts         旅行偏好 → 代码库约定

➕ Agent 2 才加
   Record 带子 + 崩溃恢复      harness-model.md 第七、八节
   Lane 多游标                 第五、六节
   Hook 注册表                 第十二节
   权限系统
```

> **判断标准：如果一个模块 import 了「旅行」相关的东西，它就在第二类或第三类。
> `src/llm/` 和 `src/loop.ts` 里不应该出现「城市」「景点」这些词。**

---

## 五、不做什么（明确划掉）

| 不做 | 为什么 |
|---|---|
| Vue / React 前端 | 工作量最大且跟 agent 架构无关 |
| FastAPI / Express 后端 | CLI 就够，要 Web 时再加一层薄壳 |
| 多 agent 编排 | 单 agent + 多 tool 已经能解决这个问题 |
| RAG / 向量库 | 旅行信息实时性 > 检索，直接调 API 更对 |
| Record 带子 / 崩溃恢复 | 留给 Agent 2 |
| Lane / 会话分支 | 留给 Agent 2 |
| 自己实现 tokenizer | 用字符数估算（pi 也是这么干的，`estimateTokens`） |

---

## 六、进度追踪

| 阶段 | 产物 | 预计 | 状态 |
|---|---|---|---|
| S0 | 能跑通一次调用 | 半天 | ☐ |
| S1 | 流式 + 事件 | 半天 | ☐ |
| S2 | **agent loop + 第一个工具** | 一天 | ☐ |
| S3 | 6 个工具，能出行程 | 一天 | ☐ |
| S4 | HTML 报告 | 一天 | ☐ |
| S5 | 会话持久化 | 半天 | ☐ |
| S6 | 跨会话 memory | 半天 | ☐ |
| S7 | 上下文压缩 | 半天 | ☐ |
| S8 | 打磨（选做） | 半天 | ☐ |

**卡住超过 40 分钟就跳过、记进笔记、往下走。** 和读 pi 时一条规则。

---

## 七、开新 session 时的第一句话

建议这样起手，把上下文一次交代清楚：

```
读 /Users/simonli/Downloads/MyProjects/PiAgent/notes/agent1-travel-plan.md，
从 S0 开始。代码写在 /Users/simonli/Downloads/MyProjects/agent1-travel/。
架构疑问先查同目录下的其他笔记（那是我读 pi 源码两周的产出）。
```
