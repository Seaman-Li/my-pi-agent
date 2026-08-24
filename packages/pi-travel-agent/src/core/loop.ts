/**
 * agent loop:一个 turn = 若干 step,每个 step = 一次模型请求 + 它要的工具。
 *
 * 层:core —— 不认识任何具体工具、不认识 UI、不认识旅行。
 * 边界:**本文件已进入只读**(Step 2b 接上 hooks 之后)。
 *       想改它 = 说明缺挂载点,先去 hooks.ts 加点再挂 feature;
 *       后面每个 Step 合并前 `git diff -- src/core/loop.ts` 都应该是空的。
 */

import type {
	AssistantMessage,
	Context,
	TextContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import { emptyHooks, type Hooks, runAfterStep, runAfterToolCall, runBeforeStep, runBeforeToolCall } from "./hooks.ts";
import { type ModelSpec, stream } from "./model.ts";
import type { Registry } from "./registry.ts";
import { type EventSink, type TurnEndReason, textOf } from "./types.ts";

/** 防死循环的闸。触顶不是错误,是「这轮不再往下跑了」。 */
const DEFAULT_MAX_STEPS = 10;

export interface TurnOptions {
	spec: ModelSpec;
	apiKey: string;
	/** 会被原地追加:assistant 消息和工具结果都进这里,所以调用方持有的就是全量历史。 */
	context: Context;
	tools: Registry;
	hooks?: Hooks;
	signal?: AbortSignal;
	sink?: EventSink;
	maxSteps?: number;
	reasoning?: ThinkingLevel;
}

export interface TurnResult {
	reason: TurnEndReason;
	steps: number;
	/** 本轮所有 step 的用量之和。 */
	usage: Usage;
}

/**
 * 判断这一步之后 turn 该不该结束。
 *
 * 写成一个独立函数而不是塞进 while 条件:结束条件是这个循环最容易出错、
 * 也最该讲清楚的部分,散在三处 `break` 里就没人能一眼说全。
 *
 * @returns 结束原因;`null` 表示继续下一步
 */
function turnEndReason(message: AssistantMessage, hasToolCalls: boolean, signal?: AbortSignal): TurnEndReason | null {
	if (signal?.aborted || message.stopReason === "aborted") return "aborted";
	if (message.stopReason === "error") return "error";
	// length:这条回复撞上了 maxTokens。里面的工具参数是 adapter 用 parseStreamingJson
	// 从半截 JSON 里抢救出来的 —— 「解析成功」不等于「内容完整」。
	// 所以截断的消息一律不执行工具,宁可这轮白跑。
	if (message.stopReason === "length") return "truncated";
	if (!hasToolCalls) return "completed";
	return null;
}

/** 把一次 step 的用量累加进总账。 */
function addUsage(total: Usage, next: Usage): Usage {
	return {
		input: total.input + next.input,
		output: total.output + next.output,
		cacheRead: total.cacheRead + next.cacheRead,
		cacheWrite: total.cacheWrite + next.cacheWrite,
		totalTokens: total.totalTokens + next.totalTokens,
		cost: {
			input: total.cost.input + next.cost.input,
			output: total.cost.output + next.cost.output,
			cacheRead: total.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
			total: total.cost.total + next.cost.total,
		},
	};
}

/** 一个全 0 的 usage,作为累加的起点。 */
function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * 顺序执行一批工具调用,把每个结果包成一条 `toolResult` 消息。
 *
 * 串行是 Step 2a 的临时选择,Step 3b 换成并行。
 * 这里**不判断成功失败就中断** —— 一批里某个工具炸了,其余照跑,
 * 因为模型下一步需要看到完整的一批结果才能决定怎么办。
 */
async function executeToolCalls(
	toolCalls: ToolCall[],
	tools: Registry,
	hooks: Hooks,
	step: number,
	signal?: AbortSignal,
	sink?: EventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		const startedAt = Date.now();
		await sink?.({ type: "tool_start", toolCallId: toolCall.id, name: toolCall.name, args: toolCall.arguments });

		const tool = tools.get(toolCall.name);
		let content: TextContent[] = [];
		let details: unknown;
		let isError = false;

		// 拦截点。返回了就不执行工具 —— Step 8 的 guard 和将来的缓存都挂这儿。
		const override = await runBeforeToolCall(hooks, { step, toolCall });
		if (override) {
			content = override.result.content;
			details = override.result.details;
			isError = override.isError ?? false;
		} else if (!tool) {
			// 模型编了一个不存在的工具名。把这件事如实告诉它,别静默吞掉。
			content = [{ type: "text", text: `没有名为 "${toolCall.name}" 的工具` }];
			isError = true;
		} else {
			try {
				// Step 3b 会在这里插入 Value.Convert → Check。
				// 现在参数未经校验直接透传 —— 假数据工具扛得住,真工具不行。
				const result = await tool.execute(toolCall.id, toolCall.arguments as never, signal);
				content = result.content;
				details = result.details;
			} catch (error) {
				// 工具的 execute 里不写 try/catch(pi 的约定),抛出来在这儿统一包成错误结果
				// 回灌给模型 —— 它看到「城市名不对」这类错误往往能自己改参数重试,
				// 比整个 turn 崩掉有用得多。
				content = [{ type: "text", text: error instanceof Error ? error.message : String(error) }];
				isError = true;
			}
		}

		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content,
			details,
			isError,
			timestamp: Date.now(),
		};
		// 改结果的机会。Step 8 给外部数据打「这是数据不是指令」的标注就在这里。
		await runAfterToolCall(hooks, { step, toolCall, result });
		results.push(result);
		await sink?.({
			type: "tool_end",
			toolCallId: toolCall.id,
			name: toolCall.name,
			text: textOf(result.content),
			isError: result.isError,
			ms: Date.now() - startedAt,
		});
	}
	return results;
}

