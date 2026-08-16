# agent-loop.ts —— 主循环

> Day 5 产出。`packages/agent/src/agent-loop.ts`（796 行），基于 `v0.84.1`。
> 796 行里主循环 `runLoop` 只占 120 行（155–275），其余 670 行是工具执行的展开。

## 一、数据类型 recap

读循环前必须先分清这几个类型，否则 120 行代码看不懂。分三组。

### 组 1：消息 —— 循环搬运的东西（`ai/src/types.ts`）

```ts
type Message = UserMessage | AssistantMessage | ToolResultMessage;   // :448
```

三元可辨识联合，判别字段是 `role`：

| 类型 | 行 | `content` 的形状 | 关键字段 |
|---|---|---|---|
| `UserMessage` | 407 | `string \| (Text\|Image)[]` | — |
| `AssistantMessage` | 413 | `(Text \| Thinking \| **ToolCall**)[]` | `stopReason`、`usage`、`model` |
| `ToolResultMessage` | 430 | `(Text \| Image)[]` | `toolCallId`、`toolName`、`isError` |

**只有 `AssistantMessage.content` 里能出现 `ToolCall`。** 这一条决定了整个循环的终止判定——见第三节。

```ts
type StopReason =                                          // :391
  "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
```

七个值里循环只认三个：`error` / `aborted`（提前退出）、`length`（工具参数可能被截断）。**`stop` 和 `toolUse` 一次都没被判断过**——这是最反直觉的一点。

`ToolResultMessage.toolCallId` 是回灌的关键：模型靠它把结果对回自己发的哪个调用。

### 组 2：agent 层的扩展（`agent/src/types.ts`）

```ts
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];  // :325
```

开放式联合。`CustomAgentMessages` 默认是空 interface（:316），宿主用**声明合并**往里加自己的消息类型（如 UI 通知、artifact），循环照样搬运。见 [ts-notes.md](ts-notes.md) 第 12 条。

```ts
interface AgentContext {          // :412   —— 喂给模型的三件套
  systemPrompt: string;
  messages: AgentMessage[];       // 会被 push，也会被整体替换
  tools?: AgentTool<any>[];
}
```

注意 `AgentContext`（循环内部用）和 `AgentState`（:333，对外暴露）是两个东西。后者用 getter/setter 保证赋值时复制数组，还带 `isStreaming`、`pendingToolCalls` 等 UI 用的只读状态。

```ts
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any>
  extends Tool<TParameters> {                                          // :386
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;  // 校验前的兼容垫片
  execute: (toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";                  // 单个工具可强制串行
}
```

`execute` 的注释写得很明确：**"Throw on failure instead of encoding errors in `content`"**——工具作者只管抛，循环负责兜。

```ts
interface AgentToolResult<T> {    // :361
  content: (TextContent | ImageContent)[];   // 回给模型看的
  details: T;                                // 给 UI/日志看的，模型看不到
  addedToolNames?: string[];                 // 此结果之后新增可用的工具
  terminate?: boolean;                       // 请求提前终止（要全票才生效）
}
```

`content` vs `details` 的分工值得记：**同一次工具执行，给模型的和给界面的是两份数据。** bash 工具给模型返回截断后的文本，给 UI 返回完整输出 + 退出码。

### 组 3：配置与钩子（`AgentLoopConfig`，:149）

这是宿主注入行为的唯一入口。除 `model`/`convertToLlm` 外全是可选钩子：

| 钩子 | 行 | 在循环哪一步被调 | 干什么 |
|---|---|---|---|
| `convertToLlm` | 178 | 每次请求前 | **必填**。`AgentMessage[]` → `Message[]`，扔掉自定义消息 |
| `transformContext` | 200 | 请求前 | 改上下文（压缩就挂这） |
| `getApiKey` | 210 | 请求前 | 每轮重新取，为了过期 token |
| `beforeToolCall` | 277 | 工具执行前 | **权限确认**，可 `block` |
| `afterToolCall` | 292 | 工具执行后 | 改写结果 |
| `shouldStopAfterTurn` | 222 | 每轮末 | 强制停 |
| `prepareNextTurn` | 229 | 每轮末 | **换模型 / 换上下文** |
| `getSteeringMessages` | 244 | 每轮末 | 用户中途插话 |
| `getFollowUpMessages` | 257 | 内层退出后 | 用户在"本该结束"时又说话 |

