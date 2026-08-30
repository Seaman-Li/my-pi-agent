/**
 * compaction —— 上下文快装不下时,把前面一段历史换成一句摘要。
 *
 * 层:features。挂 `afterStep`,**loop.ts 一个字都不改**。
 * 边界:它是全项目**唯一会让 `context.messages` 变短**的地方。变短这件事在
 *       append-only 的记录里表达不了,所以它必须走 `session.compact()` 落一条压缩点,
 *       不能自己改数组 —— 绕过去的话下一次 `sync` 会当场抛。
 *       摘要怎么写是域知识,由入口从 `prompts/compact.md` 读了传进来,不写在这儿。
 */

import type { Context, Message } from "@earendil-works/pi-ai";
import { promptTokensOf } from "../core/estimate.ts";
import type { AfterStepContext, Hooks } from "../core/hooks.ts";
import { type ModelSpec, stream, usableTokens } from "../core/model.ts";
import { textOf } from "../core/types.ts";
import type { Session } from "../session/store.ts";
import type { CompactionEntry } from "../session/types.ts";

/**
 * 阈值取「可用输入」的百分之多少。
 *
 * **分母是 `contextWindow − maxTokens`,不是 `contextWindow`。** 后者看着更简单但不自洽:
 * 留下 20% 对 qwen(maxTokens 65K)绰绰有余,对 deepseek(maxTokens 384K)根本不够,
 * 模型吐满照样撞窗口 —— 要让它成立,百分比上限本身就得跟着 provider 变,
 * 等于把刚赶走的 per-provider 表又请回来。取在可用输入上,一个常数就够,
 * 而且 23 倍的 `maxTokens` 差异自动被吸收掉。
 *
 * 0.8 是个可以调的数,分母的选法不是。
 */
const RATIO = 0.8;

/**
 * 保留最近几轮不压。
 *
 * 2 的理由:压缩发生在 turn 中间,所以「最近一轮」必然是**用户正在等答复的那一轮**,
 * 它一个字都不能丢。再往前留一轮,是为了让「刚才说的算了不去成都了」这种
 * 紧挨着的改口还在原文里 —— 摘要最容易丢的就是这种否定和转折。
 */
const KEEP_TURNS = 2;

/** 摘要请求的超时。hook 上拿不到 turn 的 signal(见 BACKLOG「Tool.execute 的签名要收成 ctx」),只能自己兜一个。 */
const SUMMARY_TIMEOUT_MS = 40_000;

/** 单条工具结果进摘要素材时截到多长。POI 搜索一次能返回几十条,原样喂进去等于没压。 */
const TOOL_RESULT_MAX_CHARS = 1500;

/** 压缩的结果。**没压也返回**,`note` 说明为什么 —— 「没触发」和「压失败了」得分得开。 */
export interface CompactionOutcome {
	compacted: boolean;
	/** 给人看的一句话。 */
	note: string;
	/** 压缩前后的消息条数。没压时两个相等。 */
	before: number;
	after: number;
	/** 压缩前那次请求的 prompt 有多大(provider 报的)。`null` = 本进程还没发过请求,不知道。 */
	tokensBefore: number | null;
}

/** 手动触发的入口。`/compact` 用。 */
export type Compactor = (context: Context, reason: CompactionEntry["reason"]) => Promise<CompactionOutcome>;

export interface CompactionOptions {
	spec: ModelSpec;
	apiKey: string;
	/** 摘要用的 system prompt,域相关,入口给。 */
	prompt: string;
	/**
	 * 压缩点记到哪儿。**必给,没有记录就不压** ——
	 * 「这段历史不再发给模型了」如果不落盘,就成了一次没人知道、也查不回来的信息丢失。
	 */
	session: Session;
	/** 压完了说一声。features 自己不打印,由入口决定怎么显示。 */
	notify?: (outcome: CompactionOutcome) => void;
}

/** 该压了没有。 */
export function shouldCompact(promptTokens: number, spec: ModelSpec): boolean {
	return promptTokens > usableTokens(spec) * RATIO;
}

