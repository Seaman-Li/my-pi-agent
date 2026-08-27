/**
 * 入口:读配置、解析参数、装配依赖、选一条路跑(单轮 or 多轮)。
 *
 * 层:入口 —— 唯一允许「知道一切」的地方。
 * 边界:不放业务逻辑(在 tools/core),不放装配(在 compose.ts),
 *       不放渲染(在 render.ts),不放多轮(在 repl.ts)。这里只剩参数、资源、路由。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { type Composed, compose } from "./compose.ts";
import { runTurn } from "./core/loop.ts";
import { DEFAULT_MODEL, type ModelSpec, resolveApiKey, resolveModel } from "./core/model.ts";
import { createRenderer, formatTurnSummary } from "./render.ts";
import { runRepl } from "./repl.ts";
import { createSession, hashPrompt, listSessions, resumeSession } from "./session/store.ts";
import { createTerminalAsker } from "./terminal-asker.ts";
import { type Terminal, isInteractive, openTerminal } from "./terminal.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `用法:
  node src/cli.ts "你的问题"          跑一轮就退
  node src/cli.ts                     进多轮会话
  node src/cli.ts --chat "你的问题"   用这句话开头,然后接着聊
  node src/cli.ts --resume            接着上一个会话聊
  node src/cli.ts --resume=<id>       接着指定的会话聊
  node src/cli.ts --sessions          列出最近的会话

开关:
  --model <qwen|local>  选模型,默认 ${DEFAULT_MODEL}
  --thinking            打开思考
  --trace               把四个挂载点的进出打到 stderr
  --help                这份说明
`;

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

/**
 * 给 system prompt 补一句「今天几号」。
 *
 * 模型不知道当前日期。实测用户说「10.1 去杭州玩 3 天」,它算不出那是五周以后,
 * 于是照常调了 `weather`,把今天起四天的预报当成国庆的天气报了出去 ——
 * 它自己都在回答里猜「这可能是因为系统当前时间的问题」。
 *
 * 这句话不写进 `prompts/system.md`:那个文件是**静态的规则**,而今天几号是
 * 每次运行都不同的事实。写死进去必然过期,而过期的日期比没有日期更糟。
 */
function withToday(systemPrompt: string): string {
	const today = new Date().toLocaleDateString("zh-CN", {
		year: "numeric",
		month: "long",
		day: "numeric",
		weekday: "long",
	});
	return `${systemPrompt}\n\n## 今天\n\n${today}。用户说的相对日期(「下周」「国庆」「10.1」)一律按这个算。`;
}

interface Args {
	prompt: string;
	model: string;
	thinking: boolean;
	trace: boolean;
	chat: boolean;
	help: boolean;
	/** 列会话然后退出。 */
	sessions: boolean;
	/** `undefined` = 不恢复;`""` = 恢复最近一个;其余 = 恢复这个 id。 */
	resume: string | undefined;
}

/**
 * 解析命令行。`--model` 吃掉后面一个参数,其余全部并成 prompt。
 *
 * 不认识的 `--xxx` 不报错,会被当成 prompt 的一部分 —— 开关还少,严格校验换不来什么。
 * 等开关多到会打错字了再收紧。
 */
function parseArgs(argv: string[]): Args {
	const rest: string[] = [];
	let model = DEFAULT_MODEL;
	let thinking = false;
	let trace = false;
	let chat = false;
	let help = false;
	let sessions = false;
	let resume: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--model") {
			model = argv[++i] ?? model;
		} else if (arg === "--thinking") {
			thinking = true;
		} else if (arg === "--trace") {
			trace = true;
		} else if (arg === "--chat") {
			chat = true;
		} else if (arg === "--sessions") {
			sessions = true;
		} else if (arg === "--resume") {
			// 写成 `--resume=<id>` 而不是 `--resume <id>`:后者没法区分
			// 「恢复最近一个,然后问这句话」和「恢复这个 id」—— 会把 prompt 吃掉。
			resume = "";
		} else if (arg.startsWith("--resume=")) {
			resume = arg.slice("--resume=".length);
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else {
			rest.push(arg);
		}
	}
	return { prompt: rest.join(" "), model, thinking, trace, chat, help, sessions, resume };
}

/**
 * 跑一次:发请求 → 渲染 → 给退出码。`--chat` 没开、又给了话的那条路。
 *
 * @returns 0 正常;1 模型侧失败或被中断
 */
