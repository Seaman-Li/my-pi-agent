/**
 * trace —— 第一块积木,也是用来验证挂载点确实通了的那块。
 *
 * 层:features。它只往 `Hooks` 里 push,不碰 loop 一个字 ——
 *     「加功能不改 loop」这条规矩,从它开始验证。
 * 边界:只读不改。`beforeStep` 拿到 context 也不动它,`afterToolCall` 拿到 result 也不改。
 *       Step 9 会把它扩成完整版(带 --replay),那时才需要落盘。
 */

import type { Hooks } from "../core/hooks.ts";
import { textOf } from "../core/types.ts";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** 一行摘要,给终端用。 */
function brief(value: unknown, limit = 60): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 一条 trace 行。统一前缀 + 暗色,方便和正文区分。 */
function line(text: string): void {
	process.stderr.write(`${DIM}[trace] ${text}${RESET}\n`);
}

/**
 * 把 trace 挂到四个挂载点上。
 *
 * 写到 stderr 而不是 stdout:正文走 stdout,诊断走 stderr,
 * `node src/cli.ts ... > plan.md` 才不会把 trace 混进产物里。
 */
export function installTrace(hooks: Hooks): void {
	hooks.beforeStep.push(({ step, context }) => {
		line(`beforeStep  #${step}  messages=${context.messages.length}`);
	});
	hooks.beforeToolCall.push(({ step, toolCall }) => {
		line(`beforeToolCall  #${step}  ${toolCall.name} ${brief(toolCall.arguments)}`);
	});
	hooks.afterToolCall.push(({ step, toolCall, result }) => {
		const mark = result.isError ? "ERR" : "ok";
		line(`afterToolCall   #${step}  ${toolCall.name} ${mark} ${brief(textOf(result.content))}`);
	});
	// `sys=` 挂在 afterStep 而不是 beforeStep:注入 system prompt 的 handler
	// 也在 beforeStep 上,而且排在 trace 后面 —— 在那儿打出来的是**注入之前**的长度,
	// 正好错过要看的东西。afterStep 拿到的才是这一步真正发出去的那份。
	// Q7 的分诊线要的就是它:模型忘了「不爬山」时,先看这个数有没有比 base 大。
	hooks.afterStep.push(({ step, message, results, context }) => {
		const kinds = message.content.map((block) => block.type).join(",") || "empty";
		line(
			`afterStep   #${step}  stop=${message.stopReason} content=[${kinds}]` +
				` out=${message.usage.output} tools=${results.length} sys=${context.systemPrompt?.length ?? 0}`,
		);
	});
}
