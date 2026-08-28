/**
 * remember 工具:把用户的长期偏好记进跨会话记忆,或者忘掉一条。
 *
 * 层:tools。它是记忆的**显式**写入口 —— 模型自己判断该记什么。
 * 边界:只认 `MemoryStore`,不碰文件路径、不认识 system prompt 长什么样。
 *       记忆怎么进上下文是 features/memory.ts 的事,和本文件无关。
 */

import { Type } from "typebox";
import type { Tool, ToolResult } from "../core/types.ts";
import type { MemoryStore } from "../memory/store.ts";
import { MAX_ITEMS, MAX_TEXT, type MemoryKind } from "../memory/types.ts";

const MAX_PER_CALL = 5;

const parameters = Type.Object({
	remember: Type.Optional(
		Type.Array(
			Type.Object({
				kind: Type.Union([Type.Literal("preference"), Type.Literal("constraint"), Type.Literal("visited")], {
					description:
						"preference=可以被这次需求盖过的偏好;constraint=盖不过的硬约束(忌口、身体条件);visited=去过哪儿",
				}),
				text: Type.String({
					description: `一句话,${MAX_TEXT} 字以内。只写下次对话仍然成立的事,别写这次行程的细节`,
				}),
			}),
			{ description: `一次最多记 ${MAX_PER_CALL} 条` },
		),
	),
	forget: Type.Optional(
		Type.Array(Type.Integer(), { description: "要忘掉的记忆编号,就是「我记得」里方括号中的数字" }),
	),
});

/**
 * 造一个绑定了具体记忆文件的 `remember` 工具。
 *
 * 和 `ask_user` 一样写成工厂:store 从装配处进来,工具本身不知道文件在哪。
 * 没开记忆时装配处**根本不注册它** —— 模型看不到,就不会白花一次调用。
 */
export function createRemember(store: MemoryStore): Tool<typeof parameters> {
	return {
		name: "remember",
		description:
			"记住用户的长期偏好、忌口、身体条件、去过的地方,或者忘掉一条过时的记忆。" +
			`记下来的东西会出现在以后每一次对话里(上限 ${MAX_ITEMS} 条)。` +
			"只记跨会话都成立的事 —— 这次的日期、人数、预算不要记。不要为了记而专门问用户。",
		parameters,

		/**
		 * @throws 两个字段都空、或者一次记超过 5 条时抛。
		 *         落盘失败也照常往上抛 —— 记忆没写进去这件事必须让模型知道,
		 *         不然它会以为记住了,下次却发现没有。
		 */
		async execute(_toolCallId, params, _signal): Promise<ToolResult> {
			const drafts = params.remember ?? [];
			const ids = params.forget ?? [];
			if (drafts.length === 0 && ids.length === 0) {
				throw new Error("remember 和 forget 至少要给一个");
			}
			if (drafts.length > MAX_PER_CALL) {
				throw new Error(`一次最多记 ${MAX_PER_CALL} 条,收到 ${drafts.length} 条`);
			}

			// 先忘后记:满了的时候,「忘掉 3 顺便记一条新的」才能在一次调用里成立。
			const forgotten = ids.length > 0 ? store.forget(ids) : [];
			const result = store.add(drafts.map((draft) => ({ kind: draft.kind as MemoryKind, text: draft.text })));

			const lines: string[] = [];
			if (forgotten.length > 0) lines.push(`已忘掉:${forgotten.join("、")}`);
			const missing = ids.filter((id) => !forgotten.includes(id));
			if (missing.length > 0) lines.push(`没找到这些编号:${missing.join("、")}`);
			if (result.added.length > 0) {
				lines.push(`已记住:${result.added.map((item) => `[${item.id}] ${item.text}`).join(";")}`);
			}
			if (result.duplicated.length > 0) lines.push(`早就记过了,没重复记:${result.duplicated.join("、")}`);
			for (const item of result.rejected) lines.push(`没记「${item.text}」:${item.reason}`);
			lines.push(`当前共 ${store.items().length}/${MAX_ITEMS} 条。`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { added: result.added, forgotten, duplicated: result.duplicated, rejected: result.rejected },
			};
		},
	};
}
