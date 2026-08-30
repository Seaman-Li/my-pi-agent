/**
 * 「这段东西发出去大概多少 token」—— 请求**发之前**唯一能拿到的数,而且会自己校准。
 *
 * 层:core —— 只认识 `Context` 和字符,不认识 UI、不认识旅行。
 * 边界:它给的是**估计**。真值只有 provider 事后返回的 usage 有,那条路更准但永远晚一步。
 *       两个数各管各的:压缩阈值用真值(它本来就是事后判断),
 *       `beforeStep` 上的闸只能用估计(那时候还没有真值)。
 */

import type { Context, Message, Usage } from "@earendil-works/pi-ai";

/**
 * 冷启动时按几个字符算一个 token。
 *
 * 抄 pi-ai 的 `CHARS_PER_TOKEN`(`packages/ai/src/utils/estimate.ts:14`)——
 * 但**只是抄它的初值,不抄它的做法**。实测这个常数在中文上低估 3.5 倍
 * (1160 个中文字符,它估 290,provider 报的真值约 1018)。
 * 拿一个低估 3.5 倍的数去做「太长就拒绝」,结果是该拒的不拒。
 *
 * 所以它在这里只是**第一步之前的默认值**,一步之后就被真值顶掉了(见 `calibrate`)。
 */
const INITIAL_CHARS_PER_TOKEN = 4;

/**
 * 校准比值的上下限。
 *
 * 防的是一次异常读数把后面全带偏 —— 比如某次请求 provider 少报了 usage,
 * 比值算出个 0.01,之后所有估计都缩水 100 倍,闸就形同虚设。
 * 0.25~4 覆盖了「纯英文」到「纯中文」的实测范围还有余量,超出这个范围的读数**不可信**,
 * 宁可保持上一次的比值。
 */
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

/**
 * 这次请求的 prompt 实际有多大 —— **provider 报的真值**,不是估的。
 *
 * **三项相加,不能只看 `input`**:`input` 是**减出来**的
 * (`prompt_tokens − cached_tokens − cache_write_tokens`,见 docs/prompt-cache.md)。
 * DeepSeek 上缓存命中率能到 96%,只看 `input` 会把 12000 token 的上下文当成 500。
 *
 * 住在这个文件里而不是压缩那边:它回答的是「一个 Usage 意味着多大的 prompt」,
 * 和压缩无关 —— 现在压缩阈值和估算器校准两边都要用它,放 features 里就成了积木互相 import。
 */
export function promptTokensOf(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

export interface TokenMeter {
	/** 估整个上下文有多大。会记下这次的原始值,供 `calibrate` 配对。 */
	estimate(context: Context): number;
	/** 估一段纯文本有多大(比如用户刚敲的那一行)。**不参与校准配对。** */
	estimateText(text: string): number;
	/**
	 * 拿 provider 返回的真值校准。用的是**最近一次 `estimate(context)`** 的原始值。
	 *
	 * @param promptTokens 那次请求模型实际看到的整个 prompt(`input + cacheRead + cacheWrite`)
	 */
	calibrate(promptTokens: number): void;
	/** 当前比值:真值 ÷ 按字符数算出来的原始值。1 = 和 pi-ai 那个常数一致。给 trace 看。 */
	readonly ratio: number;
}

/** 一条消息里有多少字符。图片按 pi-ai 的量级算一个固定值 —— 这个 agent 现在还没有图片输入。 */
function messageChars(message: Message): number {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content.length;
		return message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 4800), 0);
	}
	if (message.role === "toolResult") {
		return message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 4800), 0);
	}
	return message.content.reduce((sum, block) => {
		if (block.type === "text") return sum + block.text.length;
		if (block.type === "thinking") return sum + block.thinking.length;
		// toolCall:名字 + 参数的 JSON,两样都真的进请求体。
		return sum + block.name.length + JSON.stringify(block.arguments ?? {}).length;
	}, 0);
}

/**
 * 整个上下文有多少字符。**三块都要算**:systemPrompt、工具 schema、messages。
 *
 * 漏掉工具 schema 是最容易犯的错 —— 实测它是恒定 1400 token 左右的开销
 * (`docs/prompt.md` 量过),而且**每一步都重发一遍**。只算 messages 的话,
 * 一个刚开始的会话会被估成几乎是 0。
 */
function rawChars(context: Context): number {
	let chars = context.systemPrompt?.length ?? 0;
	if (context.tools) chars += JSON.stringify(context.tools).length;
	for (const message of context.messages) chars += messageChars(message);
	return chars;
}

/**
 * 开一个会自己校准的估算器。
 *
 * **为什么要自校准,而不是把那个常数调成 1.14。** 因为它跟语言走:同一份代码,
 * 中文比值约 3.5,英文接近 1,代码又是别的值。调常数等于赌用户只说一种语言。
 *
 * 而我们有 pi-ai 那个函数没有的条件:**每一步都同时拿得到「估的」和「真的」** ——
 * `estimate()` 在请求前,provider 的 usage 在请求后。比值不用猜,量出来就行。
 *
 * **一个已知的小偏差**:`estimate()` 由 `beforeStep` 上的闸调用,而记忆注入是**它后面**
 * 那个 handler 干的,所以估的时候还没算上记忆块(约 150 token)。
 * 没去修是因为代价不对等:要么把闸挪到注入后面(那就失去了「最便宜的先跑」),
 * 要么让 meter 认识记忆(core 认识 feature,层就破了)。
 * 一个 2000+ token 的上下文上偏 7%,而阈值本来就是拍的 —— 记在这里比修掉划算。
 *
 * 不是单例:装配处建一个实例传给用到的积木(和 `Asker` 同一个模式)。
 * 一个进程一个会话,所以一个实例就够;真要并发多会话时,每个会话一个 —— 比值是会话相关的。
 *
 * @param initialRatio 冷启动比值,默认 1(= 直接用 `INITIAL_CHARS_PER_TOKEN`)。
 *        对抗用例靠它跑「已经校准到中文」那一档 —— 长度闸的有效上限是跟着语言变的,
 *        只测冷启动那一档等于只测了一半。将来 `--resume` 想恢复上次的比值也走这里。
 */
export function createTokenMeter(initialRatio = 1): TokenMeter {
	let ratio = initialRatio;
	/** 最近一次 `estimate(context)` 的原始字符估值。`calibrate` 靠它配对。 */
	let lastRaw: number | undefined;

	return {
		get ratio(): number {
			return ratio;
		},
		estimate(context: Context): number {
			const raw = rawChars(context) / INITIAL_CHARS_PER_TOKEN;
			lastRaw = raw;
			return Math.ceil(raw * ratio);
		},
		estimateText(text: string): number {
			return Math.ceil((text.length / INITIAL_CHARS_PER_TOKEN) * ratio);
		},
		calibrate(promptTokens: number): void {
			// 没配对的 estimate、或者估值太小(除出来噪声大),都不拿来校准。
			if (lastRaw === undefined || lastRaw < 50 || promptTokens <= 0) return;
			const observed = promptTokens / lastRaw;
			if (observed < MIN_RATIO || observed > MAX_RATIO) return;
			ratio = observed;
			lastRaw = undefined;
		},
	};
}
