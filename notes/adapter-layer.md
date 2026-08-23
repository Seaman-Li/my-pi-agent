# 适配层速记

> Day 4 的产出。**不是重点**，只记住一个例子和一句结论即可。
> 行号基于 `v0.84.1`，路径相对 `packages/ai/src/api/`。

## 一句话结论

> adapter = **协议实现** + **能力归一化**

上层 `agent-loop.ts` 完全不知道自己在跟谁说话——它只见到统一的 `AssistantMessageEvent` 流，底下是 Anthropic、OpenAI 还是 DashScope 都一样。**把 N 家的差异吃在这一层，让 agent 层只面对一套概念**，这就是 `packages/ai` 存在的意义。

---

## 一个具体例子：同一个「开启思考」，两家两种写法

`openai-completions.ts:748-768`。假设 `reasoningEffort = "high"`：

```ts
if (compat.thinkingFormat === "zai" && model.reasoning) {
	zaiParams.thinking = { type: "enabled", clear_thinking: false };
	zaiParams.reasoning_effort = effort;
} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
	(params as any).enable_thinking = !!options?.reasoningEffort;
	(params as any).reasoning_effort = effort;
}
```

发出去的请求体：

```jsonc
// zai（智谱）
{ "thinking": { "type": "enabled", "clear_thinking": false }, "reasoning_effort": "high" }

// qwen（通义）—— 我们的 dashscope 走这条
{ "enable_thinking": true,                                    "reasoning_effort": "high" }
```

**同一个意图，一家用嵌套对象，一家用顶层布尔。** 上层只说 `ThinkingLevel = "high"`，翻译在这里发生。

### 两个字段缺一不可

```ts
if (compat.thinkingFormat === "qwen" && model.reasoning)
//     ↑ 方言对了                        ↑ 模型有这个能力
```

| 字段 | 出处 | 含义 |
|---|---|---|
| `model.reasoning` | `types.ts:791`，必填 `boolean` | 这个模型**有没有**推理能力 |
| `model.compat` | `types.ts:805` | 用**什么格式**表达推理参数（协议方言） |

少任何一个，`enable_thinking` 都不会发出去。`models.ts:903` 还有 `if (!model.reasoning) return ["off"]`——不支持推理的模型，`/model` 里思考档位选项直接消失。

### ⚠️ 两个 `reasoning`，同名不同物

grep 时最容易搞混的一处：

```ts
interface Model<TApi>  { reasoning: boolean; }        // types.ts:791  模型的静态能力，必填
interface StreamOptions{ reasoning?: ThinkingLevel; } // types.ts:305  本次请求的档位，可选
```

一个是 `boolean`，一个是 `"minimal"|"low"|"medium"|"high"|"xhigh"|"max"`；一个描述模型，一个描述请求。上面那行守卫同时用到了两个：`model.reasoning` 是能力前提，`options?.reasoningEffort` 是本次档位。**全仓 `model.reasoning` 只有 8 处，`options.reasoning` 有几十处。**

`model.reasoning` 的两类消费方：

1. **能力查询** `models.ts:903` — `if (!model.reasoning) return ["off"]`，`/model` 菜单里思考档位直接消失
2. **适配层守卫** — 六个协议族各一处（`openai-responses:312`、`anthropic-messages:1028`、`bedrock:1100`、`google:382/391`、`openai-completions:748/752`）。给不支持思考的模型发思考参数，多数厂商直接返回 400

它的来源一路到你自己的配置：

```
~/.pi/agent/models.json  "reasoning": true
  → model-config.ts:161   Type.Optional(Type.Boolean())      typebox 校验
  → provider-composer.ts:156  definition.reasoning ?? false  ← 纯配置 provider 走这条
  → Model.reasoning
```

`?? false` 的方向要记住：**配置里不写 = 不支持思考**。保守默认。dashscope 那行 `"reasoning": true` 删掉就静默失效——不报错，只是 `enable_thinking` 不再发出，模型退化成普通对话。**「配置漏一行 → 功能静默消失」是自建 provider 最常踩的坑。**

