/**
 * 入口 ②:跑 `cases/adversarial.jsonl` 那套域外拦截用例。`node src/run-cases.ts`
 *
 * 层:入口 —— 和 cli.ts 平级的第二个驱动,只是它驱动的不是对话,是判定。
 * 边界:**一次模型请求都不发,一个环境变量都不读。** 它测的是 `features/guard.ts`
 *       里那几个纯函数,所以免费、确定、可以每次收尾跑。
 *       8b 的注入用例做不到这一点(要验的恰恰是模型的行为),那批得另开一个入口。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTokenMeter } from "./core/estimate.ts";
import { checkLength, classify } from "./features/guard.ts";
import { DIM, RESET } from "./render.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 一条用例。
 *
 * 四种 `kind` 不是分类标签,是**四种不同的断言**:
 *
 * - `ood`       该被拦,而且要被**指定的那条规则**拦。只断言「被拦了」不够 ——
 *               规则改动之后一条用例从「被 A 拦」变成「被 B 误伤」,测试照样绿。
 * - `benign`    **绝不能被拦**。这是误伤守卫,是这套用例里最值钱的一半:
 *               宁可漏不可误伤,而「漏」没法穷举,「误伤」可以。
 * - `known-gap` 明知拦不住,**预期就是放行**。把它写下来是为了把边界钉死 ——
 *               哪天变红了,得先想清楚是边界该改还是规则加宽错了。
 * - `length`    长度闸。带 `ratio` 是因为**有效上限跟着语言走**,得两档都测。
 * - `note`      文件开头那条说明,跳过。
 */
interface Case {
	id: string;
	kind: "ood" | "benign" | "known-gap" | "length" | "note";
	input: string;
	why: string;
	/** `ood` 专用:该被哪条规则拦。 */
	rule?: string;
	/** `length` 专用:把 `input` 重复几遍凑长度 —— 免得往 jsonl 里塞几万字。 */
	repeat?: number;
	/** `length` 专用:用哪个校准比值。1 = 冷启动。 */
	ratio?: number;
	/** `length` 专用:上限。 */
	limit?: number;
	/** `length` 专用:这条的预期是「放行」而不是「拦下」。 */
	expectPass?: boolean;
}

interface Outcome {
	id: string;
	ok: boolean;
	/** 一句话说清实际发生了什么。**过了的也写** —— 「被哪条拦的」本身就是要看的信息。 */
	note: string;
	why: string;
}

/**
 * 读用例文件。
 *
 * @throws 某行不是合法 JSON 时抛,带行号 —— 和 session/store.ts 同一条规矩:
 *         这个文件是给人手写的,报「第几行」才改得动。
 */
function readCases(path: string): Case[] {
	const cases: Case[] = [];
	for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
		if (line.trim() === "") continue;
		try {
			cases.push(JSON.parse(line) as Case);
		} catch (error) {
			throw new Error(`${path}:${index + 1} 不是合法 JSON:${error instanceof Error ? error.message : ""}`);
		}
	}
	return cases;
}

/** 跑一条,返回它的结局。 */
function runCase(item: Case): Outcome {
	const base = { id: item.id, why: item.why };
	if (item.kind === "length") {
		const text = item.input.repeat(item.repeat ?? 1);
		const meter = createTokenMeter(item.ratio ?? 1);
		const limit = item.limit ?? 2000;
		const rejected = checkLength(text, meter, limit);
		const tokens = meter.estimateText(text);
		const want = item.expectPass !== true;
		return {
			...base,
			ok: rejected === want,
			note: `${text.length} 字符 / 比值 ${item.ratio ?? 1} → 估 ${tokens} token,上限 ${limit} → ${rejected ? "拦下" : "放行"}`,
		};
	}

	const verdict = classify(item.input);
	if (item.kind === "ood") {
		if (!verdict) return { ...base, ok: false, note: "**没拦住**(预期被 " + item.rule + " 拦)" };
		if (verdict.rule !== item.rule) {
			return { ...base, ok: false, note: `被 ${verdict.rule} 拦了,但预期是 ${item.rule} —— 规则边界挪了` };
		}
		return { ...base, ok: true, note: `被 ${verdict.rule} 拦下` };
	}
	// benign 和 known-gap 的断言是同一个(必须放行),分开只为了让人一眼看出**为什么**该放行。
	if (verdict) {
		const label = item.kind === "benign" ? "**误伤**" : "**拦住了不该拦的**";
		return { ...base, ok: false, note: `${label}:被 ${verdict.rule} 拦了` };
	}
	return { ...base, ok: true, note: "放行" };
}

/**
 * 跑全部用例,打一张表。
 *
 * @returns 退出码。0 全过;1 有红的 —— 可以直接挂进 CI 或者收尾脚本。
 */
function main(): number {
	const path = join(PACKAGE_ROOT, "cases", "adversarial.jsonl");
	const cases = readCases(path).filter((item) => item.kind !== "note");
	const outcomes = cases.map(runCase);
	const failed = outcomes.filter((outcome) => !outcome.ok);

	for (const [index, outcome] of outcomes.entries()) {
		const kind = cases[index]?.kind ?? "";
		const mark = outcome.ok ? "✓" : "✗";
		process.stdout.write(`${mark} ${outcome.id.padEnd(20)} ${kind.padEnd(10)} ${outcome.note}\n`);
		// 红的才把「为什么有这条用例」也打出来 —— 全打会把表淹掉,而修的时候正需要这句。
		if (!outcome.ok) process.stdout.write(`${DIM}    ${outcome.why}${RESET}\n`);
	}

	const byKind = new Map<string, number>();
	for (const item of cases) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
	const summary = [...byKind].map(([kind, count]) => `${kind} ${count}`).join(" / ");
	process.stdout.write(`\n${cases.length} 条(${summary}),${failed.length === 0 ? "全过" : `${failed.length} 条没过`}\n`);
	return failed.length === 0 ? 0 : 1;
}

process.exitCode = main();
