/**
 * 会话落盘:JSONL append-only 写、带校验的读。
 *
 * 层:session(harness)—— 不认识终端、**不打印任何东西**。写失败了记在 `broken` 上,
 *     由宿主决定怎么告诉人。
 * 边界:**只往文件尾巴上加,从不改已经写下去的行。** 这条是本文件全部设计的来源:
 *       想「撤销」就换个父节点(见 types.ts 里为什么是树),不是回头改文件。
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { TurnResult } from "../core/loop.ts";
import { textOf } from "../core/types.ts";
import {
	type CompactionEntry,
	compactionSummaryMessage,
	type Entry,
	type Ledger,
	type MessageEntry,
	type SessionEntry,
	type TurnEntry,
} from "./types.ts";

/** system prompt 的指纹。取前 12 位够用 —— 它只回答「变了没」,不用来防碰撞。 */
export function hashPrompt(prompt: string): string {
	return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

/** 会话 id。**时间在前**,所以按文件名排序就是按时间排序,列表和「最近一个」都不用 stat。 */
function newSessionId(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
		`-${randomBytes(2).toString("hex")}`
	);
}

/** 写入方。宿主拿到它只做三件事:同步历史、记一轮的账、`/new` 时重置。 */
export interface Session {
	readonly id: string;
	readonly path: string;
	/** 落盘失败过没有,值是失败原因。失败之后不再尝试写,但对话照常进行。 */
	readonly broken: string | undefined;
	/** 把当前全量历史里还没落盘的那部分追加进去。 */
	sync(messages: Message[]): void;
	recordTurn(result: TurnResult): void;
	/**
	 * 记一次压缩,并返回**压缩后应该用的那份历史**。
	 *
	 * 调用方必须拿返回值替换掉自己手里的 `context.messages` —— 这个方法是
	 * 「历史变短」这件事在记录侧的唯一合法出口,绕过它直接改数组的话,
	 * 下一次 `sync` 会因为 `messages.length < written` 当场抛。
	 */
	compact(options: CompactRequest): Message[];
	/** `/new`:游标回到会话头,之后的消息挂在它下面。**旧分支一条都不删。** */
	reset(): void;
}

/** 一次压缩要记下来的东西。 */
export interface CompactRequest {
	/** **压缩前**的全量历史。先把它落盘,再记压缩点 —— 否则被压掉的那几条永远进不了文件。 */
	messages: Message[];
	summary: string;
	/** 保留不压的尾巴。必须是 `messages` 的后缀,而且第一条得是 user 消息(见 features/compaction.ts)。 */
	retainedTail: Message[];
	/** `null` = 不知道(本进程还没发过请求)。**不要拿 0 顶替**,见 types.ts。 */
	tokensBefore: number | null;
	reason: CompactionEntry["reason"];
}

interface WriterState {
	nextId: number;
	rootId: string;
	leafId: string;
	/** 已经落盘的消息条数。`sync` 靠它算差量。 */
	written: number;
	broken: string | undefined;
}

/**
 * 把 state 包装成一个 `Session`。
 *
 * 用 `appendFileSync` 而不是异步写,理由是**进程随时会被 Ctrl-C 或 kill 掉**:
 * 同步写返回时字节已经交给内核了,异步写可能还排在事件循环里。
 * 代价是阻塞,但一轮几 KB、一个进程一个文件,这点阻塞换「记录不丢」很划算。
 */