（`provider-composer.ts:107` 是另一处赋值 `override.reasoning ?? model.reasoning`，对应覆盖内置 provider 的分支，见 [provider-loading.md](provider-loading.md)。）

三个字段正交分工：

| | 回答什么 |
|---|---|
| `model.reasoning` | **有没有**这个能力 |
| `compat.thinkingFormat` | 用**什么格式**表达 |
| `thinkingLevelMap` | 各档位**映射成什么值** |

---

`compat` 的类型是**条件类型**，随 `api` 变化：`openai-completions` → `OpenAICompletionsCompat`，`anthropic-messages` → `AnthropicMessagesCompat`。所以写配置时 IDE 只提示当前协议相关的字段。

---

## `src/api/` 目录分五类（30 个文件）

| 类别 | 数量 | 说明 |
|---|---|---|
| **真正的 adapter** | 6 | 六个协议族，见下表 |
| 共享层 | 2 | `openai-responses-shared`(772)、`google-shared`(414)，同族复用 |
| 薄封装 | 5 | `google-vertex`、`azure-openai-responses`、`cloudflare`(15 行) 等 |
| **`.lazy.ts`** | 10 | 每个 4 行的**懒加载壳** |
| 公共工具 | 6 | `transform-messages`、`constrained-sampling`、`pi-messages` 等 |

六个协议族：

| 文件 | 行 | 覆盖 |
|---|---|---|
| `openai-completions.ts` | 1575 | Chat Completions + **几十家"兼容"厂商** |
| `openai-codex-responses.ts` | 1650 | OpenAI Responses（Codex 变体） |
| `anthropic-messages.ts` | 1351 | Anthropic Messages |
| `bedrock-converse-stream.ts` | 1173 | AWS Bedrock |
| `mistral-conversations.ts` | 677 | Mistral |
| `google-generative-ai.ts` | 517 | Google AI Studio |

**六个协议族 × 500–1600 行 ≈ 7000 行，这就是「支持所有模型」的真实成本。**

### `.lazy.ts` 值得知道

pi 依赖了 `@anthropic-ai/sdk`、`openai`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`@mistralai/mistralai` 五个大 SDK。**懒加载壳让「用哪家才加载哪家」**——只配了 dashscope，启动时就只加载 `openai` 一个 SDK。这是 pi 启动只要 0.05 秒的原因之一。

---

## `openai-completions` 是什么

指 **Chat Completions API**（`POST /v1/chat/completions`），OpenAI 早期推出、后来成为**行业事实标准**的接口。

注意 `types.ts:17` 的 `KnownApi` 里 OpenAI 自家占了四种：`openai-completions`（标准）、`openai-responses`（较新的另一套）、`azure-openai-responses`、`openai-codex-responses`。**「OpenAI 兼容」专指第一个**——OpenAI 后来出的 Responses API 生态没跟着走。

你配的 `https://dashscope.aliyuncs.com/compatible-mode/v1` 里 `compatible-mode` 就是明说"这是我们的 OpenAI 兼容模式"。

三个容易混的概念：

| | 是什么 |
|---|---|
| OpenAI | 模型厂商 |
| Chat Completions API | 一套 HTTP 接口规范 ← `openai-completions` 指这个 |
| `openai` npm 包 | 官方 SDK，pi 用它发请求（`createClient:636`） |

有意思的是 **pi 用 OpenAI 官方 SDK 去调 DashScope**——SDK 只是 HTTP 客户端，换个 `baseURL` 就指向任何兼容端点。

---

## 响应方向：从 SSE 到 `AssistantMessage`

上面讲的是**请求**方向。响应方向更能说明归一化在归一什么。

### 六跳调用链

我们那次 dashscope 请求，`agent-loop.ts:193` 的 `streamFunction(...)` 实际走了六跳：

