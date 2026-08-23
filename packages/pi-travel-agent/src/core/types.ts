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
 * 返回类型写成联合而不是统一 `Promise<void>`:
 * 同步 sink 不用为了签名去包一层 Promise,而调用方一律 `await`,
 * 于是一个慢 sink 天然对上游产生背压。
 */
export type EventSink = (event: AgentEvent) => Promise<void> | void;