function makeSession(id: string, path: string, state: WriterState): Session {
	/**
	 * 一批 Entry 一次写。
	 *
	 * **分多次写是不行的**:中途崩掉会在文件里留下半棵树(有 assistant 没 toolResult),
	 * 而下次 `--resume` 读到的就是一份自己制造的坏记录。一次 write 至少让这件事
	 * 退化成「要么整批在,要么整批不在」。
	 */
	function flush(entries: Entry[]): void {
		if (state.broken !== undefined || entries.length === 0) return;
		try {
			appendFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
		} catch (error) {
			// 记录失败不该毁掉对话 —— 但也绝不能静默。标记成 broken,宿主看到会说一声;
			// 之后不再重试:一直失败一直报,只会把真正的输出淹掉。
			state.broken = error instanceof Error ? error.message : String(error);
		}
	}

	/** 取一个新 id 并把叶子挪过去。**只有它能动 `leafId`**,树的形状全靠这一处。 */
	function advance(): { id: string; parentId: string } {
		const parentId = state.leafId;
		const id = String(state.nextId++);
		state.leafId = id;
		return { id, parentId };
	}

	/**
	 * @throws 历史比已落盘的还短时抛 —— append-only 表达不了「删掉中间某条」。
	 *         **压缩是这条规则唯一的合法例外**,它走 `compact()`,那里会把 `written` 重新对齐。
	 */
	function syncMessages(messages: Message[]): void {
		if (messages.length < state.written) {
			throw new Error(`历史从 ${state.written} 条变成了 ${messages.length} 条,append-only 记录没法表达这件事`);
		}
		const tail = messages.slice(state.written);
		if (tail.length === 0) return;
		const entries: MessageEntry[] = tail.map((message) => {
			const { id: entryId, parentId } = advance();
			return {
				type: "message",
				id: entryId,
				parentId,
				// 用消息自己的时间戳,不用「写盘的时间」—— 记录要回答「这句话什么时候说的」。
				timestamp: message.timestamp,
				message,
			};
		});
		flush(entries);
		state.written = messages.length;
	}

	return {
		id,
		path,
		get broken(): string | undefined {
			return state.broken;
		},

		sync: syncMessages,

		/**
		 * 顺序是**先落盘、再记压缩点**,不能反过来。
		 *
		 * 压缩发生在 turn 中间,而 `repl.ts` 是 turn 结束才 `sync` 的 —— 也就是说
		 * 这一刻文件里还没有本轮产生的那几条消息。先记压缩点的话,那几条就此消失:
		 * 「恢复成压缩前的样子」这条路当场断掉,而且**没有任何报错**,
		 * 要等哪天真想看细节时才发现记录里没有。
		 *
		 * 之后 `written` 重新对齐到「压缩后这份历史有几条」。这几条在文件里都有对应物:
		 * 摘要那条对应这个 CompactionEntry 本身,尾巴对应它的 `retainedTail`。
		 * 所以下一次 `sync` 只会追加压缩**之后**新说的话,不会重复写。
		 */
		compact(options: CompactRequest): Message[] {
			syncMessages(options.messages);
			const { id: entryId, parentId } = advance();
			const entry: CompactionEntry = {
				type: "compaction",
				id: entryId,
				parentId,
				timestamp: Date.now(),
				summary: options.summary,
				retainedTail: options.retainedTail,
				tokensBefore: options.tokensBefore,
				reason: options.reason,
			};
			flush([entry]);
			const next = [compactionSummaryMessage(entry), ...options.retainedTail];
			state.written = next.length;
			return next;
		},

		recordTurn(result: TurnResult): void {
			const { id: entryId, parentId } = advance();
			const entry: TurnEntry = {
				type: "turn",
				id: entryId,
				parentId,
				timestamp: Date.now(),
				reason: result.reason,
				steps: result.steps,
				usage: result.usage,
			};
			flush([entry]);
		},

		reset(): void {
			state.leafId = state.rootId;
			state.written = 0;
		},
	};
}

export interface SessionMeta {
	model: string;
	promptHash: string;
}

/**
 * 开一个新会话,文件当场建出来(里面只有一条会话头)。
 *
 * @throws 目录建不出来、或者头写不进去时抛。**这一条不容忍**:
 *         连文件都建不了说明路径就是错的,继续跑只会在退出时才发现什么都没记下。
 */
