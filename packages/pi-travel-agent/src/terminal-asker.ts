/**
 * `Asker` 的终端实现:把一组问题排版成终端上的文字,交给 `Terminal` 去读。
 *
 * 层:入口 —— 它是 CLI 这个宿主提供的后端实现。换成 HTTP 服务时整个文件作废,
 *     换一个「推给前端并等待」的实现即可,`ask_user` 工具一个字都不用动。
 * 边界:**不碰 stdin,也不管互斥** —— 那两件事在 terminal.ts。
 *       Step 5 之前它们都在本文件里,是因为那时终端只有它一个使用者;
 *       REPL 一来就有第二个了,锁必须跟着设备走,本文件只剩「问题长什么样」。
 */

import type { Answer, Asker, Question } from "./core/types.ts";
import type { Terminal } from "./terminal.ts";

/**
 * 造一个终端 asker。
 *
 * 调用方(cli.ts)负责判断当前有没有终端 —— 非交互环境下**根本别造它**,
 * 装配处就不会注册 `ask_user`,模型看不到这个工具,也就不会白花一次调用。
 * 「有没有人可问」是宿主的知识,不该由工具在运行时才发现。
 */
export function createTerminalAsker(terminal: Terminal): Asker {
	return {
		async ask(questions: Question[], signal?: AbortSignal): Promise<Answer[]> {
			const prompts = questions.map((item) => `\n? ${item.question}${item.hint ? `(${item.hint})` : ""}\n> `);
			const lines = await terminal.series(prompts, signal);
			// 读不到(输入结束 / 被 Ctrl-C 取消)一律记成空串 —— `Answer.answer` 的契约里
			// 空串就是「没答」,而「没问过」根本不会出现在这个数组里,两者本来就分得开。
			return questions.map((item, index) => ({
				id: item.id,
				question: item.question,
				answer: (lines[index] ?? "").trim(),
			}));
		},
	};
}
