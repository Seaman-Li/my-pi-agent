import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * 对外事件。UI 只认这一层。
 *
 * 单向广播:sink 拿到事件后不能改数据、不能拦截 —— 那是 Step 2 的 hook 干的事。
 * 这个区分就是 dsh 里 `emit`(观察)和 `waterfall`(可改可短路)的区分,
 * 现在只有 emit 这一半。
 *
 * `assistant_event` 直接透传 pi-ai 的 14 种流式事件,不再包一层:
 * 包一层只会在 Step 2 之前反复改,等真有第二个事件源了再说。
 */
export type AgentEvent = { type: "assistant_event"; event: AssistantMessageEvent } | { type: "error"; message: string };

/**
 * 返回类型是 `void | Promise<void>` 这个联合。三种写法都试过,只有联合是对的:
 *
 * - `Promise<void>`:同步 sink 被迫写成 `async` 或 `return Promise.resolve()`,
 *   纯粹为了签名包一层。
 * - 裸 `void`:按 ts-notes 第 23 条那条宽松规则,`async` sink 也能赋进来,
 *   但调用方拿不到 Promise、await 不上 —— 异步 sink 变成浮空 Promise,静默乱序。
 * - 联合:同步的什么都不返回,异步的返回 Promise,调用方一律 `await`,两种都对。
 *   代价是宽松规则失效(联合不再是 `void` 本身),`(e) => 42` 会被拒 —— 正好。
 *
 * `await` 换来的是**顺序**,不是背压:pi-ai 的 `EventStream.push()` 是同步入队
 * (packages/ai/src/utils/event-stream.ts:22),生产端不会因为 sink 慢而少读网络。
 * 实测慢 sink:producer 4.4s 读完,consumer 10.7s 才追上,队列在内存里堆着。
 */
export type EventSink = (event: AgentEvent) => Promise<void> | void;
