/**
 * 会话记录的形状:一行 JSON = 一个 Entry,Entry 之间用 `parentId` 串成一棵树。
 *
 * 层:session(harness)—— 不认识终端、不认识旅行,只认识「一次会话由什么组成」。
 * 边界:只定义形状和「形状怎么变成消息」,不碰磁盘。怎么写、怎么读、怎么校验在 store.ts。
 *       唯一的函数 `compactionSummaryMessage` 放在这儿是因为**写和读两边都要用它**,
 *       各写一份的话恢复出来的上下文会和压缩时的不一样。
 */

import type { Message, Usage } from "@earendil-works/pi-ai";
import type { TurnEndReason } from "../core/types.ts";

/**
 * 每个 Entry 都有的三样。
 *
 * **为什么是树(`parentId`)而不是一串数组。** append-only 的文件只能往后加,
 * 而会话里天然有「回到之前某个点重新开始」这种事 —— 现在是 `/new`,
 * 将来是「把刚才那句改一下重问」。用数组就得回头改文件;用树只要换个父节点:
 * 旧的分支原样留着,新的挂在别处,读的时候从叶子往回走就自然绕开了它。
 *
 * **id 用递增整数,不用 uuid** —— 这个文件是要给人手改的(验收里就有一条
 * 「手改 JSONL 制造断链」)。`"parentId": "7"` 一眼能对上第 7 行,
 * `"parentId": "01J9Z..."` 不能。pi 用随机 id 是因为它要跨进程、跨 lane 合并
 * (`packages/agent/src/harness/session/types.ts:14`),我们一个进程一个文件,
 * 可读性比全局唯一值钱。
 */
export interface EntryBase {
	id: string;
	/** 指向上一个 Entry。只有会话头是 `null`。 */
	parentId: string | null;
	timestamp: number;
}

/**
 * 会话头,每个文件恰好一条,永远是根。
 *
 * `promptHash` 记的是**当时那份规则文件的指纹**,不是内容本身
 * (内容两千多字,每个会话存一份纯属浪费)。`--resume` 时对不上就提醒一句:
 * 你接着聊的这段历史,是在另一套规则下产生的 —— 这种事不说,查起来能查半天。
 *
 * 只算 `prompts/system.md`,**不算运行时拼上去的那些**(今天几号、跨会话记忆)。
 * 后两者每天/每记一条就变,算进来的话这个提醒每次都响,等于没有 —— 见 cli.ts 里 `rules`。
 */
export interface SessionEntry extends EntryBase {
	type: "session";
	parentId: null;
	model: string;
	promptHash: string;
}

/** 一条消息。user / assistant / toolResult 都走这里,原样存 pi-ai 的 `Message`。 */
export interface MessageEntry extends EntryBase {
	type: "message";
	message: Message;
}

/**
 * 一轮的结算:这轮转了几步、花了多少、怎么结束的。
 *
 * 不存它也能恢复对话 —— 但恢复不了**账**。`--resume` 之后总账从 0 开始的话,
 * 「这个会话到现在花了多少」就永远算不对了。`reason` 还兼着两件事:
 * 算 `Ledger.partial`(哪几轮的用量不全),以及将来**真重放**对齐
 * 「第几轮对应哪几条消息」。这类字段的特点是**事后补不上**:
 * 老会话里没有就是没有,所以宁可现在多存。
 */
export interface TurnEntry extends EntryBase {
	type: "turn";
	reason: TurnEndReason;
	steps: number;
	usage: Usage;
}

/**
 * 一次压缩:从这里往前的那段历史被换成一句摘要。
 *
 * **为什么不能表示成「删掉那几条」**:文件是 append-only 的,而且那几条真的说过 ——
 * 删了就没法回答「压缩之前到底聊了什么」。所以压缩记成**一条新 Entry**,
 * 旧消息原样留在文件里,只是读的时候跳过去(见 store.ts 的 `rebuild`)。
 *
 * 这样「恢复成压缩后的样子」(省 token)和「恢复成压缩前的样子」(要看细节)
 * 就都做得到,`--resume-full` 走的正是后一条路。
 *
 * `retainedTail` 是**压缩当时保留的那几条消息的副本**。它和文件里那几条 MessageEntry
 * 内容重复,是有意的:这一条 Entry 自己就够拼出压缩后的上下文,读的时候不用
 * 「再往后扫一遍看哪些该留」。重复几 KB 换一个自包含的锚点,划算。
 *
 * `tokensBefore` 记的是**压缩前那次请求的 prompt 有多大**(provider 报的,不是估的)。
 * 它是事后唯一能回答「这次压缩到底值不值」的数字 —— 不存就永远补不上。
 *
 * **`null` 是「不知道」,不是 0。** 这个数只有在本进程真发过请求之后才拿得到
 * (它来自 provider 返回的 usage)。`--resume` 之后立刻 `/compact` 就是没有的那种情况。
 * 一开始写成了默认 0,实测记录里出现「21 条消息压缩前 0 token」—— **假数据比没数据更糟**:
 * 没有你会去查,假的你会信。和 BACKLOG 里「被中断那一轮的 usage 是 0」是同一条教训,
 * 那条也定过同样的调子:宁可显式说「未知」,也不填一个猜出来的数。
 */
export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	retainedTail: Message[];
	tokensBefore: number | null;
	/** 谁触发的。`/compact` 是人按的,`threshold` 是判定出来的 —— 查问题时这两种得分得开。 */
	reason: "manual" | "threshold";
}

