/**
 * 跨会话记忆的落盘:一个人能读能改的 JSON,整体读、整体写。
 *
 * 层:memory。和 session/store.ts 是对照的两半 —— 那边 append-only 因为
 *     「说过的话不能改」,这边整体重写因为「记住的事本来就会被推翻」。
 * 边界:只认 `MemoryItem`,不认识旅行、不认识模型。**校验一律报错不静默跳过**,
 *       理由见 loadItems:手改坏了却当成空记忆,表现是「它忘了我说过的话」,最难查。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_ITEMS, MAX_TEXT, MEMORY_KINDS, type MemoryFile, type MemoryItem, type MemoryKind } from "./types.ts";

/** 想记一条什么。`id`/`createdAt` 由 store 自己给 —— 调用方给不出稳定的 id。 */
export interface MemoryDraft {
	kind: MemoryKind;
	text: string;
}

/** 一次写入的结果。三种去向分开报,因为「重复」和「被拒」要对模型说不同的话。 */
export interface AddResult {
	added: MemoryItem[];
	/** 已经记过了(去掉标点、空白之后一样)。 */
	duplicated: string[];
	/** 没记成的,带原因。原因是**给模型看的**,它得知道下一步该干嘛。 */
	rejected: { text: string; reason: string }[];
}

export interface MemoryStore {
	path: string;
	/** 当前全部记忆。返回副本 —— 外面拿去渲染,别让它能改到内部数组。 */
	items(): MemoryItem[];
	/** @throws 落盘失败时抛。 */
	add(drafts: MemoryDraft[]): AddResult;
	/**
	 * 按 id 忘掉。返回真正删掉的 id。
	 * @throws 落盘失败时抛。
	 */
	forget(ids: number[]): number[];
}

/**
 * 判重用的归一化:去掉空白和常见标点再比。
 *
 * 不做同义词合并 —— 「不爱爬山」和「讨厌登山」在这里是两条。想合并得靠模型,
 * 那是 `forget` + 重记,不是判重该管的事。判重只负责挡住**逐字重复**,
 * 而逐字重复恰恰是最常见的:模型每次会话都会想把同一条偏好再记一遍。
 */
function normalize(text: string): string {
	return text.replace(/[\s。,,、;;::!!??.]/g, "").toLowerCase();
}

/** 是不是个普通对象。数组要单独排掉 —— `typeof [] === "object"`,不排就把 `[...]` 当成合法顶层了。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验文件里的一条。
 *
 * **机器写的字段可以缺,人写的字段不能错**:`id` 和 `createdAt` 允许省略(补上就是),
 * 因为手写一条记忆时没人愿意去想 id 该填几;而 `kind` 和 `text` 是人的意图,
 * 填错了猜不出来,只能报错。
 *
 * @throws 形状不对时抛,消息里带下标 —— 文件是数组,下标就是「第几条」。
 */
function parseItem(raw: unknown, index: number, path: string): MemoryItem {
	const where = `${path} 第 ${index + 1} 条`;
	if (!isRecord(raw)) throw new Error(`${where} 不是对象`);
	const kind = raw.kind;
	if (typeof kind !== "string" || !(MEMORY_KINDS as readonly string[]).includes(kind)) {
		throw new Error(`${where}的 kind 是 ${JSON.stringify(kind)},只能是 ${MEMORY_KINDS.join(" / ")}`);
	}
	const text = raw.text;
	if (typeof text !== "string" || text.trim() === "") throw new Error(`${where}的 text 空着或者不是字符串`);
	if (raw.id !== undefined && (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id < 1)) {
		throw new Error(`${where}的 id 是 ${JSON.stringify(raw.id)},要么删掉让它自己补,要么写个正整数`);
	}
	return {
		id: typeof raw.id === "number" ? raw.id : 0,
		kind: kind as MemoryKind,
		text: text.trim(),
		session: typeof raw.session === "string" ? raw.session : undefined,
		createdAt: typeof raw.createdAt === "number" ? raw.createdAt : undefined,
	};
}

/**
 * 读整个文件。文件不存在 = 还没有记忆,不是错。
 *
 * @throws JSON 不合法、顶层形状不对、某条形状不对、id 重复时抛。
 *         **一条都不跳过**:静默跳过一条坏记忆,结果是「它忘了我说过的话」,
 *         而这句话既可能是记忆 bug 也可能是模型没听话(见 Q7),分不开就查不动。
 */
