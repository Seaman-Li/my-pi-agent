/**
 * 把 agent 内部发生的事渲染成终端上的字。
 *
 * 层:入口 —— 唯一允许有 stdout/stderr 的地方之一(另一个是 cli.ts 的用法提示)。
 * 边界:只读事件、只写终端。不改数据、不做决策 —— 那是 hook 的活儿。
 *       Step 5 把它从 cli.ts 拆出来,是因为有了第二个驱动(repl.ts):
 *       单轮和多轮必须打出一模一样的格式,格式就只能有一份。
 */

import type { Context, Message } from "@earendil-works/pi-ai";
import type { ModelSpec } from "./core/model.ts";
import type { TurnResult } from "./core/loop.ts";
import type { AgentEvent, EventSink } from "./core/types.ts";

export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";

/**
 * 把一段可能很长、可能带换行的文本压成一行,给终端摘要用。
 *
 * 只影响显示 —— 进上下文的是工具返回的完整 `content`,不是这里截断后的版本。
 */
function oneLine(text: string, limit = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 造一个渲染器。**每个 turn 一个** —— 它带着 `thinkingOpen` 这个状态,
 * 而 turn 可能停在思考中间(被 Ctrl-C 打断)。复用同一个的话,那次没闭合的状态
 * 会漏进下一轮,下一轮开头就少一个颜色重置。状态跟着 turn 生死最省心。
 *
 * 只认边界事件(*_start / *_end)决定换行和缩进,内容一律来自 *_delta ——
 * 不要用「上一次是不是同一种块」来猜边界,那正是 adapter 层已经替你算好的东西。
 */
export function createRenderer(): EventSink {
	let thinkingOpen = false;
	return (agentEvent: AgentEvent) => {
		switch (agentEvent.type) {
			case "error":
				process.stderr.write(`\n[error] ${agentEvent.message}\n`);
				return;
			case "tool_start":
				process.stdout.write(`${DIM}[tool] ${agentEvent.name}(${JSON.stringify(agentEvent.args)})${RESET}\n`);
				return;
			case "tool_end": {
				const mark = agentEvent.isError ? "✗" : "→";
				process.stdout.write(`${DIM}  ${mark} ${oneLine(agentEvent.text)} (${agentEvent.ms}ms)${RESET}\n`);
				return;
			}
			case "rejected":
				// **正文颜色打,不是灰的。** 这句话是用户这一轮唯一收到的回答 ——
				// 灰字在这个终端里表示「元信息」(工具调用、账单、提示),
				// 而它是助手真的在回他的话,和模型正常吐出来的正文同一个身份。
				process.stdout.write(`${agentEvent.message}\n`);
				return;
			case "turn_start":
			case "step_start":
			case "turn_end":
				return;
			default:
				break;
		}
		const event = agentEvent.event;
		switch (event.type) {
			case "thinking_start":
				thinkingOpen = true;
				process.stdout.write(`${DIM}[思考] `);
				break;
			case "thinking_delta":
				process.stdout.write(event.delta);
				break;
			case "thinking_end":
				thinkingOpen = false;
				process.stdout.write(`${RESET}\n\n`);
				break;
			case "text_delta":
				process.stdout.write(event.delta);
				break;
			case "text_end":
				process.stdout.write("\n");
				break;
			case "toolcall_end":
				break;
			case "error":
				if (thinkingOpen) process.stdout.write(RESET);
				// **失败原因只有这里拿得到**:`TurnResult` 只带 `reason`,不带 `errorMessage`,
				// 而 loop.ts 是只读的。不在这儿打出来,turn 以 `end error` 收场时终端上
				// 一个字都没有 —— 实测那看着完全像卡死了,人会一直按回车等它动。
				// `aborted` 不打:那是用户自己按的 Ctrl-C,repl 已经说了「(已中断)」。
				if (event.reason === "error") {
					process.stderr.write(`\n[模型侧失败] ${event.error.errorMessage ?? "没给原因"}\n`);
				}
				break;
			default:
				break;
		}
	};
}

/**
 * 一个 turn 结束后的那行摘要。
 *
 * `ctx` 是**当前历史有多少条消息**,Step 5 新加的一项。单轮时代它恒等于
 * 「这轮产生了多少」,没有信息量;多轮之下它是唯一能一眼看见「历史在涨」的数字 ——
 * 而历史在涨正是 `in` 也跟着涨的原因,两个数放一起才讲得通。
 *
 * `cache` 也是 Step 5 才有意义的:多轮之下前缀高度重合,provider 会把命中缓存的
 * 那部分从 `input` 里扣掉单独记(`in` 其实是**减出来**的:`prompt_tokens − cached_tokens`,
 * 见 packages/ai/src/api/openai-completions.ts:1385)。
 * **不把它打出来,`in` 会看着莫名其妙地变小** ——
 * 实测 `qwen3.7-plus` 第二轮 `in` 从 2677 掉到 507,不是历史变短了,是 2000 多进了 cacheRead。
 *
 * **模型名不是可省的**:同一份代码在 `qwen3.6-plus` 上这一项恒为 0(它根本不返回
 * `cached_tokens` 字段),在 DeepSeek 上又能到 96%。见 docs/prompt-cache.md。
 */
export function formatTurnSummary(spec: ModelSpec, result: TurnResult, context: Context, turn?: number): string {
	const { usage } = result;
	const head = turn === undefined ? "" : `turn ${turn} / `;
	const cache = usage.cacheRead > 0 ? ` / cache ${usage.cacheRead}` : "";
	const cost = usage.cost.total > 0 ? ` / $${usage.cost.total.toFixed(4)}` : "";
	return (
		`${DIM}[${spec.model.id}] ${head}${result.steps} step / in ${usage.input}${cache} / out ${usage.output}` +
		` / ctx ${context.messages.length}${cost} / end ${result.reason}${RESET}`
	);
}

/**
 * 一条消息在回放里占的那一行。返回 `undefined` = 这条不单独占行。
 *
 * **只有两种东西值得回放:用户说的话,和模型说的正文。**
 * toolResult 和「只发了工具调用」的 assistant 都返回 undefined ——
 * 恢复一个规划过行程的会话动辄二十几条工具消息,原样打出来会把真正说过的话
 * 全挤出屏幕(实测 12 行里 11 行是 `[tool] …`,一句人话都看不见)。
 * 要细节有 `/ctx` 和会话文件,回放只回答「这是哪段对话」。
 */
function historyLine(message: Message): string | undefined {
	if (message.role === "user") {
		const text = typeof message.content === "string" ? message.content : "";
		return `${RESET}› ${oneLine(text, 100)}${DIM}`;
	}
	if (message.role !== "assistant") return undefined;
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	return text.trim() === "" ? undefined : `  ${oneLine(text, 100)}`;
}

/** 这条消息算不算「一次工具调用」。折叠计数用。 */
function isToolStep(message: Message): boolean {
	return message.role === "toolResult" || (message.role === "assistant" && historyLine(message) === undefined);
}

/**
 * 把恢复出来的历史回放成几行。
 *
 * **为什么非有不可**:`--resume` 之前只打一行「会话 xxx」,屏幕上和新开一个会话
 * 长得一模一样。用户没法确认自己接上的是哪一段,只能试探性地问一句去撞 ——
 * 而「模型记得刚才的事」恰恰是多轮唯一的卖点,看不见就等于没有。
 *
 * 中间跳过的工具消息折成一行 `⋯ N 步工具调用`:**不显示 ≠ 假装没发生过**,
 * 那 N 步是真花了钱、真进了上下文的。
 *
 * 只回放最后 `limit` 行:认出一段对话靠的是最后几句,不是第一句。
 */
export function formatHistory(messages: Message[], turns: number, limit = 12): string {
	const lines: string[] = [];
	let skipped = 0;
	const flush = () => {
		if (skipped > 0) lines.push(`  ⋯ ${skipped} 步工具调用`);
		skipped = 0;
	};
	for (const message of messages) {
		const line = historyLine(message);
		if (line === undefined) {
			if (isToolStep(message)) skipped++;
			continue;
		}
		flush();
		lines.push(line);
	}
	flush();

	const shown = lines.slice(-limit);
	const hidden = lines.length - shown.length;
	const head =
		`── 接着聊,历史 ${messages.length} 条 / ${turns} 轮` + `${hidden > 0 ? `,只回放最后 ${shown.length} 行` : ""} ──`;
	return `${DIM}${[head, ...shown, "── 以上是历史 ──"].join("\n")}${RESET}`;
}