export function createSession(dir: string, meta: SessionMeta): Session {
	mkdirSync(dir, { recursive: true });
	const id = newSessionId();
	const path = join(dir, `${id}.jsonl`);
	const head: SessionEntry = {
		type: "session",
		id: "1",
		parentId: null,
		timestamp: Date.now(),
		model: meta.model,
		promptHash: meta.promptHash,
	};
	writeFileSync(path, `${JSON.stringify(head)}\n`, { encoding: "utf8", flag: "wx" });
	return makeSession(id, path, { nextId: 2, rootId: "1", leafId: "1", written: 0, broken: undefined });
}

/** 读出来的一份会话。 */
export interface Resumed {
	session: Session;
	messages: Message[];
	ledger: Ledger;
	/** 存的时候那份 system prompt 和现在这份不一样。 */
	promptChanged: boolean;
	/**
	 * 这条链上有几次压缩。**0 以外的值一定要告诉用户** ——
	 * 恢复出来的历史比他上次看见的短,不说的话他会以为记录丢了。
	 */
	compactions: number;
	/** 恢复的是压缩前的完整历史(`--resume-full`)。`compactions > 0` 时这两个一起才说得清恢复的是什么。 */
	full: boolean;
}

/**
 * 把一条链拼成要发给模型的那份历史。
 *
 * **默认不读过最后一个压缩点**:从后往前找到第一个 compaction,它之前的 MessageEntry
 * 一条都不要 —— 那段已经被它的 `summary` 代表了。这和 pi 的
 * `defaultContextEntryTransform`(`packages/agent/src/harness/session/context.ts:45`)是同一个做法。
 *
 * `full = true` 就当压缩没发生过,把链上所有 MessageEntry 原样吐出来。
 * **这是 CompactionEntry 存 `retainedTail` 副本换来的能力**:两份历史都在文件里,
 * 恢复的时候才有得选 —— 要省 token 就走默认,要看细节就走 full。
 */
function rebuild(chain: Entry[], full: boolean): Message[] {
	const messagesFrom = (from: number): Message[] =>
		chain
			.slice(from)
			.filter((entry): entry is MessageEntry => entry.type === "message")
			.map((entry) => entry.message);

	if (!full) {
		for (let index = chain.length - 1; index >= 0; index--) {
			const entry = chain[index];
			if (entry?.type !== "compaction") continue;
			return [compactionSummaryMessage(entry), ...entry.retainedTail, ...messagesFrom(index + 1)];
		}
	}
	return messagesFrom(0);
}

/**
 * 解析一个 JSONL 文件里的所有 Entry。
 *
 * **每一步失败都带上行号**。这个文件是给人手改的,报「第 7 行 parentId 指向不存在的 4」
 * 才能改;报「会话文件损坏」等于没说。
 *
 * @throws 某行不是合法 JSON、缺 id/type、或 id 重复时抛。
 */
function parseEntries(path: string): Entry[] {
	const text = readFileSync(path, "utf8");
	const entries: Entry[] = [];
	const seen = new Set<string>();
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") continue;
		const at = `${path}:${index + 1}`;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`${at} 不是合法 JSON:${error instanceof Error ? error.message : String(error)}`);
		}
		const entry = parsed as Partial<Entry>;
		if (typeof entry.id !== "string" || typeof entry.type !== "string") {
			throw new Error(`${at} 缺 id 或 type`);
		}
		if (seen.has(entry.id)) throw new Error(`${at} id "${entry.id}" 和前面某条重复了`);
		if (entry.type === "compaction") checkCompactionEntry(entry as Partial<CompactionEntry>, at);
		seen.add(entry.id);
		entries.push(entry as Entry);
	}
	if (entries.length === 0) throw new Error(`${path} 是空的`);
	return entries;
}