async function runOnce(
	setup: { spec: ModelSpec; apiKey: string; context: Context; terminal?: Terminal },
	composed: Composed,
	reasoning: "low" | undefined,
): Promise<number> {
	const { spec, apiKey, context, terminal } = setup;

	// Ctrl-C 不是杀进程,是把 signal 传下去让请求和工具自己收尾。
	// 走 terminal 而不是 process:readline 接口开着的时候 TTY 上的 Ctrl-C
	// 只会触发它的 SIGINT,`process.on("SIGINT")` 收不到(terminal.ts 里有实测记录)。
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (terminal) terminal.onInterrupt(abort);
	else process.on("SIGINT", abort);

	const result = await runTurn({
		spec,
		apiKey,
		context,
		tools: composed.tools,
		hooks: composed.hooks,
		signal: controller.signal,
		sink: createRenderer(),
		reasoning,
	});
	terminal?.close();
	process.stdout.write(`${formatTurnSummary(spec, result, context)}\n`);
	// completed 之外都算没跑成:truncated 和 max_steps 也是「没给出完整答案」。
	return result.reason === "completed" ? 0 : 1;
}

/**
 * 读配置 → 装配 → 路由。
 *
 * @returns 进程退出码
 */
async function main(): Promise<number> {
	loadEnv();
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	const dataDir = join(PACKAGE_ROOT, "data", "sessions");
	if (args.sessions) {
		const found = listSessions(dataDir);
		if (found.length === 0) process.stdout.write(`还没有会话(${dataDir})\n`);
		for (const item of found) {
			process.stdout.write(`${item.id}  ${String(item.turns).padStart(3)} turn  ${item.first}\n`);
		}
		return 0;
	}

	// 没给话就是想聊天。`--chat` 是「给了话也要接着聊」,不是「进聊天模式」的唯一开关。
	// `--resume` 同理:恢复出来的历史只有在多轮里才有意义。
	const chat = args.chat || args.resume !== undefined || !args.prompt;

	const spec = resolveModel(args.model);
	const apiKey = resolveApiKey(spec.apiKeySource);
	const systemPrompt = withToday(readFileSync(join(PACKAGE_ROOT, "prompts", "system.md"), "utf8"));
	const context: Context = { systemPrompt, messages: [] };

	/**
	 * 装配。`asker` 只在**有终端而且是真人在敲**时才给。
	 *
	 * 管道喂进来的 chat 不算:那些行是一轮一轮的**提问**,`ask_user` 一旦注册,
	 * 它会把下一行当成答复吃掉,静默少跑一轮 —— 比「不会追问」难查得多。
	 */
	const build = (terminal: Terminal | undefined): Composed =>
		compose({
			outDir: join(PACKAGE_ROOT, "out"),
			trace: args.trace,
			asker: terminal && isInteractive() ? createTerminalAsker(terminal) : undefined,
		});

	const reasoning = args.thinking ? ("low" as const) : undefined;

	// 两条路各自决定要不要终端。单轮 + 管道两头不沾,根本不开 ——
	// 开着就得记得关(readline 不关,Node 不肯退),不开就没这回事。
	if (!chat) {
		const terminal = isInteractive() ? openTerminal() : undefined;
		context.messages.push({ role: "user", content: args.prompt, timestamp: Date.now() });
		return runOnce({ spec, apiKey, context, terminal }, build(terminal), reasoning);
	}
	const terminal = openTerminal();
	const composed = build(terminal);
	const promptHash = hashPrompt(systemPrompt);
	const restored =
		args.resume === undefined ? undefined : resumeSession(dataDir, { id: args.resume || undefined, promptHash });
	if (restored) {
		context.messages = restored.messages;
		if (restored.promptChanged) {
			// 不拦,只说一声。**接着聊的这段历史是在另一套规则下产生的** ——
			// 模型突然改了口径的时候,人得能想起来是这个原因。
			process.stderr.write("[提示] 这个会话存的时候 system prompt 和现在不一样,行为可能对不上\n");
		}
	}
	return runRepl({
		spec,
		apiKey,
		context,
		tools: composed.tools,
		hooks: composed.hooks,
		terminal,
		reasoning,
		seed: args.prompt || undefined,
		session: restored?.session ?? createSession(dataDir, { model: spec.model.id, promptHash }),
		ledger: restored?.ledger,
	});
}

main().then(
	(code) => {
		// 不自己 process.exit():它会掐断还没 flush 的 stdout,逐字输出的最后一行可能丢。
		// 交给 Node 自己收尾 —— 前提是没有还开着的 readline,所以两条路都记得 close。
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
