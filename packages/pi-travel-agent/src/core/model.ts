/**
 * provider 边界:模型配置、取 key、发起一次模型请求。
 *
 * 层:core —— **整个项目里唯一 import pi-ai 函数的文件**。
 * 边界:其余代码(loop / tools / features / cli)只认本文件导出的 `stream()`;
 *       换 provider、换模型、哪天想自己手写适配层,都只动这里。
 *       类型不受此限 —— pi-ai 的类型可以在任何地方 import。
 */

import { execFileSync } from "node:child_process";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { EventSink } from "./types.ts";

export interface ModelSpec {
	model: Model<"openai-completions">;
	/** key 的取法。`!<cmd>` 执行命令取 stdout,`env:<NAME>` 读环境变量。沿用 pi 的约定。 */
	apiKeySource: string;
}

/**
 * dashscope 的 OpenAI 兼容差异。
 *
 * 这些留在代码里而不是 .env:它们是**协议事实**(dashscope 就长这样),
 * 不是部署配置(换个人跑要改的东西)。把它写进 .env 等于让每个使用者
 * 重新踩一遍 400。数值抄 pi 自己的 qwen 目录:
 *   packages/ai/src/providers/data/qwen-token-plan.json
 *
 * developer 角色:pi 对 reasoning 模型默认发 `developer`,dashscope 只认 `system`。
 * thinkingFormat qwen:思考开关是顶层 enable_thinking,不是 reasoning_effort。
 */
const DASHSCOPE_COMPAT: OpenAICompletionsCompat = {
	thinkingFormat: "qwen",
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsReasoningEffort: false,
};

/**
 * 局域网 Ollama 的 OpenAI 兼容差异。
 *
 * 和 dashscope 那套一样,这些是**协议事实**不是部署配置,所以写死在代码里,
 * 地址和模型 id 才走 .env。
 *
 * `supportsStrictMode: false`:`strict` 是 OpenAI 的结构化输出约束,Ollama 不实现它。
 * pi-ai 默认当成支持,发过去多半被忽略,但「多半」不是「一定」——显式关掉。
 *
 * `supportsReasoningEffort: true` 是**实测出来的,不是抄的**。五种关思考的写法只有一种被认:
 *
 * | 发过去的字段 | 思考段长度 |
 * |---|---|
 * | 什么都不发 / `think:false` / `chat_template_kwargs.enable_thinking:false` | 6000~9000 字 |
 * | `reasoning_effort:"none"` | **0** |
 *
 * 6000 字思考 ≈ 3000 token,单步就吃掉 8192 窗口的三分之一,而且这个模型常把最终回答
 * 也留在思考里、`content` 发空 —— 终端上看着像「只有思考没有回答」。所以本地这条路
 * **默认必须关思考**。配合 model 上的 `thinkingLevelMap.off = "none"`,
 * pi-ai 在不带 `--thinking` 时走 `api/openai-completions.ts:839` 那一支,发 `reasoning_effort:"none"`。
 *
 * 响应侧不用配:`reasoning` 字段 pi-ai 认(同文件 :492 试三个别名)。
 */
const OLLAMA_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsReasoningEffort: true,
	supportsStrictMode: false,
};

/**
 * DeepSeek 官方 API 的兼容差异。
 *
 * 和 dashscope、Ollama 那两套一样,这些是**协议事实**不是部署配置,所以写死在代码里。
 * 数值不是猜的,抄 pi 自己的:packages/ai/src/providers/data/deepseek.json
 *
 * `thinkingFormat: "deepseek"`:思考开关是 `thinking: { type: "enabled" | "disabled" }`,
 * 不是 `reasoning_effort`(那个另外发,见 `deepseekFromEnv`)。**不带 `--thinking` 时会显式发
 * `disabled`**,不是什么都不发 —— 这点和 qwen 不一样。
 *
 * `requiresReasoningContentOnAssistantMessages`:DeepSeek 要求把它上一轮吐的
 * `reasoning_content` 原样带回去。pi-ai 负责回填,但得靠这个开关才知道该回填。
 *
 * pi-ai 的 `detectCompat` 认得 `deepseek.com` 这个域名,这三条它自己也推得出来
 * (api/openai-completions.ts:1488)。仍然写明白,是因为**推断出来的东西不写在这儿就没人看得见** ——
 * 哪天换个自建网关、域名一变,这些会悄悄失效,而症状是「模型忽然不肯思考了」这种查不动的问题。
 * `getCompat` 是逐字段 `??` 合并的(:1542),显式给的赢,没给的仍走探测。
 */
