/**
 * 多轮驱动:读一行 → 跑一个 turn → 再读一行,历史一路累积在同一个 `Context` 里。
 *
 * 层:入口 —— 和 cli.ts 平级的第二个驱动。它可以写终端,但格式一律走 render.ts。
 * 边界:**它是「轮次」这个概念唯一存在的地方。** core 只认识 turn(一轮之内),
 *       工具只认识一次调用;「上一轮说过什么」不属于它们任何一个。
 *       Step 5a 的历史只在内存里,进程一退就没 —— 落盘是 5b(session/store.ts)。
 */

import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
import { dropEmptyAssistantMessages, repairDanglingToolCalls } from "./core/context.ts";
import type { Hooks } from "./core/hooks.ts";
import type { Compactor } from "./features/compaction.ts";
import { runTurn } from "./core/loop.ts";
import { isTurnFailure } from "./core/types.ts";
import type { ModelSpec } from "./core/model.ts";
import type { Registry } from "./core/registry.ts";
import { DIM, RESET, createRenderer, formatHistory, formatTurnSummary } from "./render.ts";
import type { Session } from "./session/store.ts";
import type { Ledger } from "./session/types.ts";
import type { Terminal } from "./terminal.ts";

export interface ReplOptions {
	spec: ModelSpec;
	apiKey: string;
	/** 会被一路原地追加。REPL 自己不存历史,历史就是这个对象。 */
	context: Context;
	tools: Registry;
	hooks: Hooks;
	terminal: Terminal;
	reasoning?: ThinkingLevel;
	/** 第一轮不等输入,直接用它。给 `--chat "…"` 用。 */
	seed?: string;
	/** 这次对话记到哪儿。**必给** —— 会话记录不是可选功能,是 Step 9 定位问题的唯一素材。 */
	session: Session;
	/** `--resume` 恢复出来的账。不给就从 0 开始。 */
	ledger?: Ledger;
	/**
	 * 手动压一次上下文。不给就**没有 `/compact` 这个命令** ——
	 * 和 `ask_user`、`remember` 同一条:能力不在,入口也不该在。
	 */
	compact?: Compactor;
}

/**
 * 补给断链 toolCall 的说辞。**这句话会进上下文给模型看**,所以它是写给模型的,
 * 不是写给人的 —— 说清楚「没执行」和「为什么」,它才知道可以提议重来。
 */
const INTERRUPT_NOTE = "这次调用没有执行:上一轮被用户中断了。需要的话可以重新发起。";

const HELP = [
	"/exit        退出(Ctrl-D 或连按两次 Ctrl-C 一样)",
	"/new         清空历史,从头开始(记录文件里旧的那段不删,只是不再发给模型)",
	"/ctx         看看现在的历史有多少、都是些什么、记到哪个文件了",
	"/compact     现在就把前面的历史压成一句摘要(平时它会在快撑满时自己压)",
	"/help        这份说明",
	"",
	"退出之后 `node src/cli.ts --resume` 接着聊,`--sessions` 看有哪些会话。",
].join("\n");


/** 打印当前历史的构成。`/ctx` 用 —— 多轮的全部意义就是这个数字在涨。 */
function describeContext(context: Context): string {
	const counts = { user: 0, assistant: 0, toolResult: 0 } as Record<string, number>;
	let chars = 0;
	for (const message of context.messages) {
		counts[message.role] = (counts[message.role] ?? 0) + 1;
		chars += JSON.stringify(message.content).length;
	}
	return (
		`历史 ${context.messages.length} 条(user ${counts.user} / assistant ${counts.assistant} / ` +
		`toolResult ${counts.toolResult}),约 ${chars} 字符`
	);
}

/**
 * 处理以 `/` 开头的输入。
 *
 * 不认识的命令**不当成普通消息发出去**:一句话打错了大不了重打一遍,
 * 而把 `/exit` 当聊天发给模型会白花一次请求还看不出发生了什么。
 * 真想让模型看见 `/` 开头的字,前面加个空格。
 *
 * @returns true 表示该退出了
 */
