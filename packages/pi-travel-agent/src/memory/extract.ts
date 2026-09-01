/**
 * 隐式写入口:会话结束后回看一遍转录,把里面的长期偏好抽出来存进记忆。
 *
 * 层:memory。**抽取规则不在这儿** —— 那是域知识,由入口从 prompts/extract.md 读了传进来。
 * 边界:只发一次不带工具的模型请求,只往 store 里加。抽不出来、模型挂了、
 *       解析不了都只返回一句话,绝不抛 —— 它跑在用户已经说完再见之后。
 */

import type { Context, Message, Usage } from "@earendil-works/pi-ai";
import { type ModelSpec, stream } from "../core/model.ts";
import type { MemoryStore } from "./store.ts";
import { MAX_ITEMS, MEMORY_KINDS, type MemoryItem, type MemoryKind } from "./types.ts";

/**
 * 一次会话最多自动记 3 条。
 *
 * 这个数字压得比 `remember` 的 5 还低,因为**隐式写入没有人在场把关**:
 * 显式那条路上模型是听着用户的话当场记的,而这条路是事后从转录里猜的,猜错的概率高得多。
 * 记多了不是「记得全」,是把一次聊天的口气固化成永久设定。
 */
const MAX_PER_SESSION = 3;

/** 转录截断长度。偏好都出现在用户自己说的话里,而这些话越靠后越可能是真的当前偏好。 */
const MAX_TRANSCRIPT = 6000;

export interface ExtractOptions {
	spec: ModelSpec;
	apiKey: string;
	/** 抽取用的 system prompt,域相关,入口给。 */
	prompt: string;
	messages: Message[];
	store: MemoryStore;
	signal?: AbortSignal;
}

export interface ExtractResult {
	added: MemoryItem[];
	/** 给人看的一句话。**没发请求时也有** —— 「跳过了」和「没抽到」得分得开。 */
	note: string;
	/**
	 * 这次抽取花了多少。**没发请求时是 `undefined`,不是一堆 0** ——
	 * 「跳过了」和「发了但没花钱」是两回事,而 0 把它们抹平了。
	 *
	 * 用返回值而不是像压缩那样传一本账进来:抽取一次会话只发一次请求,
	 * 没有「累加」可言,而返回值天然说清了「这一次」。
	 */
	usage?: Usage;
}

/**
 * 把对话压成一段纯文本转录。
 *
 * **只取 user 和 assistant 的正文,不取工具输出**:工具输出是外部数据
 * (高德返回的 POI 名称、简介),把它喂进抽取等于给提示注入开了一条直通记忆的路 ——
 * 而记忆会出现在**以后每一次**对话的 system prompt 里,是这个项目里最持久的位置。
 * 用户偏好本来也只可能出现在用户自己说的话里。
 */
function transcript(messages: Message[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : "";
			if (text.trim()) lines.push(`用户:${text.trim()}`);
			continue;
		}
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		if (text) lines.push(`助手:${text}`);
	}
	const joined = lines.join("\n");
	return joined.length <= MAX_TRANSCRIPT ? joined : `(前面省略)\n${joined.slice(-MAX_TRANSCRIPT)}`;
}

/**
 * 从模型回复里挖出那个 JSON 数组。
 *
 * 不用 `JSON.parse(text)` 直接怼:模型很爱在数组前后加一句「好的,我找到了这些:」
 * 或者包一层 ```json 围栏。取第一个 `[` 到最后一个 `]` 能同时对付这两种,
 * 而且抽取结果本来就是数组 —— 正文里不太可能先出现别的方括号。
 *
 * @returns 解析不出来就返回空数组。**不抛** —— 抽取失败不该影响任何东西。
 */
function parseDrafts(text: string): { kind: MemoryKind; text: string }[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) return [];
	let data: unknown;
	try {
		data = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	const drafts: { kind: MemoryKind; text: string }[] = [];
	for (const raw of data) {
		if (typeof raw !== "object" || raw === null) continue;
		const item = raw as Record<string, unknown>;
		const kind = item.kind;
		const value = item.text;
		// kind 不认识就整条丢掉,不默认成 preference:把「素食」记成可以被盖过的偏好,
		// 比压根没记还危险。
		if (typeof kind !== "string" || !(MEMORY_KINDS as readonly string[]).includes(kind)) continue;
		if (typeof value !== "string" || value.trim() === "") continue;
		drafts.push({ kind: kind as MemoryKind, text: value.trim() });
	}
	return drafts;
}

/**
 * 会话收尾抽一次。
 *
 * 三种情况**根本不发请求**:没人说过话、记忆已经满了、被取消了。
 * 省的不只是钱 —— 用户已经按下退出了,每多等一秒都是白等。
 *
 * @returns 模型那边的任何结局(失败、被取消、胡说)都变成 `note` 返回,不抛 ——
 *          调用它的时候进程正要退,没人接得住异常。
 * @throws  只有落盘失败会抛(store.add)。那是「记忆没写进去」,不能装作记住了。
 */
export async function extractMemories(options: ExtractOptions): Promise<ExtractResult> {
	const text = transcript(options.messages);
	if (text === "") return { added: [], note: "这次没聊什么,不用记" };
	if (options.store.items().length >= MAX_ITEMS) {
		return { added: [], note: `记忆已满(${MAX_ITEMS} 条),这次没自动记。删几条再说` };
	}

	const known = options.store
		.items()
		.map((item) => `- ${item.text}`)
		.join("\n");
	const context: Context = {
		systemPrompt: known === "" ? options.prompt : `${options.prompt}\n\n## 已经记过的(别重复)\n\n${known}`,
		messages: [{ role: "user", content: `以下是一次对话的转录。\n\n${text}`, timestamp: Date.now() }],
	};

	const message = await stream(options.spec, { context, apiKey: options.apiKey, signal: options.signal });
	// **从这行往下每一条 return 都带 usage。** 请求已经发出去了,不管抽没抽到东西,
	// 钱都花了 —— 中断和报错那两条尤其要带,不然「跑失败还收费」这件事永远看不见。
	const usage = message.usage;
	if (message.stopReason === "aborted") return { added: [], note: "抽取被中断,这次没记", usage };
	if (message.stopReason === "error") {
		return { added: [], note: `抽取没跑成:${message.errorMessage ?? "没给原因"}`, usage };
	}

	const answer = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	const drafts = parseDrafts(answer).slice(0, MAX_PER_SESSION);
	if (drafts.length === 0) return { added: [], note: "没抽到值得长期记的东西", usage };

	const result = options.store.add(drafts);
	if (result.added.length === 0) return { added: [], note: "抽到的都已经记过了", usage };
	return {
		added: result.added,
		note: `记住了 ${result.added.map((item) => `「${item.text}」`).join("")}`,
		usage,
	};
}
