/**
 * ask_user 工具:信息不全时向人提问,拿到答复再继续。
 *
 * 层:tools。它是 `Asker` 能力的**使用者** —— 不认识终端、不认识 HTTP、
 *     不碰 `process.stdin`。怎么问人是宿主的事,由装配时注入。
 * 边界:把「追问」从一段自然语言变成 loop 里可观测、可 trace 的一步 ——
 *       模型说「请问你去几天?」只是文本,turn 就结束了;调这个工具则是一次真正的
 *       工具调用,有 tool_start/tool_end 事件,将来也会进 session。
 */

import { Type } from "typebox";
import type { Asker, Tool, ToolResult } from "../core/types.ts";

const MAX_QUESTIONS = 4;

const parameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "这个问题的短标识,如 days / budget。答复里会原样带回" }),
			question: Type.String({ description: "要问的话。一次问一件事,别把三个问题塞进一句" }),
			hint: Type.Optional(Type.String({ description: "给用户的提示,如「例:3天」。可选" })),
		}),
		{ description: `一次可以问 1-${MAX_QUESTIONS} 个。相关的问题一次问完,别来回追问` },
	),
});

/**
 * 造一个绑定了具体提问方式的 `ask_user` 工具。
 *
 * 写成工厂而不是常量,就是为了让 `asker` 从外面进来。装配处不给 asker 时**根本不注册
 * 这个工具** —— 比注册一个必然失败的工具好:模型压根看不到它,不会白花一次调用去试。
 */
export function createAskUser(asker: Asker): Tool<typeof parameters> {
	return {
		name: "ask_user",
		description:
			"向用户提问并等待答复。规划所需的关键信息缺失时用它 —— 比如没说去几天、预算多少、几个人。" +
			"不要用它确认你已经能自己决定的事,也不要用它代替给建议。",
		parameters,

		/** @throws 问题数越界时抛;`asker` 自己的失败(比如连接断了)也照常往上抛。 */
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			if (params.questions.length < 1 || params.questions.length > MAX_QUESTIONS) {
				throw new Error(`一次只能问 1-${MAX_QUESTIONS} 个问题,收到 ${params.questions.length} 个`);
			}
			const answers = await asker.ask(params.questions, signal);
			const text = answers.map((entry) => `${entry.id}: ${entry.answer || "(未回答)"}`).join("\n");
			return { content: [{ type: "text", text: `用户答复:\n${text}` }], details: { answers } };
		},
	};
}
