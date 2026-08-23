/**
 * 入口:读配置、解析参数、装配依赖、把事件渲染到终端。
 *
 * 层:入口 —— 唯一允许「知道一切」的地方,也是唯一允许有 console/stdout 的地方。
 * 边界:不放业务逻辑。这里长出来的判断,该去 core 或 features。
 *       Step 2 之后装配那部分搬去 compose.ts,本文件只留 IO 和渲染。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL, resolveApiKey, resolveModel, stream } from "./core/model.ts";
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
}

function parseArgs(argv: string[]): Args {
	const rest: string[] = [];
	let model = DEFAULT_MODEL;
	let thinking = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--model") {
			model = argv[++i] ?? model;
		} else if (arg === "--thinking") {
			thinking = true;
		} else {
			rest.push(arg);
		}
	}
	return { prompt: rest.join(" "), model, thinking };
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
		if (agentEvent.type === "error") {
			process.stderr.write(`\n[error] ${agentEvent.message}\n`);
			return;
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
				// Step 2 才会有工具可调;先让它可见,免得静默吞掉。
				process.stdout.write(`${DIM}[toolCall] ${event.toolCall.name}${RESET}\n`);
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

async function main(): Promise<number> {
	loadEnv();
	const args = parseArgs(process.argv.slice(2));
	if (!args.prompt) {
		process.stderr.write('用法: node src/cli.ts [--model qwen] [--thinking] "你的问题"\n');
		return 2;
	}

	const spec = resolveModel(args.model);
	const apiKey = resolveApiKey(spec.apiKeySource);
	const systemPrompt = readFileSync(join(PACKAGE_ROOT, "prompts", "system.md"), "utf8");

	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: args.prompt, timestamp: Date.now() }],
	};

	// Ctrl-C 不是杀进程,是把 signal 传下去让请求自己收尾。
	// Step 3 这条 signal 还要继续传进每个工具。
	const controller = new AbortController();
	process.on("SIGINT", () => controller.abort());

	const message = await stream(spec, {
		context,
		apiKey,
		signal: controller.signal,
		sink: createRenderer(),
		reasoning: args.thinking ? "low" : undefined,
	});

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		process.stderr.write(`\n[${message.stopReason}] ${message.errorMessage ?? ""}\n`);
		return 1;
	}
	const usage = message.usage;
	process.stdout.write(
		`${DIM}[${message.model}] in ${usage.input} / out ${usage.output} / stop ${message.stopReason}${RESET}\n`,
	);
	return 0;
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
