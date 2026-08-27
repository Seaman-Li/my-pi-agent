/**
 * 终端这台设备的唯一持有者:一个 readline 接口、一个行缓冲、一把锁、一个 Ctrl-C 入口。
 *
 * 层:入口 —— 和 `process.stdin` 绑死,换成 HTTP 服务时整个文件作废。
 * 边界:**全项目只有本文件 import node:readline、只有本文件碰 process.stdin。**
 *       Step 5 之后有两个使用者要读一行(REPL 读用户这轮说什么,`ask_user` 读追问的答复),
 *       一台设备两个使用者,就必须有一个明确的持有者 —— 谁想读谁 createInterface 是错的。
 */

import { createInterface } from "node:readline";

/**
 * 终端能干的四件事。
 *
 * `question` 返回 `null` 而不是空串:**空串是「用户按了回车但没写字」,null 是「没有用户了」**
 * (管道喂完了、Ctrl-D、终端已关、这次读被取消)。REPL 靠这个区别决定是继续下一轮还是退出,合并不得。
 */
export interface Terminal {
	/** 读一行。整个调用独占终端,期间别人读不进来。 */
	question(prompt: string, signal?: AbortSignal): Promise<string | null>;
	/** 连着读几行,**整批独占一次终端**。见下面 `series` 的注释。 */
	series(prompts: string[], signal?: AbortSignal): Promise<(string | null)[]>;
	/** 注册 Ctrl-C 处理。可以注册多个,都会被调到。 */
	onInterrupt(handler: () => void): void;
	/** 关掉。之后所有读立刻返回 null。重复调用无害。 */
	close(): void;
}

/**
 * 后面是不是一个真人在敲键盘。
 *
 * 「有没有人可问」是**宿主知识**,装配处(cli.ts)要拿它决定注不注册 `ask_user`,
 * 而那一刻终端可能还没开。所以它是个独立函数而不是 `Terminal` 上的字段 ——
 * 顺带,`process.stdin` 这个名字也就还是只出现在本文件里。
 */
export function isInteractive(): boolean {
	return Boolean(process.stdin.isTTY);
}

/**
 * 开终端。**一个进程只该调一次** —— 调两次就等于回到「两个接口抢一个 stdin」。
 *
 * 三条实测结论撑着下面的实现(Node v22.22.1):
 *
 * 1. **同一个 stdin 上开两个 readline,一行输入会被送给两个** ——
 *    不是「先到先得」,是两份都拿到 `"hello"`。所以持有者只能有一个。
 *
 * 2. **不能「要读的时候才去读」。** 接口一建好就把 stdin 拉进 flowing 模式,
 *    管道里的内容会一口气全推过来:实测喂 `one\ntwo\nthree`,只有第一次
 *    `question()` 拿到 `one`,`two`/`three` 在没人接的时候**直接丢了**;
 *    紧接着 EOF 让接口自动 close,再调 `question()` 抛 `ERR_USE_AFTER_CLOSE`。
 *    表现是「管道喂多轮,只跑第一轮就结束」。
 *    所以这里常驻一个 `line` 监听把行接住(`buffered`),读的时候先从缓冲里取 ——
 *    顺带 TTY 上也就支持了抢打:turn 还在跑的时候先把下一句敲进去。
 *
 * 3. **接口开着的时候,TTY 下 Ctrl-C 只触发 `rl` 的 SIGINT,`process` 的那个不触发**;
 *    没有 TTY 时反过来(`kill -INT` 走 process,readline 收不到)。
 *    这条会咬人:Step 4 之前 cli.ts 用 `process.on("SIGINT")` 是好使的,因为那时
 *    readline 只在提问的一瞬间存在;REPL 让接口全程开着,那行代码就静默失效了。
 *    所以 `onInterrupt` 两边都挂 —— 同一次按键只会走通其中一条,不会重复触发。
 */