/**
 * compaction 行的字段检查。**只查人手改得坏的那几个**,和 memory 那边同一条判据:
 * 机器写的(id / timestamp)可以宽,人写的必须严。
 *
 * 为什么单独查它而别的 Entry 不查:压缩点决定了「哪一段历史不再发给模型」。
 * 一个 summary 被清空的 compaction 行不会让任何东西报错,只会让模型
 * **静悄悄地少看一大段**,而人从终端上完全看不出来 —— 这正是本文件反复防的那类事。
 *
 * @throws 四个字段任一不对时抛,带行号。
 */
function checkCompactionEntry(entry: Partial<CompactionEntry>, at: string): void {
	if (typeof entry.summary !== "string" || entry.summary.trim() === "") {
		throw new Error(`${at} compaction 的 summary 是空的`);
	}
	if (!Array.isArray(entry.retainedTail)) {
		throw new Error(`${at} compaction 的 retainedTail 不是数组`);
	}
	// null 是合法值(「不知道」),但别的非数字不是。手写 "unknown" 之类的一律拦下来。
	if (entry.tokensBefore !== null && (typeof entry.tokensBefore !== "number" || !Number.isFinite(entry.tokensBefore))) {
		throw new Error(`${at} compaction 的 tokensBefore 既不是数字也不是 null`);
	}
	if (entry.reason !== "manual" && entry.reason !== "threshold") {
		throw new Error(`${at} compaction 的 reason 只能是 manual 或 threshold,现在是 ${JSON.stringify(entry.reason)}`);
	}
}

/**
 * 从叶子沿 `parentId` 走回根,返回**从根到叶**的那一条链。
 *
 * 这是「树」这个设计唯一被真正用到的地方:文件里可能躺着好几条分支(每次 `/new`
 * 就多一条),但**当前的历史只有从最后一行往回走的那一串**,其余的自然被绕开。
 *
 * @throws parentId 指向不存在的 Entry(断链)、或者走出了环时抛。
 *         **这两种一律报错,绝不「跳过这条接着走」** —— 静默跳过的后果是
 *         模型收到一段少了几句的历史,而人完全看不出来。
 */
function chainToRoot(entries: Entry[], path: string): Entry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const chain: Entry[] = [];
	let current: Entry | undefined = entries[entries.length - 1];
	while (current) {
		chain.push(current);
		if (chain.length > entries.length) {
			throw new Error(`${path} 的 parentId 绕成了环(从 "${current.id}" 开始查)`);
		}
		if (current.parentId === null) break;
		const parent: Entry | undefined = byId.get(current.parentId);
		if (!parent) {
			throw new Error(
				`${path} 断链:Entry "${current.id}" 的 parentId 是 "${current.parentId}",但文件里没有这个 id`,
			);
		}
		current = parent;
	}
	const root = chain[chain.length - 1];
	if (root?.type !== "session") {
		throw new Error(`${path} 断链:从最后一条往回走没走到会话头(停在 "${root?.id}",type=${root?.type})`);
	}
	return chain.reverse();
}

/**
 * 检查 toolCall 都有配对的 toolResult。
 *
 * 我们自己写出来的文件不会出现这种事(每轮先补链再落盘,见 repl.ts),
 * 所以它只在**文件被手改过**时才会触发 —— 那时候更要报,不要修:
 * 悄悄修一份被改坏的记录,等于把「这份记录不可信」这个事实藏起来。
 *
 * @throws 有 toolCall 没配对的 toolResult 时抛。
 */
function checkToolCallsPaired(messages: Message[], path: string): void {
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") answered.add(message.toolCallId);
	}
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && !answered.has(block.id)) {
				throw new Error(`${path} 断链:工具调用 "${block.name}"(id ${block.id})没有对应的结果`);
			}
		}
	}
}

/** 目录里所有会话 id,新的在前。文件名以时间开头,所以排序不用读文件。 */
export function listSessionIds(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => name.slice(0, -".jsonl".length))
		.sort()
		.reverse();
}