/**
 * 从哪儿切。返回**第一条保留的消息的下标**。
 *
 * **切点只能是 user 消息。** 从 toolResult 或 assistant 中间切的话,保留下来的那半截里
 * 会有「没有发起者的工具结果」——`checkToolCallsPaired` 下次读记录时会当成断链报错,
 * 而协议上 OpenAI / Anthropic 也都要求 `tool_calls` 和 `tool` 消息配对。
 * 一轮总是从 user 消息开始,所以在 user 消息处切,留下的一定是若干个完整的轮。
 * pi 的 `findValidCutPoints`(`packages/agent/src/harness/compaction/compaction.ts:313`)是同一条规矩。
 *
 * **压过一次之后,摘要本身也是一条 user 消息**(见 session/types.ts 为什么),
 * 所以它也算一个切点。再压时它会落进被压的那一段,于是新摘要是**从旧摘要生成的** ——
 * 信息接着往下传,不会因为压了第二次就把第一次的成果丢掉。
 *
 * @returns 0 表示没得压(轮数还不够 `keepTurns`)。
 */
export function findCutIndex(messages: Message[], keepTurns = KEEP_TURNS): number {
	const userIndexes: number[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role === "user") userIndexes.push(index);
	}
	if (userIndexes.length <= keepTurns) return 0;
	return userIndexes[userIndexes.length - keepTurns] ?? 0;
}

/**
 * 把要被压掉的那段历史拍成纯文本,喂给摘要模型。
 *
 * **和 `memory/extract.ts` 的 `transcript()` 正好相反,这里要带上工具输出。** 那边不带,
 * 是因为抽出来的东西会进 system prompt 待到永远,外部数据不能有这条直通路;
 * 这边带,是因为工具输出本来就已经在上下文里了(而且是最大的一块,`docs/prompt.md` 量过),
 * 压缩的对象就是它 —— 不带的话摘要里会缺掉「查到的天气是什么、订的酒店叫什么」。
 *
 * 单条工具结果截到 `TOOL_RESULT_MAX_CHARS`:摘要素材本身太大的话,这次请求自己就撞窗口了。
 */
