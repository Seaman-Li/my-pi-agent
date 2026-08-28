/**
 * 跨会话记忆的形状。
 *
 * 层:memory —— 和 session/ 同级,不认识终端、不认识旅行。
 * 边界:只放形状和上限。读写在 store.ts,拼成 prompt 在 features/memory.ts,
 *       从对话里抽在 extract.ts。三件事分开是因为它们各有各的失败方式。
 */

/**
 * 记忆分三类。**分类是给人看的,不是给代码用的** —— 代码对三类一视同仁,
 * 只有渲染时按它分组,人翻文件时才知道哪条是「口味」哪条是「硬约束」。
 *
 * - `preference` 偏好,可以被这次的需求盖过(不爱爬山,但这次非要去也行)
 * - `constraint` 硬约束,盖不过(素食、不坐红眼航班)
 * - `visited`    去过哪儿,是事实不是意愿
 */
export const MEMORY_KINDS = ["preference", "constraint", "visited"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryItem {
	/** 从 1 开始递增。**模型要靠它 forget**,所以必须稳定 —— 不能用数组下标。 */
	id: number;
	kind: MemoryKind;
	text: string;
	/** 哪次会话记下的。人翻文件看到一条离谱的记忆时,能顺着它回到当时的对话。 */
	session?: string;
	createdAt?: number;
}

export interface MemoryFile {
	version: 1;
	items: MemoryItem[];
}

/**
 * 记忆条数上限。
 *
 * **每条都占 system prompt,而且是每一步都占** —— 不是每轮一次,是 turn 里
 * 每次请求都带一遍。20 条 ≈ 300 token,一次十步的规划就是 3000。
 * 上限不是省钱,是逼着「什么值得记」有个答案:满了就得先忘掉一条。
 */
export const MAX_ITEMS = 20;

/**
 * 单条字数上限。它只管一件事:**别让一整段话挤进 system prompt**。
 *
 * 一开始想让它兼职拦住「这次行程的细节」,实测发现拦不住 ——
 * 「十月一号和父母两个人去杭州玩三天预算大概三千块钱住市中心」27 个字,
 * 比「喜欢历史文化景点、不喜欢人多的网红打卡地」还短。**长度和「长期还是这次」无关**,
 * 那件事只有语义分得开,所以它归 prompts/system.md 和 prompts/extract.md 管,不归这里。
 */
export const MAX_TEXT = 40;