async function handleCommand(
	input: string,
	context: Context,
	session: Session,
	compact: Compactor | undefined,
): Promise<boolean> {
	const name = input.split(/\s+/)[0];
	switch (name) {
		case "/exit":
		case "/quit":
			return true;
		case "/new":
			context.messages = [];
			// **文件里一条都不删** —— 只是把游标挪回会话头,后面的消息挂在它下面。
			// 旧的那串还在文件里,`--resume` 走的是「从最后一行往回」,自然绕开它。
			session.reset();
			process.stdout.write(`${DIM}(历史已清空,旧的那段还在记录文件里,只是不再发给模型)${RESET}\n`);
			return false;
		case "/ctx":
			process.stdout.write(`${DIM}${describeContext(context)}\n记录:${session.path}${RESET}\n`);
			return false;
		case "/compact": {
			if (!compact) {
				process.stdout.write(`${DIM}这次运行没开压缩(--no-compact),/compact 不可用${RESET}\n`);
				return false;
			}
			// 手动这条路**不看阈值**:用户说压就压。阈值是替他判断「什么时候该压」,
			// 他自己开口的时候那个判断就没有意义了。
			const outcome = await compact(context, "manual");
			process.stdout.write(`${DIM}${outcome.note}${RESET}\n`);
			return false;
		}
		case "/help":
			process.stdout.write(`${DIM}${HELP}${RESET}\n`);
			return false;
		default:
			process.stdout.write(`${DIM}不认识的命令 ${name},/help 看有哪些${RESET}\n`);
			return false;
	}
}

/**
 * 跑一个会话,直到用户退出或者输入结束。
 *
 * @returns 退出码。0 正常;1 有 turn 以「非正常也非用户中断」的理由结束过。
 *          **aborted 不算失败** —— 那是用户按了 Ctrl-C,是决定不是故障。
 */
