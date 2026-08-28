/**
 * memory —— 把跨会话记忆拼进 system prompt。
 *
 * 层:features。挂 `beforeStep`,**loop.ts 一个字都不改**。
 * 边界:它是这个项目里唯一改写 `context.systemPrompt` 的地方。
 *       挂在 hook 上而不是在 cli.ts 里拼一次:`remember` 是在 turn 中间执行的,
 *       只在入口拼的话,模型刚记下的东西要等下一次启动才看得见。
 */

import type { Hooks, StepContext } from "../core/hooks.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { MemoryItem } from "../memory/types.ts";

const TITLES: Record<MemoryItem["kind"], string> = {
	preference: "偏好",
	constraint: "硬约束",
	visited: "去过",
};

/**
 * 记忆块的开头。
 *
 * 最后那句「以这次说的为准」不是客套,是**优先级声明**:记忆和当前对话冲突时
 * 必须让当前赢。没有这句话,「我不爱爬山」会一直压着「这次我就想去爬黄山」——
 * 记忆变成了改不掉的设定,那比没有记忆更糟。
 */
const HEADER = [
	"## 我记得",
	"",
	"以前几次对话里攒下来的长期信息,**不是这次的需求**。",
	"和用户这次说的冲突时,一律以这次说的为准;发现某条已经不成立了,用 `remember` 的 `forget` 去掉它。",
	"",
	"",
].join("\n");

/**
 * 把记忆渲染成 system prompt 里的一段。没有记忆就返回空串。
 *
 * 带上 `[id]`:模型要靠 id 调 `forget`。不带的话它只能按文本去猜,
 * 而文本是它自己写的,改一个字就对不上了。
 */
export function renderMemory(items: MemoryItem[]): string {
	if (items.length === 0) return "";
	const lines: string[] = [];
	for (const kind of ["constraint", "preference", "visited"] as const) {
		const group = items.filter((item) => item.kind === kind);
		if (group.length === 0) continue;
		lines.push(`### ${TITLES[kind]}`, "");
		for (const item of group) lines.push(`- [${item.id}] ${item.text}`);
		lines.push("");
	}
	return `${HEADER}${lines.join("\n")}`;
}

export interface MemoryOptions {
	store: MemoryStore;
	/**
	 * 不带记忆的那份 system prompt。**每步都从它重新拼**,不是往上追加 ——
	 * 追加的话一个十步的 turn 结束时,记忆块会在 prompt 里出现十遍。
	 */
	basePrompt: string;
}

/**
 * 把记忆注入挂上去。
 *
 * 为什么是 `beforeStep` 而不是往 `messages` 里塞一条:记忆是**规则**不是**发言**。
 * 塞成一条 user 消息的话,它会进会话记录、会被 `--resume` 读回来、会被压缩掉,
 * 而且模型会把它当成用户刚说的话去回应。放在 systemPrompt 里这四件事都不会发生。
 */
export function installMemory(hooks: Hooks, options: MemoryOptions): void {
	hooks.beforeStep.push((ctx: StepContext): void => {
		const block = renderMemory(options.store.items());
		ctx.context.systemPrompt = block === "" ? options.basePrompt : `${options.basePrompt}\n\n${block}`;
	});
}