```
runLoop:193                  streamFunction(config.model, llmContext, {...})
  ▼  值 = 下面这个闭包
sdk.ts:302                   async (model, context, options) => {...}
  │                            + 超时、重试次数、attribution header、扩展钩子
  ▼
model-runtime.ts:636         ModelRuntime.streamSimple()
  │                            + 凭证解析（此刻才跑 !security find-generic-password）、baseUrl 覆盖
  ▼
compat.ts:275                streamSimple<TApi>()
  │                            按 model.api 查表分发
  ▼
openai-completions.ts:616    streamSimple           ← 翻译门面
  │                            reasoning:"high" → reasoningEffort
  ▼
openai-completions.ts:200    stream                 ← 真正发 HTTP
```

`getDefaultStreamFn()` 一次都没出现——那是给第三方扩展的侧门，见 [provider-loading.md](provider-loading.md)。

### `streamSimple` 是 `stream` 的翻译门面，不是替代品

```ts
// openai-completions.ts:616-634，全文 19 行
export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (model, context, options) => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	return stream(model, context, { ...base, reasoningEffort, toolChoice, thinkingBudgets } satisfies OpenAICompletionsOptions);
};
```

| | options 类型 | 思考参数长什么样 |
|---|---|---|
| `streamSimple` | `SimpleStreamOptions` | `reasoning: "high"` ← **pi 的统一抽象** |
| `stream` | `OpenAICompletionsOptions` | `reasoningEffort: <本协议的值>` ← **协议原生** |

`clampThinkingLevel` 查 `model.thinkingLevelMap` 做映射。**agent 层只认识 pi 的抽象，所以必然用 `streamSimple`**；`stream` 留给"我明确知道在调 OpenAI"的调用方。六个协议族每家都有这一对。

### `stream` 的执行骨架（`:200-613`）

六跳的最后一跳落在这里。整个函数只有三行是"骨架"，其余全是块状态机：

```
stream(model, context, options)                                        :200
│
├─ const stream = new AssistantMessageEventStream()                    :205
│
├─ (async () => { ... })()        ← 注意没有 await，后台跑             :207
│   │
│   │ 【准备】还没碰网络
│   ├─ output = { content: [], usage: 全 0, stopReason: "pending" }    :208
│   ├─ getClientApiKey / getCompat / createClient
│   ├─ params = buildParams(...)      messages+tools 转成 OpenAI 形状
│   └─ await onPayload?.(params)      上层最后一次改请求体的机会
│   │
│   │ 【握手】
│   ├─ retryProviderRequest(() => create(params).withResponse())       :246
│   │      ↑ 拿到的是响应头 + 一个还没开始读的 body
│   ├─ await onResponse?.({ status, headers })                         :254
│   │      ↑ 限流头、请求 id 这类东西在这儿交给上层
│   └─ push { start, partial: output }        output 此刻是空壳        :255
│   │
│   │ 【定义块状态机】纯闭包，不产生任何行为
│   ├─ blocks = output.content            ← 别名，不是拷贝             :280
│   ├─ finishBlock / ensureTextBlock / ensureThinkingBlock / ensureToolCallBlock
│   │                                                            :304-436
│   │ 【收流】token 从这里才开始到
│   └─ for await (const chunk of openaiStream)                         :440
│        ├─ chunk.usage       → output.usage（整体替换，不是累加）
│        ├─ chunk.id / model  → responseId / responseModel（`||=` 只认第一个）
│        ├─ finish_reason     → output.stopReason = mapStopReason(...)
│        └─ choice.delta 靠「哪个字段非空」分流：
│             ├─ .content            → ensureTextBlock()      首次补 text_start
│             │                        text += delta;  push text_delta
│             ├─ .reasoning_content  → ensureThinkingBlock()  首次补 thinking_start
│             │   / .reasoning         thinking += delta;  push thinking_delta
│             └─ .tool_calls         → ensureToolCallBlock()  首次补 toolcall_start
│                                      partialArgs += ;  push toolcall_delta
│   │
│   │ 【收尾】
│   ├─ for (block of blocks) finishBlock(block)   一次性补齐所有 *_end  :568
│   ├─ 四道闸：signal.aborted / stopReason==="aborted" / 缺 finish_reason
│   │          / stopReason==="error" / 还是 "pending"  → 任一命中就 throw
│   ├─ push { done, reason, message: output }                          :588
│   └─ stream.end()
│
└─ catch                                                               :590
    ├─ 删掉 partialArgs / customInput / streamIndex（scratch 字段不许落库）
    ├─ output.stopReason = signal.aborted ? "aborted" : "error"
    ├─ push { error, error: output }                                   :608
    └─ stream.end()

return stream    ← 同步返回，此时上面那个 IIFE 一行都还没跑完            :613
```