export async function runRepl(options: ReplOptions): Promise<number> {
	const { spec, apiKey, context, tools, hooks, terminal, session } = options;
	// `--resume` 时从文件里恢复出来的账接着往下记,不然「这个会话花了多少」永远算不对。
	const ledger: Ledger = options.ledger ?? { turns: 0, input: 0, output: 0, cost: 0 };
	/** 有没有出现过「既不是正常说完、也不是用户主动中断」的结局。决定退出码。 */
	let failed = false;
	/** broken 只报一次 —— 一直失败一直报,只会把正经输出淹掉。 */
	let toldBroken = false;

	/** 落盘出过事就说一声。**不因此中断对话** —— 聊天比记账重要。 */
	function reportBroken(): void {
		if (session.broken === undefined || toldBroken) return;
		toldBroken = true;
		process.stderr.write(`\n[会话记录写不下去了] ${session.broken}\n从这里往后不再落盘,对话照常。\n`);
	}

	// 当前正在跑的那一轮。Ctrl-C 要找的就是它。
	//
	// **每轮一个新的 AbortController,不能全程共用一个**:controller 是一次性的,
	// 一旦 abort 就永远是 aborted 状态。共用的话,用户中断第一轮之后,
	// 第二轮的 `signal.aborted` 开局就是 true,loop.ts:244 直接判 aborted 退出 ——
	// 表现是「按过一次 Ctrl-C 之后再也问不出东西」,而且不报任何错。
	let active: AbortController | null = null;
	let idleInterrupts = 0;

	terminal.onInterrupt(() => {
		if (active && !active.signal.aborted) {
			active.abort();
			return;
		}
		// 提示符上按 Ctrl-C:第一次给个提醒,连着第二次才退。
		// 一次就退太容易误伤 —— 打了半行想清空,结果整个会话没了。
		idleInterrupts++;
		if (idleInterrupts >= 2) {
			terminal.close();
			return;
		}
		process.stdout.write(`\n${DIM}(再按一次 Ctrl-C 退出,或输入 /exit)${RESET}\n`);
	});

	process.stdout.write(
		`${DIM}pi-travel-agent · ${spec.model.id} · 多轮会话\n` +
			`会话 ${session.id}(${session.path})\n` +
			`退出后 \`--resume\` 接着聊。/help 看命令${RESET}\n`,
	);

	// 恢复出来的历史要**看得见**。只说一句「会话 xxx」的话,屏幕上和新开一个一模一样。
	if (context.messages.length > 0) {
		process.stdout.write(`${formatHistory(context.messages, ledger.turns)}\n`);
	}

	let seed = options.seed?.trim() || undefined;
	while (true) {
		let line: string | null;
		if (seed !== undefined) {
			// 种子这一轮把用户「说的话」补打出来,不然转录里会凭空冒出一段回答。
			process.stdout.write(`\n› ${seed}\n`);
			line = seed;
			seed = undefined;
		} else {
			line = await terminal.question("\n› ");
		}
		// null 是「没有用户了」(Ctrl-D / 管道喂完 / 终端被关),不是「什么都没说」。
		if (line === null) break;
		idleInterrupts = 0;

		const text = line.trim();
		if (!text) continue;
		if (text.startsWith("/")) {
			if (await handleCommand(text, context, session, options.compact)) break;
			continue;
		}

		context.messages.push({ role: "user", content: text, timestamp: Date.now() });
		// **先把这句话落盘,再去发请求。** turn 可能跑很久、可能被 kill,
		// 而「用户说了什么」是整份记录里最不该丢的东西 —— 它是重放的起点。
		session.sync(context.messages);
		reportBroken();
		ledger.turns++;

		const controller = new AbortController();
		active = controller;
		let result: Awaited<ReturnType<typeof runTurn>>;
		try {
			result = await runTurn({
				spec,
				apiKey,
				context,
				tools,
				hooks,
				signal: controller.signal,
				sink: createRenderer(),
				reasoning: options.reasoning,
			});
		} finally {
			active = null;
		}

		// **一轮结束就把历史收拾干净,而不是等下一轮开头。**
		// 这样 `/ctx` 和摘要行里的 `ctx` 看到的永远是「能直接再发一次」的状态,
		// 不存在「看着是 21 条,其实发出去会变成 25 条」这种要在脑子里补的差。
		const repaired = repairDanglingToolCalls(context, INTERRUPT_NOTE);
		const dropped = dropEmptyAssistantMessages(context);
		if (repaired > 0) {
			process.stdout.write(`${DIM}(有 ${repaired} 个工具调用没跑完,已在历史里记成「被中断」)${RESET}\n`);
		}
		if (dropped > 0) {
			// 请求根本没成功,历史里不留这一轮的痕迹 —— 直接再说一遍就行,不用换个说法。
			process.stdout.write(`${DIM}(这一轮没发成,历史没变,重说一次即可)${RESET}\n`);
		}

		// 落盘放在收拾历史**之后**:先补链、先丢空消息,写下去的才是一份能直接再发一次的记录。
		// 反过来的话,文件里会留下我们自己制造的断链,而下次 --resume 会当场报错。
		session.sync(context.messages);
		session.recordTurn(result);
		reportBroken();

		ledger.input += result.usage.input;
		ledger.output += result.usage.output;
		ledger.cost += result.usage.cost.total;
		if (isTurnFailure(result.reason)) failed = true;
		if (result.reason === "aborted") process.stdout.write(`${DIM}(已中断)${RESET}\n`);
		process.stdout.write(`${formatTurnSummary(spec, result, context, ledger.turns)}\n`);
	}

	terminal.close();
	const cost = ledger.cost > 0 ? ` / $${ledger.cost.toFixed(4)}` : "";
	process.stdout.write(
		`${DIM}[会话结束] ${ledger.turns} turn / in ${ledger.input} / out ${ledger.output}` +
			` / ctx ${context.messages.length}${cost}\n接着聊:node src/cli.ts --resume=${session.id}${RESET}\n`,
	);
	return failed ? 1 : 0;
}