/** 一个会话的一句话摘要,给 `--sessions` 列表用。 */
export interface SessionSummary {
	id: string;
	turns: number;
	messages: number;
	/** 第一句用户说的话,截断过。认会话全靠它 —— id 是时间戳,谁也记不住。 */
	first: string;
}

/** 扫一遍目录,读出每个会话的摘要。读不动的那个只标一句,不影响其余的。 */
export function listSessions(dir: string, limit = 10): SessionSummary[] {
	return listSessionIds(dir)
		.slice(0, limit)
		.map((id) => {
			const path = join(dir, `${id}.jsonl`);
			try {
				const entries = parseEntries(path);
				const first = entries.find(
					(entry): entry is MessageEntry => entry.type === "message" && entry.message.role === "user",
				);
				const content = first?.message.role === "user" ? first.message.content : "";
				const text = typeof content === "string" ? content : textOf(content);
				return {
					id,
					turns: entries.filter((entry) => entry.type === "turn").length,
					messages: entries.filter((entry) => entry.type === "message").length,
					first: text.length > 40 ? `${text.slice(0, 40)}…` : text,
				};
			} catch (error) {
				return { id, turns: 0, messages: 0, first: `(读不了:${error instanceof Error ? error.message : ""})` };
			}
		});
}

/**
 * 打开一个已有会话,把历史和账都恢复出来,并且**接着往同一个文件里写**。
 *
 * 不给 id 就取最近的一个。
 *
 * @throws 目录空的、id 不存在、或者文件校验没过(见 `parseEntries` / `chainToRoot` /
 *         `checkToolCallsPaired`)时抛。**一条都不容忍** —— 恢复一段自己都说不清
 *         是否完整的历史,比拒绝恢复危险得多:模型不会告诉你它少看了三句话。
 */
export function resumeSession(dir: string, options: { id?: string; promptHash: string; full?: boolean }): Resumed {
	const id = options.id ?? listSessionIds(dir)[0];
	if (!id) throw new Error(`${dir} 里没有会话可以恢复`);
	const path = join(dir, `${id}.jsonl`);
	if (!existsSync(path)) throw new Error(`没有这个会话:${id}(找的是 ${path})`);

	const entries = parseEntries(path);
	const chain = chainToRoot(entries, path);
	const head = chain[0] as SessionEntry;

	const full = options.full ?? false;
	const messages = rebuild(chain, full);
	checkToolCallsPaired(messages, path);

	const ledger: Ledger = { turns: 0, input: 0, output: 0, cost: 0, partial: 0 };
	for (const entry of chain) {
		if (entry.type !== "turn") continue;
		ledger.turns++;
		ledger.input += entry.usage.input;
		ledger.output += entry.usage.output;
		ledger.cost += entry.usage.cost.total;
		// 被中断那轮的 usage 拿不全(见 Ledger.partial)。**从 reason 算,不新存字段** ——
		// 老会话文件里就有 reason,所以这个数对历史记录一样成立。
		if (entry.reason === "aborted") ledger.partial++;
	}

	// nextId 取**整个文件**的最大值 + 1,不是这条链的 —— 别的分支占过的 id 不能再用,
	// 否则新写的 Entry 会和旧分支撞 id,下次读就报「id 重复」。
	const maxId = Math.max(...entries.map((entry) => Number(entry.id)).filter(Number.isFinite));
	const state: WriterState = {
		nextId: maxId + 1,
		rootId: head.id,
		leafId: chain[chain.length - 1]?.id ?? head.id,
		// 压缩过的会话这里也成立:摘要那条在文件里对应 CompactionEntry 本身,
		// 尾巴对应它的 retainedTail —— 恢复出来的每一条**都已经有落盘的对应物**,
		// 所以下一次 sync 只追加这次新说的话。
		written: messages.length,
		broken: undefined,
	};
	return {
		session: makeSession(id, path, state),
		messages,
		ledger,
		promptChanged: head.promptHash !== options.promptHash,
		compactions: chain.filter((entry) => entry.type === "compaction").length,
		full,
	};
}