三个容易看错的地方：

**① `create()` 返回不等于「调完 LLM」。** `stream: true` 时 SDK 在**响应头到达**就 resolve，
一个 token 都还没来；`openaiStream` 是个还在流的 async iterable。那一行是握完手，不是拿到答案。
所以 `:246` 到 `:440` 之间那 190 行（`onResponse`、`push start`、130 行闭包定义）
全部发生在"已经连上、还没收到内容"的窗口里。

**② 205 / 207 / 613 三行决定了 `stream()` 永远不抛。** 建流、起一个不 await 的 IIFE、立刻返回。
调用方拿到 stream 的那一刻请求可能才刚发出去。这就是
`types.ts:320` 那句契约的实现方式——"Once invoked, request/model/runtime failures should be
encoded in the returned stream, not thrown"，`:590` 的 catch 把一切异常翻译成一个 `error` 事件。

**③ `push start` 时 `output` 是空壳，但它是全程唯一那只碗。**
`content: []`、`usage` 全 0、`stopReason: "pending"`、`responseId` 还没有（要等第一个 chunk）；
已填的只有 role / api / provider / model / timestamp。
`:280` 的 `blocks = output.content` 是**别名**，后面所有事件的 `partial` 推的都是这同一个引用
——详见下面[一碗饭的比方](#output--delta--partial--一碗饭的比方)。

> 顺带解释了 `:590` catch 里那几个 `delete` 为什么必要：block 早就挂在 `output.content` 上了，
> 出错时不把 scratch 字段清干净，它们会跟着 `error` 事件一路进 session。

### 13 个事件不是 LLM 的出参，是 pi 自己的协议

`types.ts:509` 的注释叫它 **"Event protocol for AssistantMessageEventStream"**。定义 13 种（`types.ts:516`）。原始 SSE 长这样：

```json
{"choices":[{"delta":{"content":"你"}}]}
{"choices":[{"delta":{"reasoning_content":"嗯"}}]}
```

**OpenAI Chat Completions 的 chunk 全是同一个形状，没有任何事件类型字段。** 所以这里不是"类型映射"，是**合成**。对比 Anthropic——它的 SSE 自带 event type，adapter 就是个 switch：

```
anthropic-messages.ts:574/587/629/675/707
  message_start / content_block_start / content_block_delta / content_block_stop / message_delta
```

**同样一套 13 个事件，Anthropic 是翻译出来的，OpenAI 兼容是造出来的。**

### 全部 13 个发出点（openai-completions.ts）

```
:255  start          ← HTTP 响应头到手，chunk 循环之前
      ┌ chunk 循环内 ────────────────────────────────
:354  │ text_start        ensureTextBlock()      懒创建的副产品
:366  │ thinking_start    ensureThinkingBlock()  同上
:412  │ toolcall_start    toolCallBlocksByIndex 判重
:481  │ text_delta        delta.content 非空
:513  │ thinking_delta    delta.reasoning_content / reasoning / reasoning_text
:543  │ toolcall_delta    delta.tool_calls[].function.arguments
      └──────────────────────────────────────────────
:569  for (const block of blocks) finishBlock(block);   ← 循环结束后统一收尾
:311      text_end
:318      thinking_end
:343      toolcall_end
:588  done           ← 四道校验通过后
:608  error          ← catch 块
```

三种产生机制：

**① `start` 的位置反直觉**——在 `for await` 之前。含义不是"模型开始说话"，是"连接就绪"。此时 `partial.content` 还是空数组，但已有 `model`/`provider`/`api`，UI 可以先画气泡。这解释了 `agent-loop.ts:319-323` 为什么在 `start` 时就 push 空占位。

**② `*_start` 是懒创建的副产品**，不是"推断出该发 start"：

```ts
const ensureTextBlock = () => {
	if (!textBlock) {                    // 还没有 → 这就是开始
		textBlock = { type: "text", text: "" };
		blocks.push(textBlock);
		stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
	}
	return textBlock;                    // 已有 → 什么都不发
};
```

**③ `*_end` 全部推迟到流结束后补发。** `finishBlock` 只有一个调用点（`:568-570`），在 chunk 循环**之后**。原因很实在：**这个协议无法知道一个块什么时候结束**——`delta.content` 停了，可能是结束，也可能只是这个 chunk 里没有。只有流断了才敢下结论。

`finishBlock` 里的收尾才是重头：

```ts
} else if (block.type === "toolCall") {
	block.arguments = parseStreamingJson(block.partialArgs);   // :335 累积的字符串 → 对象
	delete block.partialArgs; delete block.customInput; delete block.streamIndex;   // :339 清临时缓冲
	stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
}
```

工具参数是分片流过来的字符串（`{"pa` → `th":"/tm` → `p"}`），流式期间只能往 `partialArgs` 里攒。**这正是 `stopReason === "length"` 要整批判错的原因**——`parseStreamingJson` 是尽力抢救，截断的参数可能"解析成功但内容不全"，见 [agent-loop.md](agent-loop.md) 第三节。

> **真正流式的只有 `*_delta` 和 `*_start`；`*_end` 是事后补的。**「块生命周期完整」是 adapter 用状态机 + 事后收尾造出来的假象。

---

## `output` / `delta` / `partial` —— 一碗饭的比方

```ts
const output: AssistantMessage = { content: [], stopReason: "pending", ... };   // :208 循环外，只创建一次
...
block.text += choice.delta.content;                                              // :479 循环内，原地追加
stream.push({ type: "text_delta", delta: choice.delta.content, partial: output });// :481 传的是引用
```

```
delta   = 这一口饭（本次 chunk 的增量）
output  = 碗（全程唯一一个，越吃越满）
partial = 每次事件里递给你的那只碗的把手 —— 不是碗的照片
```

**`partial` 不是快照。** 从头到尾传的是同一个引用：第 3 个事件和第 300 个事件的 `partial`，`===` 为真，内容都是最终全文。

### 用真实会话反推

会话 `2026-08-10T05-11-12-537Z_019fea14…jsonl` 第 23 行是全场最小的一条 assistant 消息：

```json
[{"type":"thinking","thinking":"Done.\n","thinkingSignature":"reasoning_content"},
 {"type":"text","text":"已创建 `notes/infra_learning.md`，包含了完整的架构分析内容。"}]
```

**注意：JSONL 里看不到流式过程。** 这个文件 48 行只有四种记录：

```bash
node -e 'const c={};require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")
  .forEach(l=>{const o=JSON.parse(l);c[o.type]=(c[o.type]||0)+1});console.log(c)' <file>
# { session: 1, model_change: 1, thinking_level_change: 1, message: 45 }
```

落盘的只有 `message`——**`message_update` 一条都不存**。所以下面是按代码反推出的事件序列（假设 thinking 分 2 个 chunk、text 分 3 个）：

| # | 事件 | `delta` | `output.content` 此刻的状态 |
|---|---|---|---|
| 1 | `start` | — | `[]` |
| 2 | `thinking_start` | — | `[{thinking:""}]` |
| 3 | `thinking_delta` | `"Done"` | `[{thinking:"Done"}]` |
| 4 | `thinking_delta` | `".\n"` | `[{thinking:"Done.\n"}]` |
| 5 | `text_start` | — | `[{thinking:"Done.\n"}, {text:""}]` |
| 6 | `text_delta` | `"已创建 "` | `[…, {text:"已创建 "}]` |
| 7 | `text_delta` | `` "`notes/infra_learning.md`，" `` | `[…, {text:"已创建 `notes/…md`，"}]` |
| 8 | `text_delta` | `"包含了完整的架构分析内容。"` | `[…, {text: 全文}]` |
| 9 | `thinking_end` | — | 同上（`finishBlock` 补发） |
| 10 | `text_end` | — | 同上 |
| 11 | `done` | — | `stopReason: "stop"` |

**第 3 行和第 11 行拿到的 `partial` 是同一个对象。** 事件 3 发生时它的 `text` 还不存在；但如果你把那个引用存下来，等流跑完再打印，看到的是 JSONL 里那份完整内容。

注意事件 9、10 的位置——`thinking_end` 排在所有 `text_delta` **之后**，因为 `finishBlock` 是循环结束后按 `blocks` 顺序一次性跑的。**块的 `end` 事件不在块内容结束时发出。**

### 两个实际后果

**① 消费者不需要自己拼字符串**

```ts
partialMessage = event.partial;    // agent-loop.ts:336  整个换掉，不是 +=
```

累积已经在 adapter 里做完了。UI 用 `delta` 做打字机效果，用 `partial` 拿完整状态。

**② 但必须自己拷贝，否则"历史快照"会一起变**

```ts
await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
//                                                                          ↑ agent-loop.ts:341
```

不拷的话，存下的所有快照最终都指向同一份最终内容。而且 `{...}` 只是**浅拷贝**——`content` 数组仍共享，UI 若缓存了 `message.content[0]` 照样会变。真要冻结得深拷。

**这是 push 一个可变累积器的固有代价**：省掉了每个事件一次深拷贝的开销，把责任推给消费者。

---

## 想细读时的六个锚点（约 200 行）

按执行顺序，串起来是一次完整往返：

| # | 行 | 看什么 |
|---|---|---|
| 1 | 681–700 | `buildParams()` 请求体组装 |
| 2 | 748–800 | 思考格式分支（本文那个例子） |
| 3 | 1046–1090 | `convertMessages()` 消息转换 |
| 4 | 1338–1380 | `convertTools()` typebox schema → 请求体（含 1366 行那句注释） |
| 5 | 230–250 | `onPayload` 钩子 + 发请求 |
| 6 | 400–470 | 流式解析 → `mapStopReason` |

其余 1300 行是各家怪癖（提示词缓存、kimi 延迟工具、加密推理内容、grammar 解码），**属于清单条目而非设计原理，用到再查**。

---

## 顺带发现的两个细节

**① `?? ` 与 `=== undefined` 对 `null` 处理不一致**

`ThinkingLevelMap` 里 `null` 表示"该档位不支持"（见 [ts-notes.md](ts-notes.md) 第 6 条）。zai 分支用 `mappedEffort === undefined ? ... : ...` 能正确跳过 `null`；qwen 分支用 `?? ` 会把 `null` 兜底成原值发出去。当前无影响（两家都没配这张表），**是潜在不一致而非当前 bug**。

**② 同文件里两种类型处理质量**

```ts
// zai：构造精确的局部类型，扩展字段仍受检查
const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
	thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
};

// qwen：直接 as any，拼错字段名不会被发现
(params as any).enable_thinking = ...;
```

前者是值得学的姿势。注意：`biome.json` 里 `noExplicitAny: "off"`，**lint 层面没禁 `any`**；`AGENTS.md:18` 那句 "No `any` unless absolutely necessary" 是**约定而非工具强制**。`packages/ai/src` 里有 31 处 `as any`，光这个文件占 20 处——adapter 层（厂商扩展字段无官方类型）是公认的例外区。