export function openTerminal(): Terminal {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const isTty = Boolean(process.stdin.isTTY);
	let closed = false;

	/** 已经读到、但还没人来取的行。见上面第 2 条 —— 不接住就是丢。 */
	const buffered: string[] = [];
	/** 正在等一行的人。锁保证同一时刻最多一个,数组只是为了能把自己摘出去。 */
	const waiting: ((line: string | null) => void)[] = [];

	rl.on("line", (line) => {
		const waiter = waiting.shift();
		if (waiter) waiter(line);
		else buffered.push(line);
	});
	rl.on("close", () => {
		closed = true;
		// 谁还在等就告诉谁「没有用户了」,别让 await 悬着 —— 那会让整个进程挂死。
		while (waiting.length > 0) waiting.shift()?.(null);
	});

	/** 非 TTY 时 readline 不回显。把行补打出来,转录里才看得出这句是用户说的。 */
	function echo(line: string): void {
		if (!isTty) process.stdout.write(`${line}\n`);
	}

	/**
	 * 串行化用的互斥链,指向链尾。原来住在 terminal-asker.ts 里,
	 * 随着「终端只有一个持有者」这条一起搬过来 —— 锁得跟着被保护的资源走。
	 *
	 * **不是队列** —— 没有容器,任何时刻都不存在一张待办清单,查不了长度也清不了空。
	 * 每个任务通过 `.then` 挂在前一个任务的 promise 上,「预约信息」记在前一个身上;
	 * 本变量只记住「现在链尾是哪一节」,好让下一个知道往谁后面接。
	 * 语义上等价于 Python 的 `asyncio.Lock`,JS 没有内置的,就用 promise 链手搓一个。
	 *
	 * 初始是 `Promise.resolve()`:必须是**已完成**状态,否则第一个任务永远不会开始 ——
	 * 对应 `Lock()` 初始未锁定。
	 */
	let tail: Promise<unknown> = Promise.resolve();

	/**
	 * 把 task 接到链尾,等前面的读完再读。
	 *
	 * `tail.then(task, task)` 两个位置都传 `task`:前一个**不管成功还是失败**都接着跑我。
	 * 只写一个参数的话,前一个一失败,后面排队的全被跳过,链条永久卡死。
	 *
	 * 新链尾用两个 `() => undefined` 收尾,于是它**永远是 fulfilled** ——
	 * 链尾只回答「到这儿为止排完了吗」,不该携带成败。顺带这也给 `next` 挂上了
	 * rejection handler,调用方即使丢弃返回值也不会冒 unhandledRejection。
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
	 * 真正读一行。**不加锁** —— 加锁的是 `series`,免得一批问题被别人插进来。
	 *
	 * 被 signal 取消时把自己从 `waiting` 里摘掉然后返回 null,**不动 rl**。
	 * Step 3 那版是在 abort 时 `rl.close()`:那等于为了取消一次追问把整台设备报废,
	 * REPL 一来就变成「Ctrl-C 打断一次追问,之后再也读不到输入」。
	 * 取消的是这一次读,不是终端。
	 */
	async function readLine(prompt: string, signal?: AbortSignal): Promise<string | null> {
		const ready = buffered.shift();
		if (ready !== undefined) {
			process.stdout.write(prompt);
			echo(ready);
			return ready;
		}
		if (closed || signal?.aborted) return null;
		rl.setPrompt(prompt);
		rl.prompt();
		return new Promise<string | null>((resolve) => {
			const settle = (line: string | null): void => {
				const index = waiting.indexOf(settle);
				if (index >= 0) waiting.splice(index, 1);
				signal?.removeEventListener("abort", onAbort);
				if (line !== null) echo(line);
				resolve(line);
			};
			const onAbort = (): void => settle(null);
			waiting.push(settle);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * 连着读几行,整批独占一次终端。
	 *
	 * **锁的粒度是「一批」不是「一行」**:工具的执行阶段是并行的,两个 `ask_user`
	 * 可能同时在跑。锁到行的话,两批问题会交替打进同一个终端 ——
	 * 用户看到「? 去几天」「? 预算多少」交错出现,不知道自己在回答哪一个。
	 */
	async function series(prompts: string[], signal?: AbortSignal): Promise<(string | null)[]> {
		return chain(async () => {
			const lines: (string | null)[] = [];
			for (const prompt of prompts) lines.push(await readLine(prompt, signal));
			return lines;
		});
	}

	return {
		series,
		async question(prompt: string, signal?: AbortSignal): Promise<string | null> {
			const [line] = await series([prompt], signal);
			return line ?? null;
		},
		onInterrupt(handler: () => void): void {
			rl.on("SIGINT", handler);
			process.on("SIGINT", handler);
		},
		close(): void {
			if (!closed) rl.close();
		},
	};
}
