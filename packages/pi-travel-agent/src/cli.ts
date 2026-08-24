/**
 * 入口:读配置、解析参数、装配依赖、把事件渲染到终端。
 *
 * 层:入口 —— 唯一允许「知道一切」的地方,也是唯一允许有 console/stdout 的地方。
 * 边界:不放业务逻辑,也不放装配 —— 装配在 compose.ts。这里只剩参数、IO、渲染。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { compose } from "./compose.ts";
import { runTurn } from "./core/loop.ts";
import { DEFAULT_MODEL, resolveApiKey, resolveModel } from "./core/model.ts";
import type { AgentEvent, EventSink } from "./core/types.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 读 .env。Node 22 自带 `process.loadEnvFile`,不需要 dotenv。
 * 没有 .env 也能跑 —— 那就走进程本身的环境变量(CI / 临时覆盖)。
 */
function loadEnv(): void {
	try {
		process.loadEnvFile(join(PACKAGE_ROOT, ".env"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface Args {
	prompt: string;
	model: string;
	thinking: boolean;
	trace: boolean;
}

/**
 * 解析命令行。`--model` 吃掉后面一个参数,其余全部并成 prompt。
 *
 * 不认识的 `--xxx` 不报错,会被当成 prompt 的一部分 —— Step 1 只有两个开关,
 * 严格校验换不来什么。等开关多到会打错字了再收紧。
 */
function parseArgs(argv: string[]): Args {
	const rest: string[] = [];
	let model = DEFAULT_MODEL;
	let thinking = false;
	let trace = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--model") {
			model = argv[++i] ?? model;
		} else if (arg === "--thinking") {
			thinking = true;
		} else if (arg === "--trace") {
			trace = true;
		} else {
			rest.push(arg);
		}
	}
	return { prompt: rest.join(" "), model, thinking, trace };
}

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
 * 把 pi-ai 的流式事件压成终端输出。
 *
 * 只认边界事件(*_start / *_end)决定换行和缩进,内容一律来自 *_delta ——
 * 不要用「上一次是不是同一种块」来猜边界,那正是 adapter 层已经替你算好的东西。
 */
function createRenderer(): EventSink {
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
				// 只收拾终端状态,不打印 —— 失败的最终裁决归 main,
				// 它读 stopReason。渲染器打一遍、main 再打一遍就成了噪声。
				if (thinkingOpen) process.stdout.write(RESET);
				break;
			default:
				break;
		}
	};
}

/**
 * 跑一次:读配置 → 装配 → 发请求 → 渲染 → 给退出码。
 *
 * 返回退出码而不是自己 `process.exit()`:exit 会掐断还没 flush 的 stdout,
 * 逐字输出的最后一行可能丢。交给调用方设 `process.exitCode`,让 Node 自己收尾。
 *
 * @returns 0 正常;1 模型侧失败或被中断;2 用法错误
 */
async function main(): Promise<number> {
	loadEnv();
	const args = parseArgs(process.argv.slice(2));
	if (!args.prompt) {
		process.stderr.write('用法: node src/cli.ts [--model qwen] [--thinking] [--trace] "你的问题"\n');
		return 2;
	}

	const spec = resolveModel(args.model);
	const apiKey = resolveApiKey(spec.apiKeySource);
	const systemPrompt = readFileSync(join(PACKAGE_ROOT, "prompts", "system.md"), "utf8");

	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: args.prompt, timestamp: Date.now() }],
	};

	const { tools, hooks } = compose({ trace: args.trace });

	// Ctrl-C 不是杀进程,是把 signal 传下去让请求和工具自己收尾。
	const controller = new AbortController();
	process.on("SIGINT", () => controller.abort());

	const result = await runTurn({
		spec,
		apiKey,
		context,
		tools,
		hooks,
		signal: controller.signal,
		sink: createRenderer(),
		reasoning: args.thinking ? "low" : undefined,
	});

	const { usage } = result;
	process.stdout.write(
		`${DIM}[${spec.model.id}] ${result.steps} step / in ${usage.input} / out ${usage.output}` +
			` / end ${result.reason}${RESET}\n`,
	);
	// completed 之外都算没跑成:truncated 和 max_steps 也是「没给出完整答案」。
	return result.reason === "completed" ? 0 : 1;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
