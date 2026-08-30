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
import { createTokenMeter } from "./core/estimate.ts";
import { DEFAULT_MODEL, type ModelSpec, resolveApiKey, resolveModel, usableTokens } from "./core/model.ts";
import { isAnswerComplete } from "./core/types.ts";
import { extractMemories } from "./memory/extract.ts";
import { type MemoryStore, openMemory } from "./memory/store.ts";
import { createRenderer, DIM, formatTurnSummary, RESET } from "./render.ts";
import { runRepl } from "./repl.ts";
import { createSession, hashPrompt, listSessions, resumeSession, type Session } from "./session/store.ts";
import { isInteractive, openTerminal, type Terminal } from "./terminal.ts";
import { createTerminalAsker } from "./terminal-asker.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `用法:
  node src/cli.ts "你的问题"          跑一轮就退
  node src/cli.ts                     进多轮会话
  node src/cli.ts --chat "你的问题"   用这句话开头,然后接着聊
  node src/cli.ts --resume            接着上一个会话聊
  node src/cli.ts --resume=<id>       接着指定的会话聊
  node src/cli.ts --sessions          列出最近的会话

开关:
  --model <qwen|local|deepseek>
                        选模型,默认 ${DEFAULT_MODEL}
  --thinking            打开思考
  --trace               把四个挂载点的进出打到 stderr
  --no-memory           这次不读也不写 data/memory.json
  --no-compact          这次不压上下文(长了也不压,撞窗口就撞)
  --no-guard            这次不拦域外提问、也不限单条输入长度
  --resume-full         恢复时忽略压缩点,读回压缩前的完整历史
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
	/** 跨会话记忆开不开。`--no-memory` 关。 */
	memory: boolean;
	/** 上下文压缩开不开。`--no-compact` 关。 */
	compaction: boolean;
	/** 域外拦截 + 输入上限开不开。`--no-guard` 关。 */
	guard: boolean;
	/** 恢复时读压缩前的完整历史。`--resume-full` 开。 */
	resumeFull: boolean;
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
	let memory = true;
	let compaction = true;
	let guard = true;
	let resumeFull = false;
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
		} else if (arg === "--no-memory") {
			memory = false;
		} else if (arg === "--no-compact") {
			compaction = false;
		} else if (arg === "--no-guard") {
			guard = false;
		} else if (arg === "--resume-full") {
			// 只影响「读回来的是哪一份历史」,不影响往后怎么记 —— 压缩点还在文件里,
			// 这次聊的照样往后追加。
			resumeFull = true;
			resume ??= "";
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
	return {
		prompt: rest.join(" "),
		model,
		thinking,
		trace,
		chat,
		help,
		sessions,
		resume,
		memory,
		compaction,
		guard,
		resumeFull,
	};
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
	// 判据收在 core/types.ts 的 exhaustive switch 里,不散在这儿写 ——
	// 加一个 TurnEndReason 成员时,那边会报错,这里不会。
	return isAnswerComplete(result.reason) ? 0 : 1;
}

/**
 * 散场之后抽记忆最多等这么久。用户已经说完再见了,超过这个数就不值得再等 ——
 * 大不了这次没收成,下次对话再说一遍。
 */
const EXTRACT_TIMEOUT_MS = 25_000;

/**
 * 会话散场之后回看一遍转录,把长期偏好收进记忆。
 *
 * 放在 `runRepl` **返回之后**而不是 repl.ts 里面:repl 只该管「终端上那个 while」,
 * 它不认识记忆、不认识旅行 —— 这条边界是将来把 repl.ts 整个搬进框架包的前提。
 * 代价是这行提示落在「会话结束」那行之后,而那正好也是它该在的位置。
 *
 * 这时候 readline 已经关了,所以 Ctrl-C 又回到了 `process` 上(terminal.ts 里有实测)。
 *
 * 出了任何事都只打一行、不改退出码:这一步跑不成,不影响这次对话已经完成的事。
 */