`AgentEvent`（:428）是 12 种事件的可辨识联合，四个生命周期层次：

```
agent_start / agent_end                              整次运行
turn_start / turn_end                                一轮
message_start / message_update / message_end         一条消息
tool_execution_start / _update / _end                一次工具调用
```

**只有 `message_*` 会落盘到 JSONL**，其余是纯 UI 事件。

---

## 二、流程图

```
runAgentLoop(prompts, ...)                                          :95
  │  emit agent_start                                               :109
  │  emit turn_start                                                :110
  │  for prompt: emit message_start / message_end                   :111  ← user 消息在循环外
  ▼
runLoop()                                                           :155
  │  pendingMessages = getSteeringMessages?.()                      :167
  ▼
┌─ while (true) ────────────────────────────────── 外层：等人说话 ──┐  :170
│  hasMoreToolCalls = true                                          │  :171
│                                                                   │
│ ┌─ while (hasMoreToolCalls || pendingMessages.length) ─ 内层 ────┐│  :174
│ │                                                                ││
│ │  firstTurn ? skip : emit turn_start                            ││  :175
│ │                                                                ││
│ │  ┌ pendingMessages 非空？                                      ││  :182
│ │  │   emit message_start/_end，push 进 context 和 newMessages   ││  :184
│ │  └   pendingMessages = []                                      ││  :189
│ │                                                                ││
│ │  ┌──────────────────────────────────────────────┐              ││
│ │  │ streamAssistantResponse()              :281  │              ││  :193
│ │  │   transformContext?()                  :291  │              ││
│ │  │   convertToLlm()   AgentMessage→Message :295 │              ││
│ │  │   getApiKey?()     每轮重取             :306 │              ││
│ │  │   streamFunction() ← 唯一的 LLM 调用    :308 │              ││
│ │  │   for await (event of response):       :317  │              ││
│ │  │     start   → push 占位，emit message_start  │              ││
│ │  │     *_delta → 原地替换，emit message_update  │              ││
│ │  │     done    → result()，emit message_end     │              ││
│ │  └──────────────────────────────────────────────┘              ││
│ │  newMessages.push(message)                                     ││  :194
│ │                                                                ││
│ │  ┌ stopReason === "error" | "aborted" ?                        ││  :196
│ │  └─→ emit turn_end + agent_end, RETURN            ◀── 出口 ③   ││  :199
│ │                                                                ││
│ │  toolCalls = message.content.filter(type === "toolCall")       ││  :203
│ │  hasMoreToolCalls = false          ← 默认就是停                ││  :206
│ │                                                                ││
│ │  ┌ toolCalls.length > 0 ?                                      ││  :207
│ │  │   stopReason === "length"                                   ││  :212
│ │  │     ? failToolCallsFromTruncatedMessage()  全部判错  :381   ││
│ │  │     : executeToolCalls()                            :411   ││
│ │  │   hasMoreToolCalls = !batch.terminate      ◀── 出口 ②       ││  :216
│ │  └   toolResults 双写 context + newMessages                    ││  :218
│ │                                                                ││
│ │  emit turn_end                                                 ││  :224
│ │  prepareNextTurn?.()  → 可换 context / model / thinkingLevel   ││  :232
│ │                                                                ││
│ │  ┌ shouldStopAfterTurn?.() ?                                   ││  :247
│ │  └─→ emit agent_end, RETURN                       ◀── 出口 ④   ││  :255
│ │                                                                ││
│ │  pendingMessages = getSteeringMessages?.()                     ││  :259
│ └────────────────────────── 无 toolCall → 条件为假，退出 ◀ 出口 ①┘│
│                                                                   │
│  followUp = getFollowUpMessages?.()                               │  :263
│  非空 → pendingMessages = followUp; continue ───────── 回到外层  │  :266
│  空   → break                                                     │  :271
└───────────────────────────────────────────────────────────────────┘
   emit agent_end                                                      :274
```