export type Entry = SessionEntry | MessageEntry | TurnEntry | CompactionEntry;

/**
 * 摘要在上下文里长什么样。**只有这一个地方定义它** ——
 * 压缩当场拼的那份和 `--resume` 读回来的那份必须一模一样,
 * 两处各写一遍的话,恢复出来的上下文会和压缩时的悄悄不同,而且没人看得出来。
 *
 * **为什么是 user 消息而不是 assistant**:pi 那边有个专门的 `compactionSummary` 角色
 * (`packages/agent/src/harness/messages.ts:94`),我们用的是 pi-ai 的 `Message`,
 * 只有 user / assistant / toolResult 三种,加不了第四种。
 *
 * 那就只能在 user 和 assistant 里选,选 user:assistant 消息是**模型说过的话**,
 * 伪造一条等于在历史里编造模型的发言 —— 和 `dropEmptyAssistantMessages` 里
 * 「不在历史里编造一次沉默」是同一条原则的两面。摘要是外面塞进来的材料,
 * 和工具返回值同类,标注清楚就行。
 *
 * 开头那句标注是**给模型看的**:不写的话它会把摘要当成用户刚提的新要求去回应。
 *
 * `tokensBefore` 是 `null`(不知道有多大)时,那半句**整个不出现** ——
 * 与其写「原文约 null token」或者编个 0,不如不提。这条消息是给模型看的,
 * 一个它用不上的数字只是噪声;而一个错的数字会被它当真。
 */
export function compactionSummaryMessage(entry: CompactionEntry): Message {
	const size = entry.tokensBefore === null ? "" : `原文约 ${entry.tokensBefore} token,`;
	return {
		role: "user",
		content:
			"[对话摘要] 下面这段是前面对话的摘要,**不是用户新提的要求**。" +
			`${size}为了省上下文换成了摘要。\n\n` +
			`${entry.summary}\n\n` +
			"[摘要结束] 后面接着是没被压缩的原始对话。",
		timestamp: entry.timestamp,
	};
}

/** 一次会话的账本。`--resume` 要把它接着往下记。 */
export interface Ledger {
	turns: number;
	input: number;
	output: number;
	cost: number;
	/**
	 * 有几轮的用量是**不全的**(被 Ctrl-C 打断的那些)。
	 *
	 * usage 只在流正常收尾时才拿得到,中断的那一步一个数都没有 —— 可 token 是真花了。
	 * 于是这本账天然偏小,**而且偏小的正好是最贵的那几轮**(跑得久才会想中断)。
	 *
	 * 存这个数不是为了把账补准(补不了,按字符估更不可信),是为了让上面三个数
	 * **能显式说自己不准**:大于 0 时打印成 `in 18234+`。和
	 * `CompactionEntry.tokensBefore` 那条同一个调子 —— 宁可说「至少这么多」,
	 * 也不让一个偏小的数看着像精确值。
	 *
	 * 它是从 `TurnEntry.reason` **算出来的**,不单独落盘,所以老会话文件照样读得动。
	 */
	partial: number;
}

/**
 * 辅助请求的账:**不是对话**的那些模型请求,现在只有压缩摘要一种。
 *
 * **抽记忆那次不在这本账里,是有意的。** 它跑在 `runRepl` 返回之后
 * (`cli.ts` 的 `harvest`),那时候「会话结束」那行已经打完了 —— 加进来只能靠往回补,
 * 而一个事后追加的数字没人对得上它是什么时候花的。所以它打在自己那行 `[记忆]` 上:
 * **花在什么时候、花了多少,并排摆着**。一次会话只抽一次,也不需要累加。
 *
 * **为什么不并进 `Ledger`。** 那个的语义是「这个会话和模型聊了多少」,而且它的每一笔
 * 都对应一条 `TurnEntry` —— `--resume` 正是靠遍历 TurnEntry 把账接着往下记的
 * (`store.ts` 的 `resumeSession`)。辅助请求没有对应的 TurnEntry,混进去会让恢复出来的
 * 账对不上,**而且对不上的方向是「凭空多出来一笔」**,比少一笔更难查。
 *
 * **它不落盘,所以只统计本次运行。** 要落盘就得新增一种 Entry,而那牵扯到
 * 「`rebuild` 读到不认识的 Entry 怎么办」—— 是真重放那一批的事,见 BACKLOG。
 * 打印的时候必须带上「本次运行」四个字,不然它和旁边那本跨会话的账会被当成一回事。
 */
export interface AuxLedger {
	requests: number;
	input: number;
	output: number;
	cost: number;
}

/** 一本空的辅助账。 */
export function emptyAux(): AuxLedger {
	return { requests: 0, input: 0, output: 0, cost: 0 };
}

/**
 * 记一笔辅助请求。
 *
 * `aux` 允许是 `undefined`(没人要这本账),这样调用点不用写 `if` ——
 * 摘要和抽取都在「顺手记一下」的位置上,那儿多一个分支只会碍事。
 *
 * **失败的请求也记。** 一次 500 或者一次超时,input 那部分往往已经计费了;
 * 真是 0 的话加上去也不影响,而漏记会让「这次压缩到底花了多少」永远偏小。
 */
export function addAux(aux: AuxLedger | undefined, usage: Usage): void {
	if (!aux) return;
	aux.requests++;
	aux.input += usage.input;
	aux.output += usage.output;
	aux.cost += usage.cost.total;
}