function loadItems(path: string): MemoryItem[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (raw.trim() === "") return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${path} 不是合法 JSON:${(error as Error).message}。修一下,或者整个删掉重来`);
	}
	if (!isRecord(data)) throw new Error(`${path} 顶层应该是个对象 { "version": 1, "items": [...] }`);
	if (!Array.isArray(data.items)) throw new Error(`${path} 里缺 items 数组`);
	const items = data.items.map((item, index) => parseItem(item, index, path));

	const seen = new Map<number, number>();
	for (const [index, item] of items.entries()) {
		if (item.id === 0) continue;
		const first = seen.get(item.id);
		if (first !== undefined)
			throw new Error(`${path} 里 id ${item.id} 出现了两次(第 ${first + 1} 和 ${index + 1} 条)`);
		seen.set(item.id, index);
	}
	// 手写的那几条没有 id,统一补在最大值后面 —— 补完之后 forget 才有得引用。
	let next = items.reduce((max, item) => Math.max(max, item.id), 0);
	for (const item of items) {
		if (item.id === 0) item.id = ++next;
	}
	return items;
}

/**
 * 整体重写。先写 `.tmp` 再 rename —— rename 在同一个文件系统上是原子的,
 * 所以中途被 kill 的结果只有「旧的完整版」或「新的完整版」两种,不会是半截 JSON。
 * session 那边用 append 换来同样的性质,这边整体重写就只能靠这个。
 *
 * @throws 建目录或写盘失败时抛。**不吞** —— 这里失败意味着这条记忆没记住,
 *         而调用它的是一次工具调用,工具调用天生有地方报错。
 */
function flush(path: string, items: MemoryItem[]): void {
	const file: MemoryFile = { version: 1, items };
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

/**
 * 打开记忆文件。**在入口调一次**,之后全程用返回的这个对象 ——
 * 内存里那份是唯一的真相,不每步重读盘:会话跑到一半有人去改文件是边缘情况,
 * 而每步一次 `readFileSync` 换来的「新鲜」还不如它带来的「读到半截写入」风险大。
 *
 * @throws 文件存在但内容不合法时抛(见 loadItems)。启动就炸,而不是带着空记忆跑下去。
 */
export function openMemory(path: string, options: { session?: string } = {}): MemoryStore {
	const items = loadItems(path);
	let nextId = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;

	return {
		path,
		items: () => items.map((item) => ({ ...item })),

		add(drafts: MemoryDraft[]): AddResult {
			const result: AddResult = { added: [], duplicated: [], rejected: [] };
			for (const draft of drafts) {
				const text = draft.text.trim();
				if (text === "") {
					result.rejected.push({ text: draft.text, reason: "空的" });
					continue;
				}
				if (text.length > MAX_TEXT) {
					result.rejected.push({
						text,
						reason: `超过 ${MAX_TEXT} 字。一条记忆写一件事,拆开或者说短点`,
					});
					continue;
				}
				const key = normalize(text);
				if (items.some((item) => normalize(item.text) === key)) {
					result.duplicated.push(text);
					continue;
				}
				if (items.length >= MAX_ITEMS) {
					result.rejected.push({ text, reason: `记忆满了(上限 ${MAX_ITEMS} 条)。先 forget 掉一条过时的再记` });
					continue;
				}
				const item: MemoryItem = {
					id: nextId++,
					kind: draft.kind,
					text,
					session: options.session,
					createdAt: Date.now(),
				};
				items.push(item);
				result.added.push(item);
			}
			if (result.added.length > 0) flush(path, items);
			return result;
		},

		forget(ids: number[]): number[] {
			const wanted = new Set(ids);
			const gone: number[] = [];
			for (let i = items.length - 1; i >= 0; i--) {
				const item = items[i];
				if (item && wanted.has(item.id)) {
					gone.push(item.id);
					items.splice(i, 1);
				}
			}
			// **id 不回收** —— nextId 只增不减。回收的话「忘掉 3 再记一条」会让新记忆
			// 顶着旧记忆的号,人对着会话记录复盘时会把两条不相干的事看成同一条。
			if (gone.length > 0) flush(path, items);
			return gone.reverse();
		},
	};
}
