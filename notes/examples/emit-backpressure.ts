/**
 * emit 的背压：生产者代码一行不改，节奏完全由消费者决定
 *
 * 运行：
 *   node --experimental-strip-types notes/examples/emit-backpressure.ts
 * 类型检查（含顶层 await，需要 module/target 标志）：
 *   npx tsc --noEmit --skipLibCheck --module esnext --target es2022 \
 *           --moduleResolution bundler notes/examples/emit-backpressure.ts
 *
 * 相关笔记：../agent-loop.md 第七节、../ts-notes.md 第 17 条
 */

export {};

type Event = { type: string; n: number };

// 和 agent-loop.ts:25 同形
type EventSink = (event: Event) => Promise<void> | void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 生产者：三次运行用的是同一个函数，一个字都没改 ──
async function produce(emit: EventSink): Promise<void> {
	for (let n = 1; n <= 3; n++) {
		await emit({ type: "tick", n }); // ← 等什么？等 emit 返回的东西
	}
}

async function run(label: string, emit: EventSink) {
	const t0 = Date.now();
	await produce(emit);
	console.log(`${label.padEnd(28)} 总耗时 ${Date.now() - t0} ms\n`);
}

// ① 同步 sink：返回 undefined，await 立刻放行
await run("① 同步 (void)", (e) => {
	void e;
});

// ② 异步 sink：返回 Promise，生产者被真实拖慢
await run("② 异步 (Promise<void>)", async (e) => {
	await sleep(50); // 假装写数据库
	void e;
});

// ③ 异步但不 await 内部工作：Promise 立刻 resolve，背压消失
await run("③ 异步但内部 fire-and-forget", async (e) => {
	void sleep(50).then(() => void e); // 没 await → 生产者不等
});

/* ═══════════════════════════════════════════════════════
 * 输出（约数）：
 *   ① 同步 (void)                  总耗时 0 ms
 *   ② 异步 (Promise<void>)         总耗时 150 ms   ← 3 × 50
 *   ③ 异步但内部 fire-and-forget    总耗时 0 ms
 *
 * 三次的 produce() 完全相同。生产者无从知道自己会等多久，
 * 也不需要知道 —— 节奏的决定权被交给了消费者（控制反转）。
 *
 * ③ 说明「声明成 async」不等于「有背压」：
 * 关键是返回的 Promise 何时 resolve，不是函数带不带 async。
 *
 * ═══════════════════════════════════════════════════════
 * 对应到 pi 的两条真实路径：
 *
 *   agent.ts:418        (event) => this.processEvents(event)
 *                       → 情形 ②，processEvents 是真 async，有背压
 *
 *   agent-loop.ts:44    async (event) => { stream.push(event) }
 *                       → 情形 ③，push 是同步 void，队列无上限，无背压
 *
 * 想让 EventStream 也有背压，push 必须返回一个
 * 「等消费者真的取走这一条」才 resolve 的 Promise。
 * 现在的实现（event-stream.ts:21）返回 void，做不到。
 * ═══════════════════════════════════════════════════════ */
