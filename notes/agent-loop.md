# agent-loop.ts —— 主循环

> Day 5 产出。`packages/agent/src/agent-loop.ts`（796 行），基于 `v0.84.1`。
> 796 行里主循环 `runLoop` 只占 120 行（155–275），其余 670 行是工具执行的展开。

## 零、五个验收问题的答案

[STUDY-SCHEDULE.md](../STUDY-SCHEDULE.md) Day 5 要求回答的五个问题。细节见后面各节。

### ① 循环在什么条件下继续？

**只有 `hasMoreToolCalls`。** 条件里的第二项 `pendingMessages` 是人塞进来的（steering），不是循环自己的推进力。

```ts
let hasMoreToolCalls = true;                              // :171  外层进来先置真，为了至少跑一次
    hasMoreToolCalls = false;                             // :206  进循环体立刻打回假
    if (toolCalls.length > 0)
        hasMoreToolCalls = !executedToolBatch.terminate;  // :216  唯一能翻回真的地方
```

> **默认是停。继续才需要理由，而理由只有一个：这一轮发出了工具调用，且没有全票要求终止。**

这比 `if (有工具调用) continue` 更稳——**新增任何代码路径都不会意外让循环续跑**。

### ② 什么条件下终止？

四条出口，详见[第三节](#三四条终止路径)。要点：

- **出口 ① 无 toolCall** 是日常 99%
- **出口 ② `terminate` 内置工具一个都不用**——唯一生产者是扩展（`extensions/types.ts:1079`），且注释限定 *"when this call is blocked"*
- **`stopReason` 的 7 个值里循环只判断 3 个**，`"stop"` 和 `"toolUse"` 一次都没出现

> 终止不看模型「说」自己停了，只看它**有没有实际发出工具调用**——纯结构判定，不信任语义标记。

即使某家厂商的 `finish_reason` 映射不准（`openai-completions.ts:578` 就在给不返回 `finish_reason` 的端点兜底），循环行为也不受影响。

### ③ 工具结果怎么回灌？

```ts
currentContext.messages.push(result);   // :219  喂给下一轮 LLM
newMessages.push(result);               // :220  返回给调用方持久化
```

**双写，不是引用共享。** 因为 `:234` 的 `prepareNextTurn` 能把 `currentContext` 整体换掉（压缩把 20 条换成 1 条摘要），此刻 `newMessages` 必须保住原始记录。详见[第六节](#六双写机制)。

回灌内容带 `toolCallId`——模型靠它把结果对回自己发的哪个调用。

### ④ 出错怎么处理？

**8 处转成消息，4 处 `throw` 全在入口校验（71/75/128/132），循环内一次不抛。** 详见[第四节](#四错误哲学循环内一次都不-throw)。

```
普通程序：异常向上传播，找 handler
agent：  异常向下传播，回模型
```

⚠️ **这条保护只覆盖工具。** 事件消费者的错误没有——`agent.ts:589` 的 listener 循环裸奔，一个 UI 订阅者抛异常会让整次运行被判定为失败，`errorMessage` 写进 assistant 消息，**看起来像模型出错了**。订阅者必须自己 try/catch，这个契约代码里没写。

### ⑤ 中断怎么处理？

**走一条和 `emit` 完全独立的通道，且传得更深。**

```bash
grep -c "signal: AbortSignal | undefined," agent-loop.ts   # 12
grep -c "emit: AgentEventSink," agent-loop.ts              #  9
```

原因见[第七节](#七emit-为什么是回调而不是-yield)：`emit` 是回调，只能单向出。

三个检查点：

```
① adapter 层         fetch 收到 signal → 断开 → stopReason = "aborted"
② :196               循环发现 aborted → emit turn_end + agent_end → return（出口 ③）
③ :478/516/535/629/648   工具执行的各个缝隙 → "Operation aborted" 消息
```

第三类值得注意：**工具执行到一半按 Esc 不是抛异常**，还是走 `createErrorToolResult("Operation aborted")`，和其他错误一个待遇。串行分支 `:478` 每执行完一个检查一次，中断后 `break`——**已完成的结果保留，未开始的不再执行**。

别和 steering 混：

| | 触发 | 当前工作 | 循环 |
|---|---|---|---|
| **steering** | 打字回车 | **正常跑完** | 继续，下一轮注入 |
| **abort** | Esc | **被打断** | 出口 ③ 退出 |

steering 的注释写得很明确：*"injected after the current assistant turn finishes"*——**它不是中断**。

### 五条串起来

```
继续  ← 默认停，唯一理由是「发了工具调用」
终止  ← 四条出口，主干是结构判定而非语义标记
回灌  ← 双写，因为模型看的和真实发生的会分叉
出错  ← 转成消息回喂模型，程序不崩（但只覆盖工具）
中断  ← 独立的 signal 通道，因为 push 模型没有反向管道
```

> **这五条合起来定义了一件事：循环把「不确定性」全部推给模型，自己只保证结构正确。**

它不判断内容对不对、不处理语义、不做重试策略——错误变成上下文，继续与否看结构，人要插话给通道，人要喊停给信号。796 行里真正的「逻辑」只有 120 行，剩下的全是把这四类信号可靠地传下去。

---

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

### 速览：一步一句

```
① prompts + emit（在 runLoop 外）                       :109-114
   ↓
┌─ 外层 while(true) ───────────────────────────────────── :170
│ ┌─ 内层 while(hasMoreToolCalls || pending) ──────────── :174
│ │
│ │ ② 注入 pendingMessages（steering 插队）               :182
│ │
│ │ ③ transformContext?()   上下文压缩挂这                :291
│ │ ④ convertToLlm()        AgentMessage[] → Message[]    :295  ← 唯一转换点，单向
│ │ ⑤ getApiKey?()          每轮重取（过期 token）        :306
│ │ ⑥ 调 LLM + 消费事件流 + emit                          :308-371
│ │ ⑦ newMessages.push(message)                           :194  ← 无转换，见下
│ │
│ │ ⑧ error / aborted？→ 提前 return             出口③    :196
│ │ ⑨ filter 出 toolCalls                                 :203
│ │ ⑩ hasMoreToolCalls = false（默认停）                  :206
│ │ ⑪ 有工具 → 执行 → 双写回灌                            :207-222
│ │      hasMoreToolCalls = !terminate          出口②     :216  ← 真正的续跑判定
│ │ ⑫ prepareNextTurn?()    换上下文 / 换模型              :232
│ │ ⑬ shouldStopAfterTurn?() → return           出口④     :247
│ │ ⑭ 采集 steering → pendingMessages                     :259
│ └──────────── 无 toolCall → 条件为假，退出    出口①
│ ⑮ getFollowUpMessages?() 非空 → continue 回外层         :263
└────────────────────────────────────────────────────────
```

**⚠️ 转换是单向的。** 没有「把 LLM 返回的消息转回 AgentMessage」这一步——因为它本来就是：

```ts
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];   // agent/types.ts:325
type Message      = UserMessage | AssistantMessage | ToolResultMessage;          // ai/types.ts:448
```

`AssistantMessage` ⊂ `Message` ⊂ `AgentMessage`，所以 `:194` 是裸 push。全仓 grep `convertFromLlm` / `fromLlm` / `toAgentMessage` **零结果**。

`convertToLlm` 的作用是**扔掉**而不是转换——把宿主通过声明合并加进来的自定义消息（UI 通知、artifact）滤掉，LLM 不认识它们。回来的只有三种标准 role，天然合法。这就是文件头那句的含义：

```ts
* Agent loop that works with AgentMessage throughout.
* Transforms to Message[] only at the LLM call boundary.
```

**另注意**：`currentContext.messages` / `newMessages` 是**累积的对话记录**（只增不减）；`steeringQueue` / `followUpQueue` 才是**队列**（drain 一次就空）。两者性质不同，别混称。

### 完整版：带全部行号


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

### 我自己那版的一次完整 trace（pi-travel-agent，Step 2b）

四个挂载点全挂上 trace 之后跑一次，整个 turn 的骨架就直接摊在终端上了。
这段是 Step 2b 当时的输出，`weather` 还是假数据（真接口是 3a 才换的）：

```
$ node src/cli.ts --trace "成都和重庆明天天气怎么样，对比一下"

[trace] beforeStep  #1  messages=1
[tool] weather({"city":"成都","days":1})
[trace] beforeToolCall  #1  weather {"city":"成都","days":1}
[trace] afterToolCall   #1  weather ok [假数据] 成都未来1天:第1天 多云 14~22°C
  → [假数据] 成都未来1天:第1天 多云 14~22°C (5ms)
[tool] weather({"city":"重庆","days":1})
[trace] beforeToolCall  #1  weather {"city":"重庆","days":1}
[trace] afterToolCall   #1  weather ok [假数据] 重庆未来1天:第1天 阴 13~20°C
  → [假数据] 重庆未来1天:第1天 阴 13~20°C (1ms)
[trace] afterStep   #1  stop=toolUse content=[toolCall,toolCall] out=75 tools=2
[trace] beforeStep  #2  messages=4
**成都明天：** 多云，14~22°C
**重庆明天：** 阴，13~20°C
（对比略）
[trace] afterStep   #2  stop=stop content=[text] out=73 tools=0
[qwen3.7-plus] 2 step / in 942 / out 148 / end completed
```

**四条 trace 行对应 `loop.ts` 的四个调用点**：`:193` / `:122` / `:157` / `:200`。
`[tool]` 和 `→` 那两行不是 hook，是 `EventSink` 的 `tool_start` / `tool_end`
（走 stdout），trace 走 stderr。

从这十几行能直接读出四件事：

**① step 的粒度是「一次模型请求 + 它要的工具」，不是「一次工具调用」。**
两次 `beforeToolCall` 都打 `#1` —— 同一步里的两次调用。

**② `content=[toolCall,toolCall]` 说明模型一次回复就要了两个工具。**
两个城市的天气互不依赖，所以能批量。换成有依赖的问法
（「先查成都，如果是多云再查重庆」），同样两个城市会变成 **3 个 step**，
每步一个 toolCall —— 第二次调用的参数取决于第一次的结果，模型没法提前发。
**没有一行代码决定顺序，是模型看依赖关系自己排的**，这就是单 agent + 多 tool
和固定编排的分界。

**③ `messages=1 → 4`。** 一个 step 往上下文里加了 3 条：
1 条 assistant（带两个 toolCall）+ 2 条 toolResult。

**④ 末行的 `in 942` 是两个 step 的 input 之和，按计费算对，
但它不等于「上下文有多大」** —— system prompt 和 tool schema 被重复计了两次。
真正的上下文大小是最后一次请求的 input。压缩判定要用后者。

> **订正**：这段 trace 最初打出来时，`afterStep #1` 出现在两个 `[tool]` **之前**。
> 那是挂载点位置写错了 —— 文件头写着「step = 一次模型请求 + 它要的工具」，
> 而 `runAfterStep` 却调在工具执行之前，等于在 step 中间触发。
> 对它的认领者（Step 7 压缩判定）是实质问题：工具输出往往是上下文里最大的一块，
> 在工具执行前判定等于每次都少看了这一步最重的部分。
> 已挪到循环体末尾，并给 `AfterStepContext` 加了 `results`；
> turn 结束那条路径也补了一次调用，保证**每个 step 恰好触发一次**。
> —— 是这段 trace 本身把这个 bug 显出来的，这也是 trace 值得第一个做的理由。

### 拦截：`kind: "immediate"` 与我自己那版的 `ToolCallOverride`

上面三段式里 `prepareToolCall` 的 `kind: "immediate"` 是**拦截出口**——三种情况共用它，
都是"直接成结果，不执行"：

1. 工具没找到（模型编了个不存在的名字）
2. schema 校验失败
3. `beforeToolCall` 主动拦下

我在 pi-travel-agent 里写的是同一个形状的最小版（`src/core/hooks.ts` + `loop.ts:121`）：

```ts
export interface ToolCallOverride {
	result: ToolResult;    // content(给模型看) + details
	isError?: boolean;
}

// loop 里
const override = await runBeforeToolCall(hooks, { step, toolCall });
if (override) { /* 用它当结果，工具不执行 */ }
else if (!tool) { /* 没有名为 X 的工具 */ }
else { /* tool.execute(...) */ }
```

三处值得记：

**① 为什么包一层而不是直接返回结果。** 拦截有两种语义，`isError` 区分：
guard 拒绝要 `true`（模型得知道自己被挡了，才可能换参数重试或如实告诉用户），
缓存命中要 `false`（它就是个正常结果）。只返回 `ToolResult` 表达不了这个差别。

**② 被拦的调用仍然必须产出一条 `toolResult`。** 这不是设计选择，是协议要求——
assistant 消息里每个 `tool_call` 的 id，下一次请求必须有配对的 tool 消息，少一条整个请求不合法。
所以拦截**不能是"跳过"**，只能是"换个结果"。`ToolCallOverride` 这个类型的存在就是逼你面对这件事。

**③ 短路：第一个返回值的赢，后面的 handler 不再跑。**
拦截是单点决策，两个 handler 同时说"我来给结果"没有合理的合并方式；
只观察不拦截的 handler 什么都别返回。这正是 dsh 里 waterfall
"调 `next()` 是委派、不调是短路"的最小版本。

实测（临时挂一个"重庆不许查"的拦截器）：

```
toolResult(isError=false): [假数据] 成都未来1天:第1天 多云 14~22°C
toolResult(isError=true):  拒绝:重庆不在服务范围内
assistant: 成都明天多云 14~22°C。不过很抱歉，重庆不在我的服务范围内…
```

工具没跑，模型收到拒绝，自己把这件事解释给用户听了。
Step 8b 的路径限制、域名白名单、调用预算，全是这个形状。

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

## 八、读这份代码该从哪个方向进

Day 5 反复撞的一个坑：**自底向上读依赖注入的代码，物理上看不到答案。**

```ts
config.getApiKey ? await config.getApiKey(...) : undefined      // :306
```

这行里**没有任何信息**能告诉你 `getApiKey` 是什么。往上找 `createLoopConfig` → `this.getApiKey` → `runtimeOptions.getApiKey` → **还是看不到**，因为那是构造函数参数。必须跳到 `sdk.ts:294` 才看见「根本没传」。

**这不是四跳阅读，是四次跳空。** 而且这是依赖注入的固有性质，不是读法问题。

### 分场景的规则

| 你想搞清楚 | 方向 | 起手动作 |
|---|---|---|
| **某个值 / 配置从哪来** | **自顶向下** | 先 `grep` 注入点 |
| 某个机制怎么运作 | 自底向上 | 直接读，`runLoop` 是自足的 |

`runLoop` 的 120 行是**自足**的——终止条件、双写、错误转换全在文件里，自底向上读没问题。

而 `getApiKey` / `streamFn` / `terminate` / `shouldStopAfterTurn` 这些**注入点**，自底向上必然晕，因为答案按设计就不在那里。

### 可操作判据

看到一个**参数或可选字段**，先别顺着读，问「谁给的」：

```bash
grep -rn "new Agent(" packages/*/src          # → sdk.ts:294，全仓唯一生产调用点
grep -rn "setDefaultStreamFn" packages/*/src
grep -rn "\.getApiKey =" packages/*/src
```

**三秒钟能省十分钟跳空。** 这和 [agent-factcheck.md](agent-factcheck.md) 案例 3 的防御是同一个动作。

### 为什么这个库特别容易踩

七个「符号存在 ≠ 主路径在用」的实例，**全部**是自底向上读时撞上的。不是巧合：

> **一个同时做产品和 SDK 的库，底层看到的是「所有可能性」，顶层才是「实际选择」。**

底层每个扩展点都留了「你自己来」和「我帮你办」两条路（`streamFn ?? getDefaultStreamFn()`、`providerOptions.apiKey ?? resolution.auth.apiKey`、两套 tools），而 pi 自己**一律走后者**。

### 闭包让依赖在类型上隐身

更深一层的原因：`sdk.ts:302` 传下来的是**闭包**，捕获了 `modelRuntime` / `settingsManager` / `extensionRunnerRef`，但 `StreamFn` 的签名里这三个都不出现。

```ts
type StreamFn = (model, context, options?) => AssistantMessageEventStream | Promise<...>;
//               ↑ 没有 ModelRuntime，没有 SettingsManager
```

所以 `:308` 那行代码里，**被捕获的依赖是不可见的**——你看到一个函数调用，看不出它背后连着凭证解析、重试策略、扩展钩子。这不是写得不好，是分层的必然代价：`agent` 不能 import `ModelRuntime`（会造成反向依赖），只能收一个已经捕获了它的函数。

## 待跟进

- [ ] `agent.ts`（592）如何包装 `runLoop` 并维护 `AgentState`
- [ ] `harness/reducer.ts`（667）如何把 `AgentEvent` 归约成状态 —— Day 6
- [ ] `transformContext` 挂载的压缩逻辑 `harness/compaction/`（1128）—— Day 6