### 工具执行的展开（`executeToolCalls`，:411）

```
executeToolCalls()                                                  :411
  │  任一工具 executionMode === "sequential"，或 config 要求串行？    :419
  ├─ 是 → executeToolCallsSequential()                              :433
  └─ 否 → executeToolCallsParallel()                                :489

三段式（两条路径共用）：
  prepareToolCall()          :600   找工具 → prepareArguments → 校验 schema → beforeToolCall
       ├─ kind: "immediate"        失败/被拦，直接成结果，不执行
       └─ kind: "prepared"         通过
  executePreparedToolCall()  :670   tool.execute()，try/catch 包住
  finalizeExecutedToolCall() :713   afterToolCall 改写结果
```

**并行分支里有个容易看漏的设计**（:499–542）：`for` 循环里 `await prepareToolCall(...)` 是**串行**的，只有 `execute` 被包成 thunk 推进数组，最后统一 `Promise.all`。

```ts
finalizedCalls.push(async () => { ... });   // :522  只推函数，不执行
const ordered = await Promise.all(          // :540  此刻才并发
  finalizedCalls.map(e => typeof e === "function" ? e() : Promise.resolve(e)));
```

**准备阶段串行、执行阶段并行。** 因为 `beforeToolCall` 是权限确认——不可能同时弹三个确认框。而 `Promise.all` 保序，所以 `toolResults` 的顺序永远等于模型发出调用的顺序，与谁先执行完无关。

---

## 三、四条终止路径

日程表写的"assistant 不再带 toolCall"是主干，实际有四个出口：

| # | 行 | 触发条件 | 会不会跑 `prepareNextTurn` |
|---|---|---|---|
| ① | 206 → 174 | `content` 里 filter 不出 `toolCall` | 会 |
| ② | 216 + 583 | **全部**工具都返回 `terminate: true` | 会 |
| ③ | 196 | `stopReason` 是 `error` / `aborted` | **不会**，提前 return |
| ④ | 247 | `shouldStopAfterTurn` 返回真 | 会 |

出口 ① 的实现方式值得注意：

```ts
hasMoreToolCalls = false;                        // :206  无条件先置假
if (toolCalls.length > 0) {
    hasMoreToolCalls = !executedToolBatch.terminate;   // :216  只有这里能翻回真
}
```

**默认是停，继续才需要理由。** 而理由只有一个：这一轮发了工具调用，且没有全票要求终止。

出口 ② 的 `every` 是关键：

```ts
// :582
function shouldTerminateToolBatch(finalizedCalls) {
  return finalizedCalls.length > 0 && finalizedCalls.every(f => f.result.terminate === true);
}
```

**一批里只要有一个工具没要求终止，循环就继续。** 单个工具无法单方面掐断整个 agent。

### `stopReason` 基本不参与判定

```bash
grep -n 'stopReason' packages/agent/src/agent-loop.ts
# 196:  === "error" || === "aborted"
# 212:  === "length"
```

`"stop"` 和 `"toolUse"` 一次都没出现。**终止不看模型"说"自己停了，只看它有没有实际发出工具调用**——纯结构判定，不信任语义标记。这样即使某家厂商的 `stopReason` 映射不准，循环行为也不受影响。

`"length"` 那条分支的注释解释得很好（:208–210）：流式工具参数用的是尽力而为的 JSON 抢救解析，被 token 上限截断的消息**可能产出「能解析、能过校验、但内容悄悄不完整」的工具调用**。所以整批判错，让模型重发。

---

## 四、错误哲学：循环内一次都不 throw

```
createErrorToolResult() 的 8 个调用点：
  395  截断消息的工具调用      648/629  中断
  611  工具不存在              664  参数校验/prepareArguments 抛异常
  637  被 beforeToolCall 拦截  705  tool.execute() 抛异常
                               748  afterToolCall 抛异常
```