const DEEPSEEK_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
};

/**
 * 价格,**美元 / 百万 token**(`calculateCost` 就是按这个单位除的,models.ts:892)。
 *
 * qwen 那边全填 0,DeepSeek 这边填真数 —— 因为它是这个项目里**第一个真见到
 * `cached_tokens` 的 provider**(qwen3.6-plus 上一次都没出现过,原因未查清,
 * 见 docs/prompt-cache.md 的 09-01 修正)。`cacheRead` 比 `input`
 * 便宜 31 倍,不填真价的话,摘要行里那个 `$` 看不出缓存到底省了多少。
 *
 * **这里填的是 off-peak 价,而账因此是偏低的。** 一开始是照抄 pi 的
 * `packages/ai/src/providers/data/deepseek.json`,后来查官方定价页发现那张表停在
 * 2026-04-24 那版(flash `0.14 / 0.0028 / 0.28`);DeepSeek 从 **2026-08-16 起改成按时段计价**,
 * 峰时(UTC 01:00-04:00、06:00-10:00,周一到周五)翻倍。
 *
 * 也就是说 **`cost` 这个字段的形状就装不下现在的价**:它是一张静态表,而真实单价取决于
 * 「这次请求发生在几点」。填 off-peak 是有意选偏低的那头 —— 一个偏低的数至少方向明确
 * (真实花费不会更少),而填峰时价会让 off-peak 的账凭空翻倍。想要准的,得让 `cost`
 * 变成一个函数,那是 pi-ai 那一层的事,不是我们能在这儿修的。见 BACKLOG。
 *
 * 认不出的 model id 一律记 0:**不猜价**。表现是摘要行里没有 `$`,而不是一个编出来的数。
 * 加新型号 = 这里加一行,不用动别处。
 */
const DEEPSEEK_COST: Record<string, Model<"openai-completions">["cost"]> = {
	"deepseek-v4-flash": { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
	"deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
};

/**
 * 读一个必填环境变量。
 *
 * @throws 缺失或为空串时抛。空串按缺失处理 —— `TRAVEL_MODEL_ID=` 是配错了,
 *         不是「配了个空值」,让它一路带到 HTTP 请求里只会换来一个难读的 400。
 */
function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`缺少环境变量 ${name}。把 .env.example 复制成 .env 再改`);
	return value;
}

/**
 * 读一个必填的正数环境变量。
 *
 * @throws 缺失、不是有限数、或 <= 0 时抛。上下文窗口配成 0 不会立刻报错,
 *         只会让后面的截断和压缩判定静默失效,所以在入口就拦掉。
 */
function envNumber(name: string): number {
	const raw = requireEnv(name);
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`环境变量 ${name} 不是正数:${raw}`);
	return value;
}

/**
 * 配置从环境读,而且是**调用时**读不是模块加载时读 ——
 * 入口先 `loadEnvFile()` 再 `resolveModel()`,顺序才成立:
 * 模块体在 import 的那一刻就执行完了,比入口的第一行还早。
 */
function qwenFromEnv(): ModelSpec {
	return {
		model: {
			id: requireEnv("TRAVEL_MODEL_ID"),
			name: requireEnv("TRAVEL_MODEL_ID"),
			api: "openai-completions",
			provider: "dashscope",
			baseUrl: requireEnv("TRAVEL_BASE_URL"),
			reasoning: true,
			input: ["text"],
			contextWindow: envNumber("TRAVEL_CONTEXT_WINDOW"),
			maxTokens: envNumber("TRAVEL_MAX_TOKENS"),
			// 阿里云按量计费,这里只影响 usage 里的 cost 估算,不影响调用。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: DASHSCOPE_COMPAT,
		},
		apiKeySource: requireEnv("TRAVEL_API_KEY_SOURCE"),
	};
}

