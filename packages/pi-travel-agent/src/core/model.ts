import { execFileSync } from "node:child_process";
import type { AssistantMessage, Context, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { EventSink } from "./types.ts";

/**
 * 整个项目里唯一 import pi-ai 函数的文件。
 *
 * 其余所有代码(loop / tools / features / cli)只认本文件导出的 `stream()`。
 * 换 provider、换模型、哪天想自己手写适配层,都只动这里。
 * 类型不受此限 —— pi-ai 的类型可以在任何地方 import。
 */

export interface ModelSpec {
	model: Model<"openai-completions">;
	/** key 的取法。`!<cmd>` 执行命令取 stdout,`env:<NAME>` 读环境变量。沿用 pi 的约定。 */
	apiKeySource: string;
}

const qwen: Model<"openai-completions"> = {
	id: process.env.TRAVEL_MODEL_ID ?? "qwen3.7-plus",
	name: "Qwen3.7 Plus",
	api: "openai-completions",
	provider: "dashscope",
	baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 65_536,
	// 阿里云按量计费,这里只影响 usage 里的 cost 估算,不影响调用。
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// OpenAI 兼容 ≠ 和 OpenAI 一样。pi 靠 baseUrl 自动嗅探这些差异,
	// 但它不认识 dashscope,所以这里显式写死 —— 数值抄 pi 自己的 qwen 目录:
	//   packages/ai/src/providers/data/qwen-token-plan.json
	// developer 角色:dashscope 只认 system,不写这条会 400。
	// thinkingFormat qwen:思考开关是顶层 enable_thinking,不是 reasoning_effort。
	compat: {
		thinkingFormat: "qwen",
		supportsDeveloperRole: false,
		supportsStore: false,
		supportsReasoningEffort: false,
	},
};

export const MODELS: Record<string, ModelSpec> = {
	qwen: { model: qwen, apiKeySource: "!security find-generic-password -ws pi-dashscope" },
};

export const DEFAULT_MODEL = "qwen";

export function resolveModel(name: string = DEFAULT_MODEL): ModelSpec {
	const spec = MODELS[name];
	if (!spec) {
		throw new Error(`未知模型 "${name}"。可用:${Object.keys(MODELS).join(", ")}`);
	}
	return spec;
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
		// await:sink 慢,上游就等 —— 背压是真的,不是摆设。
		await request.sink?.({ type: "assistant_event", event });
	}
	return events.result();
}