而全文件 `throw` 只有 4 处（71 / 75 / 128 / 132），**全在入口函数的入参校验里，一处都不在循环内**。

> **工具的任何失败都不是异常，是喂回模型的一条消息。**

工具不存在、参数不合法、执行崩了、被权限拦了——统统变成 `role: "toolResult"` 的文本塞回上下文，模型自己看着办。程序永不崩，模型自己重试。这是 agent 与普通程序在错误处理哲学上的根本分野：**普通程序里异常向上传播找 handler；agent 里异常向下传播回模型。**

`executePreparedToolCall` 的 try/catch/finally（:678–710）还有个细节：

```ts
let acceptingUpdates = true;
try   { ... acceptingUpdates = false; await Promise.all(updateEvents); return {result, isError:false}; }
catch { acceptingUpdates = false; await Promise.all(updateEvents); return {result: createErrorToolResult(...), isError:true}; }
finally { acceptingUpdates = false; }
```

异常路径也要先关掉更新接收、再把已排队的事件排空——**保证出错时发出的事件序列和正常时一样完整**，UI 不会卡在半截状态。

---

## 五、逐行对照 JSONL 验证

会话文件（7 行，正好一轮工具调用）：

```bash
~/.pi/agent/sessions/--Users-simonli-Downloads-MyProjects-PiAgent--/2026-08-12T17-47-49-253Z_*.jsonl
```

| JSONL 行 | 内容 | 由哪段代码产生 |
|---|---|---|
| 1–3 | `session` / `model_change` / `thinking_level_change` | 会话元数据，非循环产物 |
| 4 | `user [text]` | `runAgentLoop:111`，**在循环外**预推 |
| 5 | `assistant [thinking, toolCall(bash)]` `stopReason=toolUse` | `runLoop:193` |
| 6 | `toolResult [text]` | `runLoop:214` 执行 → `:218` 回灌 |
| 7 | `assistant [thinking, text]` `stopReason=stop` | `runLoop:193`，`:203` filter 出空数组 → `:206` 保持 false → 内层退出 |

第 7 行的 `stopReason=stop` 是被忽略的；真正让循环停下的是 `content` 里 filter 不出 `toolCall`。

**JSONL 里只有 message 事件**——`turn_start`、`message_update`、`tool_execution_*` 都不落盘。所以第 5、6 行之间那一长串流式更新在文件里完全看不到。要看全量事件得挂 `emit` 钩子。

查看命令：

```bash
node -e '
const fs=require("fs");
fs.readFileSync(process.argv[1],"utf8").trim().split("\n").forEach((l,i)=>{
  const o=JSON.parse(l), m=o.message||o;
  const k=Array.isArray(m.content)?m.content.map(c=>c.type+(c.type==="toolCall"?`(${c.name})`:"")).join(","):typeof m.content;
  console.log(`${i+1}: ${o.type} role=${m.role||"-"} stop=${m.stopReason||"-"} [${k}]`);
});' <会话文件>
```

---

## 六、双写机制

工具结果和转向消息都会 push 进**两个**数组：

```ts
currentContext.messages.push(result);   // :219  喂给下一轮 LLM
newMessages.push(result);               // :220  返回给调用方持久化
```

不是引用共享，是真双写。原因在 :234：

```ts
currentContext = nextTurnSnapshot.context ?? currentContext;   // 整体替换
```

`prepareNextTurn` 可以把 `currentContext` **换成另一个对象**（上下文压缩就是这么做的：把 20 条消息换成 1 条摘要）。此时 `newMessages` 必须保留完整原始记录，两者从此分道扬镳。

**`currentContext.messages` = 模型看到的（可被压缩/裁剪）；`newMessages` = 真实发生的（完整落盘）。**

---

## 七、`emit` 为什么是回调而不是 `yield`

```ts
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;   // :25
```