async function harvest(setup: {
	spec: ModelSpec;
	apiKey: string;
	store: MemoryStore;
	context: Context;
}): Promise<void> {
	const controller = new AbortController();
	const onInterrupt = () => controller.abort();
	process.on("SIGINT", onInterrupt);
	try {
		const result = await extractMemories({
			spec: setup.spec,
			apiKey: setup.apiKey,
			prompt: readFileSync(join(PACKAGE_ROOT, "prompts", "extract.md"), "utf8"),
			messages: setup.context.messages,
			store: setup.store,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(EXTRACT_TIMEOUT_MS)]),
		});
		process.stdout.write(`${DIM}[记忆] ${result.note}(现有 ${setup.store.items().length} 条)${RESET}\n`);
	} catch (error) {
		process.stderr.write(`[记忆] 这次没收成:${error instanceof Error ? error.message : String(error)}\n`);
	} finally {
		process.off("SIGINT", onInterrupt);
	}
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
	/**
	 * `rules` 和 `systemPrompt` 要分开拿,因为**只有前者该进 promptHash**。
	 *
	 * promptHash 回答的是「这段历史是不是在同一套规则下产生的」。而 `withToday`
	 * 每天都不一样、记忆块每记一条就变 —— 把它们算进去的话,昨天的会话今天 `--resume`
	 * 必然报「system prompt 变了」。**每次都报的提醒等于没有提醒**,真改了规则那次也认不出来。
	 */
	const rules = readFileSync(join(PACKAGE_ROOT, "prompts", "system.md"), "utf8");
	const systemPrompt = withToday(rules);
	const context: Context = { systemPrompt, messages: [] };
	const memoryPath = join(PACKAGE_ROOT, "data", "memory.json");

	/**
	 * 单条用户输入的上限:**可用输入的 25%**。
	 *
	 * 不写死一个数,理由和压缩阈值一样 —— 它得跟着 provider 走
	 * (本地 8K 和 deepseek 1M 差两个数量级)。25% 表达的是一句话:
	 * **一条消息不该吃掉超过四分之一的可用空间**,否则剩下的历史和回答都没地方放,
	 * 而压缩救不了这种(一条消息没法自己压自己)。
	 */
	const maxUserTokens = Math.floor(usableTokens(spec) * 0.25);
	// 一个进程一个实例:校准比值是会话级的,而这个进程只服务一个会话。
	const meter = createTokenMeter();

	/**
	 * 装配。`asker` 只在**有终端而且是真人在敲**时才给。
	 *
	 * 管道喂进来的 chat 不算:那些行是一轮一轮的**提问**,`ask_user` 一旦注册,
	 * 它会把下一行当成答复吃掉,静默少跑一轮 —— 比「不会追问」难查得多。
	 *
	 * `basePrompt` 给的是 `systemPrompt`(含「今天」不含记忆)—— 和 `context.systemPrompt`
	 * 初值是同一份,这样记忆注入是「重新拼」而不是「往后接」。
	 */
	const build = (terminal: Terminal | undefined, memory: MemoryStore | undefined, session?: Session): Composed =>
		compose({
			outDir: join(PACKAGE_ROOT, "out"),
			trace: args.trace,
			asker: terminal && isInteractive() ? createTerminalAsker(terminal) : undefined,
			memory: memory && { store: memory, basePrompt: systemPrompt },
			guard: args.guard ? { meter, maxUserTokens } : undefined,
			// **没有 session 就不装压缩。** 单轮模式不建会话文件(见 BACKLOG),
			// 而压缩必须留下压缩点 —— 一段历史被换掉却没人记下来,是查不回来的信息丢失。
			compaction:
				args.compaction && session
					? {
							spec,
							apiKey,
							prompt: readFileSync(join(PACKAGE_ROOT, "prompts", "compact.md"), "utf8"),
							session,
							notify: (outcome) => process.stdout.write(`${DIM}[压缩] ${outcome.note}${RESET}\n`),
						}
					: undefined,
		});

	const reasoning = args.thinking ? ("low" as const) : undefined;

	// 两条路各自决定要不要终端。单轮 + 管道两头不沾,根本不开 ——
	// 开着就得记得关(readline 不关,Node 不肯退),不开就没这回事。
	if (!chat) {
		const memory = args.memory ? openMemory(memoryPath) : undefined;
		const terminal = isInteractive() ? openTerminal() : undefined;
		context.messages.push({ role: "user", content: args.prompt, timestamp: Date.now() });
		return runOnce({ spec, apiKey, context, terminal }, build(terminal, memory), reasoning);
	}

	// **开终端放在这一段的最后。** 上面这几步都可能抛(会话文件被手改坏、记忆文件被手改坏),
	// 而 readline 一旦开着,Node 就不肯退 —— 屏幕上会是「一条错误 + 一个不动的进程」。
	const promptHash = hashPrompt(rules);
	const restored =
		args.resume === undefined
			? undefined
			: resumeSession(dataDir, { id: args.resume || undefined, promptHash, full: args.resumeFull });
	if (restored) {
		context.messages = restored.messages;
		if (restored.compactions > 0) {
			// **必须说。** 压缩过的会话恢复出来比用户上次看见的短,不说的话他会以为记录丢了。
			process.stderr.write(
				restored.full
					? `[提示] 这个会话压缩过 ${restored.compactions} 次,--resume-full 读的是压缩前的完整历史\n`
					: `[提示] 这个会话压缩过 ${restored.compactions} 次,前面那段是摘要;想看原文用 --resume-full\n`,
			);
		}
		if (restored.promptChanged) {
			// 不拦,只说一声。**接着聊的这段历史是在另一套规则下产生的** ——
			// 模型突然改了口径的时候,人得能想起来是这个原因。
			process.stderr.write("[提示] 这个会话存的时候 system prompt 和现在不一样,行为可能对不上\n");
		}
	}
	const session = restored?.session ?? createSession(dataDir, { model: spec.model.id, promptHash });
	// 记忆条目上盖一个会话号:人翻 memory.json 看到一条离谱的记忆,能顺着它回到当时的对话。
	const memory = args.memory ? openMemory(memoryPath, { session: session.id }) : undefined;
	const terminal = openTerminal();
	const composed = build(terminal, memory, session);

	const code = await runRepl({
		spec,
		apiKey,
		context,
		tools: composed.tools,
		hooks: composed.hooks,
		terminal,
		reasoning,
		seed: args.prompt || undefined,
		session,
		ledger: restored?.ledger,
		compact: composed.compact,
	});
	if (memory && context.messages.length > 0) await harvest({ spec, apiKey, store: memory, context });
	return code;
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