/**
 * 局域网上的 Ollama。
 *
 * `LOCAL_CONTEXT_WINDOW` 填的必须是**服务端实际开的那个 `num_ctx`**,
 * 不是 `/api/tags` 报的 `context_length`(那是模型上限,Ollama 默认远小于它)。
 * 填大了不会报错 —— Ollama 会从头静默丢消息,你只会看到模型「忘了前面说过什么」。
 * 这正是 Q7 里第①类问题(信息压根没进上下文),而且是最难认出来的一种。
 *
 * key 走 `env:LOCAL_API_KEY`:Ollama 不校验,但 `resolveApiKey` 不接受空值,
 * 所以 .env 里随便填个非空字符串。
 */
function ollamaFromEnv(): ModelSpec {
	return {
		model: {
			id: requireEnv("LOCAL_MODEL_ID"),
			name: requireEnv("LOCAL_MODEL_ID"),
			api: "openai-completions",
			provider: "ollama",
			baseUrl: requireEnv("LOCAL_BASE_URL"),
			reasoning: true,
			// off 必须是字符串,不能是 null —— null 的语义是「这个模型关不掉思考,别发」,
			// 那样就退回到 6000 字思考的默认行为了。
			thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high" },
			input: ["text"],
			contextWindow: envNumber("LOCAL_CONTEXT_WINDOW"),
			maxTokens: envNumber("LOCAL_MAX_TOKENS"),
			// 自己的机器,电费不算在这儿。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: OLLAMA_COMPAT,
		},
		apiKeySource: "env:LOCAL_API_KEY",
	};
}

/**
 * DeepSeek 官方 API。
 *
 * `thinkingLevelMap` 抄 deepseek.json,低三档全是 `null`。**null 的意思是「这档不存在」**,
 * 而 `clampThinkingLevel` 遇到不存在的档位会**往上取最近的可用档**(models.ts:923):
 * 可用档只剩 off / high / max,于是 `low → medium(也没有)→ high`。
 *
 * 所以 `--thinking` 在这条路上**不是「开一点点思考」,是直接开到 high**。实测发出去的 body:
 *
 * | 命令 | body 里的思考字段 |
 * |---|---|
 * | 不带 `--thinking` | `thinking: { type: "disabled" }` |
 * | 带 `--thinking` | `thinking: { type: "enabled" }` + `reasoning_effort: "high"` |
 *
 * qwen 那边 `--thinking` 只是 `enable_thinking: true`,没有档位之分 —— 同一个开关,
 * 在两个 provider 上的**代价差得远**,DeepSeek 是按 token 真收钱的。
 *
 * 窗口和 maxTokens 走 .env 而不是写死:和 qwen 同一条理由,它们是**这次跑用什么档位**,
 * 换个型号就得改。留在代码里的是 `compat` —— 那是协议事实,不会因为换型号而变。
 *
 * **价格是第三类,两边都不太对**:它既不随档位变(不该进 .env),也不是协议事实
 * (它会过期,而且现在还按时段浮动)。放在 `DEEPSEEK_COST` 是权宜,见那里的注释和 BACKLOG。
 */
function deepseekFromEnv(): ModelSpec {
	const id = requireEnv("DEEPSEEK_MODEL_ID");
	return {
		model: {
			id,
			name: id,
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: requireEnv("DEEPSEEK_BASE_URL"),
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
			input: ["text"],
			contextWindow: envNumber("DEEPSEEK_CONTEXT_WINDOW"),
			maxTokens: envNumber("DEEPSEEK_MAX_TOKENS"),
			cost: DEEPSEEK_COST[id] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: DEEPSEEK_COMPAT,
		},
		apiKeySource: requireEnv("DEEPSEEK_API_KEY_SOURCE"),
	};
}

const PROVIDERS: Record<string, () => ModelSpec> = {
	qwen: qwenFromEnv,
	local: ollamaFromEnv,
	deepseek: deepseekFromEnv,
};

export const DEFAULT_MODEL = "qwen";

/**
 * 按名字取模型配置。名字来自 `--model`,默认 qwen。
 *
 * @throws 名字不认识时抛,错误信息里列出可用的 —— 打错字远比配错常见。
 */