/**
 * 跑一个 turn:请求 → 有工具就执行 → 带着结果再请求,直到没有理由继续。
 *
 * `options.context.messages` 会被原地追加,调用方拿到的就是完整历史。
 * 本函数不抛:模型侧和工具侧的失败都变成 `TurnResult.reason`,
 * 只有装配错误(比如工具重名)才会作为异常冒出去。
 */
export async function runTurn(options: TurnOptions): Promise<TurnResult> {
	const { spec, apiKey, context, tools, signal, sink } = options;
	const hooks = options.hooks ?? emptyHooks();
	const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
	context.tools = tools.schemas();

	let usage = emptyUsage();
	let steps = 0;
	let reason: TurnEndReason = "max_steps";

	await sink?.({ type: "turn_start" });
	while (steps < maxSteps) {
		steps++;
		await sink?.({ type: "step_start", step: steps });
		// 决定模型看到什么。memory 注入挂这里 —— 对应 dsh 的 agent/pre-step。
		await runBeforeStep(hooks, { step: steps, context });

		const message = await stream(spec, { context, apiKey, signal, sink, reasoning: options.reasoning });
		context.messages.push(message);
		usage = addUsage(usage, message.usage);

		const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
		const end = turnEndReason(message, toolCalls.length > 0, signal);
		if (end) {
			// 这一步没有工具要跑,到此为止。afterStep 照样触发一次 ——
			// 每个 step 恰好一次,压缩判定才不会漏掉最后这一步。
			await runAfterStep(hooks, { step: steps, context, message, results: [] });
			reason = end;
			break;
		}

		const results = await executeToolCalls(toolCalls, tools, hooks, steps, signal, sink);
		context.messages.push(...results);
		// 请求和工具都跑完了,这一步才算完整。压缩判定挂这里 ——
		// 它要看到工具输出进上下文之后的样子,才知道该不该压。
		await runAfterStep(hooks, { step: steps, context, message, results });
	}

	await sink?.({ type: "turn_end", reason, steps });
	return { reason, steps, usage };
}
