/**
 * 会话记录的形状:一行 JSON = 一个 Entry,Entry 之间用 `parentId` 串成一棵树。
 *
 * 层:session(harness)—— 不认识终端、不认识旅行,只认识「一次会话由什么组成」。
 * 边界:只定义形状,不碰磁盘。怎么写、怎么读、怎么校验在 store.ts。
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
 * `promptHash` 记的是**当时那份 system prompt 的指纹**,不是内容本身
 * (内容两千多字,每个会话存一份纯属浪费)。`--resume` 时对不上就提醒一句:
 * 你接着聊的这段历史,是在另一套规则下产生的 —— 这种事不说,查起来能查半天。
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
 * 「这个会话到现在花了多少」就永远算不对了。而且 Step 9 的 `--replay`
 * 要靠它对齐「第几轮对应哪几条消息」。这类字段的特点是**事后补不上**:
 * 老会话里没有就是没有,所以宁可现在多存。
 */
export interface TurnEntry extends EntryBase {
	type: "turn";
	reason: TurnEndReason;
	steps: number;
	usage: Usage;
}

export type Entry = SessionEntry | MessageEntry | TurnEntry;

/** 一次会话的账本。`--resume` 要把它接着往下记。 */
export interface Ledger {
	turns: number;
	input: number;
	output: number;
	cost: number;
}