一个回调，由调用方传入。循环每到一个节点就调一次，不关心谁在接。（这个箭头是**函数类型**不是 lambda，见 [ts-notes.md](ts-notes.md) 第 17 条。）

### 为什么不用 generator

事件产生的位置很深：

```
runLoop                        :155  turn_start / turn_end
 └ streamAssistantResponse     :281  message_start / _update / _end
 └ executeToolCalls            :411
    └ executeToolCallsParallel :489  tool_execution_start
       └ executePreparedToolCall :670  tool_execution_update
       └ emitToolExecutionEnd    :767  tool_execution_end
```

`emit` 在文件里出现 55 次，作为参数出现在 9 个函数签名上。改成 generator 意味着**这 9 个函数全部变成 `async function*`**，每层都要写 `yield*` 委托，漏一个事件就丢；而且 `executeToolCalls` 既要产事件又要返回 `ExecutedToolCallBatch`，`AsyncGenerator<Event, Result>` 的双返回值类型会很难看。

**传一个回调值，比把整条调用链改造成 generator 便宜得多。**

### push 与 pull 的差别，落到三点

| | `yield` | `emit` |
|---|---|---|
| 驱动方 | 消费者（拉） | 生产者（推） |
| 等不等 | 必须等 `next()` | **由接收方决定** |
| 反向控制 | 有（`break`/`throw` 能回传） | **没有** |

第二点容易误解。循环里每处都是 `await emit(...)`，**背压是有的**，但等多久取决于 sink 怎么实现：

```ts
(event) => this.processEvents(event)        // agent.ts:418  真 async，有背压
async (event) => { stream.push(event) }     // agent-loop.ts:44  push 同步返回，等于没等
```

第三点才是本质差别。generator 的 `yield` 是双向管道，消费者 `break` 会触发 `return()` 终结生产者。回调只能单向出：

```ts
const stream = agentLoop(prompts, ctx, cfg, signal, streamFn);
for await (const event of stream) { break; }   // 循环照跑不误
```

`agentLoop:40` 那个 `void` 已经把循环点火并放手，跑不跑跟谁在消费无关。

### 所以 `signal` 必须单独走一条线

```bash
grep -c "signal: AbortSignal | undefined," agent-loop.ts   # 12
grep -c "emit: AgentEventSink," agent-loop.ts              #  9
```

`signal` 传得比 `emit` 还深——有些只做计算不发事件的函数也得能被打断。

```
       ┌──────────────┐
       │    调用方     │
       └──┬────────▲──┘
   signal │        │ emit
  （控制进）│        │（事件出）
       ┌──▼────────┴──┐
       │    runLoop    │
       └───────────────┘
```

> `yield` 是**一根双向管道**；`emit` 是**一个单向喇叭**，所以旁边必须再挂一根 `signal` 才能听见外面喊停。

**`AbortSignal` 的存在本身，就是选择 push 模型付出的代价。**

### 推转拉的适配器就在仓库里

`agentLoop`（:31）把 push 转成 pull，实现是 `ai/src/utils/event-stream.ts`（60 行）：

```ts
push(event) {                                       // :21  推的一端
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });   // 有人在等 → 直接给
    else this.queue.push(event);                         // 没人等 → 排队
}

async *[Symbol.asyncIterator]() {                   // :50  拉的一端
    while (true) {
        if (this.queue.length > 0) yield this.queue.shift()!;
        else if (this.done) return;
        else { const r = await new Promise(res => this.waiting.push(res)); ... }
    }
}
```

**队列 + 等待者数组**，push→pull 适配器的标准写法。注意 `push` 返回 `void` 且队列无上限——**这条路径没有背压**，消费慢了事件会在内存里堆积。CLI 量级无所谓，改造成长跑服务时要留意。

---

## 待跟进

- [ ] `agent.ts`（592）如何包装 `runLoop` 并维护 `AgentState`
- [ ] `harness/reducer.ts`（667）如何把 `AgentEvent` 归约成状态 —— Day 6
- [ ] `transformContext` 挂载的压缩逻辑 `harness/compaction/`（1128）—— Day 6