export function resolveModel(name: string = DEFAULT_MODEL): ModelSpec {
	const build = PROVIDERS[name];
	if (!build) {
		throw new Error(`未知模型 "${name}"。可用:${Object.keys(PROVIDERS).join(", ")}`);
	}
	const spec = build();
	checkWindow(name, spec);
	return spec;
}

/**
 * 真正能留给**输入**的空间:总信封减掉可能吐出来的输出。
 *
 * `checkWindow` 已经保证它是正数。放 core 不放 features:它只是关于一个 `ModelSpec`
 * 的算术,而现在压缩阈值和 guard 的单条输入上限**两块积木都要用它** ——
 * 留在其中一块里就成了积木互相 import。
 */
export function usableTokens(spec: ModelSpec): number {
	return spec.model.contextWindow - spec.model.maxTokens;
}

/**
 * 窗口和 maxTokens 的关系检查。
 *
 * `contextWindow` 是**总信封**,输入和输出都得装进去(qwen 的模型卡写得最清楚:
 * 1M 里输入最多占 991.8K)。所以 `contextWindow <= maxTokens` 意味着
 * **留给输入的空间是 0 或负数**,这份配置从第一次请求起就不成立。
 *
 * 为什么值得在启动时单独抛一次:Step 7 的压缩阈值取在 `contextWindow − maxTokens` 上。
 * 这个差是负数的话阈值也是负数 —— 表现是**每一步都判定该压、压完还超**,
 * 看着完全像压缩逻辑写坏了。而验收压缩时要把窗口调到 20k 试触发,
 * 正是最容易只改一个数就撞上它的时候。
 *
 * 在**配错的那一刻**报,比在压缩逻辑里报便宜得多 —— 和 `requireEnv` 空串就抛同一条理由。
 *
 * @throws contextWindow <= maxTokens 时抛,两个数和该怎么改都写进消息里。
 */
function checkWindow(name: string, spec: ModelSpec): void {
	const { contextWindow, maxTokens } = spec.model;
	if (contextWindow > maxTokens) return;
	throw new Error(
		`模型 "${name}" 的 contextWindow(${contextWindow})不大于 maxTokens(${maxTokens})。` +
			"contextWindow 是输入+输出的总信封,这么配等于没给输入留空间。" +
			"调小 *_MAX_TOKENS 或调大 *_CONTEXT_WINDOW。",
	);
}

/** 取 key。返回值绝不进日志、不进上下文、不进事件流 —— Step 8 会把这条写成检查。 */
export function resolveApiKey(source: string): string {
	if (source.startsWith("!")) {
		const parts = source.slice(1).trim().split(/\s+/);
		const command = parts[0];
		if (!command) throw new Error("apiKeySource 的 ! 后面是空的");
		try {
			return execFileSync(command, parts.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		} catch {
			// 故意不带上原始错误:命令行里可能有凭据标识,而 stderr 可能回显它。
			throw new Error(`取 key 失败:${command} 执行不成功`);
		}
	}
	if (source.startsWith("env:")) {
		const name = source.slice("env:".length);
		const value = process.env[name];
		if (!value) throw new Error(`环境变量 ${name} 没设`);
		return value;
	}
	throw new Error(`不认识的 apiKeySource:${source}(只支持 !<cmd> 和 env:<NAME>)`);
}

export interface StreamRequest {
	context: Context;
	apiKey: string;
	signal?: AbortSignal;
	sink?: EventSink;
	reasoning?: ThinkingLevel;
}

/**
 * 一次模型请求。事件边推边喂 sink,结束后返回完整的 AssistantMessage。
 *
 * 注意这里没有 try/catch:pi-ai 的契约是「一旦返回流,失败也编码进流」,
 * 最终那条 message 的 stopReason 会是 "error" / "aborted",errorMessage 带原因。
 * 调用方读 stopReason,不靠捕异常。
 */
export async function stream(spec: ModelSpec, request: StreamRequest): Promise<AssistantMessage> {
	const events = streamSimple(spec.model, request.context, {
		apiKey: request.apiKey,
		signal: request.signal,
		reasoning: request.reasoning,
	});
	for await (const event of events) {
		// await 保证按序交付、异步 sink 不浮空。它不是背压:
		// 上游照读不误,事件堆在 EventStream 的队列里。理由见 types.ts。
		await request.sink?.({ type: "assistant_event", event });
	}
	return events.result();
}
