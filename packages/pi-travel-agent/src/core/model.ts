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

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`缺少环境变量 ${name}。把 .env.example 复制成 .env 再改`);
	return value;
}

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

const PROVIDERS: Record<string, () => ModelSpec> = { qwen: qwenFromEnv };

export const DEFAULT_MODEL = "qwen";

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
