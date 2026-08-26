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

const PROVIDERS: Record<string, () => ModelSpec> = { qwen: qwenFromEnv, local: ollamaFromEnv };

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
	return build();
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
