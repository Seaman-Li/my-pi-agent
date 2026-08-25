/**
 * `Asker` 的终端实现:在当前终端上逐条提问、读一行答复。
 *
 * 层:入口 —— 它是 CLI 这个宿主提供的后端实现,和 `process.stdin` 绑死。
 *     换成 HTTP 服务时整个文件作废,换一个「推给前端并等待」的实现即可,
 *     `ask_user` 工具一个字都不用动。
 * 边界:只有本文件碰 stdin。终端独占这件事带来的约束(互斥)也只写在这里 ——
 *       服务端每个请求各问各的,没有这个约束。
 */

import { createInterface } from "node:readline/promises";
import type { Answer, Asker, Question } from "./core/types.ts";

/**
 * 串行化用的互斥链,指向链尾。
 *
 * **不是队列** —— 没有容器,任何时刻都不存在一张待办清单,查不了长度也清不了空。
 * 每个任务通过 `.then` 挂在前一个任务的 promise 上,「预约信息」记在前一个身上;
 * 本变量只记住「现在链尾是哪一节」,好让下一个知道往谁后面接。
 * 语义上等价于 Python 的 `asyncio.Lock`,JS 没有内置的,就用 promise 链手搓一个。
 *
 * 初始是 `Promise.resolve()`:必须是**已完成**状态,否则第一个任务永远不会开始 ——
 * 对应 `Lock()` 初始未锁定。
 *
 * 为什么需要它:工具的执行阶段是并行的,但**终端只有一个**。两次提问同时跑会把提示
 * 交错打进同一个终端,用户不知道自己在回答哪一个,readline 也会抢同一个 stdin。
 */
let tail: Promise<unknown> = Promise.resolve();

/**
 * 把 task 接到链尾,等前面的问完再问。
 *
 * `tail.then(task, task)` 两个位置都传 `task`:前一个**不管成功还是失败**都接着跑我。
 * 只写一个参数的话,前一个一失败,后面排队的全被跳过,链条永久卡死。
 *
 * 新链尾用两个 `() => undefined` 收尾,于是它**永远是 fulfilled** ——
 * 链尾只回答「到这儿为止排完了吗」,不该携带成败。顺带这也给 `next` 挂上了
 * rejection handler,调用方即使丢弃返回值也不会冒 unhandledRejection。
 *
 * 返回 `next` 而不是 `tail`:真实结果和异常要给调用方,链尾那份已经被吞成 undefined 了。
 */
function chain<T>(task: () => Promise<T>): Promise<T> {
	const next = tail.then(task, task);
	tail = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

/**
 * 造一个终端 asker。
 *
 * 调用方(cli.ts)负责判断当前有没有终端 —— 非交互环境下**根本别造它**,
 * 装配处就不会注册 `ask_user`,模型看不到这个工具,也就不会白花一次调用。
 * 「有没有人可问」是宿主的知识,不该由工具在运行时才发现。
 */
export function createTerminalAsker(): Asker {
	return {
		async ask(questions: Question[], signal?: AbortSignal): Promise<Answer[]> {
			return chain(async () => {
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				const abort = () => rl.close();
				signal?.addEventListener("abort", abort, { once: true });
				try {
					const answers: Answer[] = [];
					for (const item of questions) {
						const hint = item.hint ? `(${item.hint})` : "";
						const answer = (await rl.question(`\n? ${item.question}${hint}\n> `)).trim();
						answers.push({ id: item.id, question: item.question, answer });
					}
					return answers;
				} finally {
					signal?.removeEventListener("abort", abort);
					rl.close();
				}
			});
		},
	};
}