function serialize(messages: Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : textOf(message.content);
			if (text.trim()) parts.push(`[用户] ${text.trim()}`);
			continue;
		}
		if (message.role === "toolResult") {
			const text = textOf(message.content).trim();
			if (!text) continue;
			const clipped =
				text.length <= TOOL_RESULT_MAX_CHARS ? text : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…(后面截掉了)`;
			parts.push(`[工具结果 ${message.toolName}] ${clipped}`);
			continue;
		}
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		if (text) parts.push(`[助手] ${text}`);
		const calls = message.content
			.filter((block) => block.type === "toolCall")
			.map((block) => `${block.name}(${JSON.stringify(block.arguments)})`);
		if (calls.length > 0) parts.push(`[助手调用] ${calls.join("; ")}`);
	}
	return parts.join("\n\n");
}

/**
 * 把压缩挂上去,并返回手动触发的入口。
 *
 * 返回值是给 `/compact` 用的:自动那条路挂在 hook 上,手动那条路得有人能直接叫它,
 * 而两条路必须是**同一段逻辑** —— 分成两份写的话,手动压出来的记录迟早和自动的不一样。
 */
export function installCompaction(hooks: Hooks, options: CompactionOptions): Compactor {
	/**
	 * 上一次请求的 prompt 有多大。`afterStep` 每步更新。
	 *
	 * **初值是 `null` 不是 0。** 这个数只有发过请求才拿得到 —— `--resume` 之后立刻 `/compact`
	 * 就一次都没发过。一开始写成 0,实测记录里出现了「21 条消息压缩前 0 token」这种假数据。
	 * 现在这条路上宁可什么都不说。
	 *
	 * 它比「此刻上下文的真实大小」**小一点**:这个数是本步请求发出去时的量,
	 * 而本步的回复和工具结果是之后才追加进去的。不去补这个差,是因为补只能靠估
	 * (按字符数换算 token),而阈值判断宁可用一个真实但偏小的数,也不用一个准确得像样的估计 ——
	 * 偏小的后果是晚压一步,估错的后果是不知道错在哪。
	 */
	let lastPromptTokens: number | null = null;
	/** 「压不动」这句话只说一次。**不是开关** —— 见下面为什么不 latch。 */
	let warnedStuck = false;

	async function summarize(head: Message[]): Promise<string | undefined> {
		const material = serialize(head);
		if (material === "") return undefined;
		const context: Context = {
			systemPrompt: options.prompt,
			messages: [{ role: "user", content: `以下是要压缩的对话片段。\n\n${material}`, timestamp: Date.now() }],
		};
		const message = await stream(options.spec, {
			context,
			apiKey: options.apiKey,
			signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
		});
		if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		return text === "" ? undefined : text;
	}

	/**
	 * 压一次。
	 *
	 * **摘要没生成出来就什么都不做**,原样返回 —— 上下文长不是错误,
	 * 而「历史被换成了一段空白」才是。宁可这一步照常发出去(大不了撞窗口报个 400),
	 * 也不能悄悄丢掉一段对话。
	 *
	 * @throws 只有 `session.compact()` 落盘失败会抛。那时候历史**还没被替换**,
	 *         调用方拿到异常时上下文是完整的。
	 */
	async function compact(context: Context, reason: CompactionEntry["reason"]): Promise<CompactionOutcome> {
		const before = context.messages.length;
		const base = { before, after: before, tokensBefore: lastPromptTokens };
		const cut = findCutIndex(context.messages);
		// cut < 2 有两种情况:轮数不够(cut === 0),或者能压的只剩上一次的摘要本身(cut === 1)。
		// 后者再压一遍是拿摘要生成摘要,越压越糊还白花一次请求。
		//
		// **两种都不是「以后也别试了」,所以这里不设开关。** 一开始写成了「压不动就永久关掉」,
		// 实测想明白是错的:第 2 轮就撞阈值的话(把窗口调到 12k 试触发时正是如此),
		// 那时只有 2 轮、压不动,而压缩会就此**再也不触发**,后面聊多久都不压。
		// 不 latch 也不会空转:这条分支一次模型请求都不发,而真压成功时历史严格变短
		//(至少 2 条换成 1 条),迟早落到这里停下。
		if (cut < 2) {
			return { ...base, compacted: false, note: `压不动:能压的只有 ${cut} 条,最近 ${KEEP_TURNS} 轮要留着` };
		}
		const summary = await summarize(context.messages.slice(0, cut));
		if (summary === undefined) return { ...base, compacted: false, note: "摘要没生成出来,这次不压,历史原样" };

		const next = options.session.compact({
			messages: context.messages,
			summary,
			retainedTail: context.messages.slice(cut),
			tokensBefore: lastPromptTokens,
			reason,
		});
		context.messages = next;
		return {
			...base,
			compacted: true,
			after: next.length,
			note:
				`已压缩:${before} 条 → ${next.length} 条` +
				(lastPromptTokens === null ? "(压缩前多大不知道:这个进程还没发过请求)" : `(压缩前 prompt ${lastPromptTokens} token)`),
		};
	}

	hooks.afterStep.push(async (ctx: AfterStepContext): Promise<void> => {
		lastPromptTokens = promptTokensOf(ctx.message.usage);
		if (!shouldCompact(lastPromptTokens, options.spec)) return;
		// **这一步模型一个字都没说的话,不在这时候压。**
		// 空的 assistant 消息(请求失败时会出现)马上要被 `dropEmptyAssistantMessages` 扔掉,
		// 而我们刚把它连同整段历史落了盘、把 `written` 对齐到了包含它的长度 ——
		// 它一被扔,历史就比已落盘的短一条,`sync` 当场抛。
		//
		// 只查最后这一条就够:空消息里没有 toolCall,`turnEndReason` 必定判 turn 结束,
		// 所以一轮之内只有最后一条可能是空的(core/loop.ts:258)。
		if (ctx.message.content.length === 0) return;
		const outcome = await compact(ctx.context, "threshold");
		// 压成了就报;没压成只报第一次 —— 上下文超了阈值又压不动的话,
		// 后面每一步都会走到这儿,一步一行会把正经输出淹掉。
		if (outcome.compacted) options.notify?.(outcome);
		else if (!warnedStuck) {
			warnedStuck = true;
			options.notify?.(outcome);
		}
	});

	return compact;
}
