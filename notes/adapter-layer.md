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
