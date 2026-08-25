/**
 * core 层对外的词汇表:工具长什么样、agent 内部发生的事怎么告诉外面,以及一个读它的小工具。
 *
 * 层:core —— 不认识 UI、不认识旅行、不认识任何具体实现。
 * 边界:只放「被两个以上文件用到」的类型。单个文件自己用的类型留在那个文件里。
 */

import type {
	Tool as AiTool,
	AssistantMessageEvent,
	ImageContent,
	Static,
	TextContent,
	TSchema,
} from "@earendil-works/pi-ai";

/**
 * 工具返回的两半。这个二分从第一天就得分清:
 *
 * - `content` 进上下文,给模型看。要精简 —— 每个字都在花 token。
 * - `details` 不进上下文,给 UI 和 HTML 报告用。经纬度、图片 URL、原始响应全放这。
 */
export interface ToolResult {
	content: TextContent[];
	details?: unknown;
}

/**
 * 一个可执行的工具 = pi-ai 的 `Tool`(name/description/parameters)+ `execute`。
 *
 * 前三个字段会**原样进请求体**,所以 description 和 schema 里那些 `description`
 * 文字是 prompt 的一部分,不是写给人看的注释 —— 模型认不认得出这个工具全看它们。
 */
export interface Tool<S extends TSchema = TSchema> extends AiTool<S> {
	execute(toolCallId: string, params: Static<S>, signal?: AbortSignal): Promise<ToolResult>;
}

/**
 * 「向人提问」这个能力的**定义**。core 只声明它长什么样,不提供实现。
 *
 * 三个角色分开:定义在这里,实现由入口给(CLI 给终端版、HTTP 服务给推送版、
 * 测试给固定答案版),使用者是 `ask_user` 工具。工具因此不认识 stdin、不认识 HTTP。
 *
 * 这是这个项目里唯一一个**必须由外部提供实现**的能力 —— 其余工具要么纯计算、
 * 要么发 HTTP,而「问人」在不同宿主里差别根本性:终端是读一行,服务端是
 * 推给前端然后挂起这个 turn 等回来。
 */
export interface Asker {
	ask(questions: Question[], signal?: AbortSignal): Promise<Answer[]>;
}

export interface Question {
	/** 短标识,如 days / budget。答复里原样带回,便于对应。 */
	id: string;
	question: string;
	hint?: string;
}

export interface Answer {
	id: string;
	question: string;
	/** 用户没答就是空串。空串和「没问过」是两回事,别合并。 */
	answer: string;
}

/**
 * 把一条工具结果里的文本拼起来。
 *
 * 我们的工具只产出 `TextContent`,但 pi-ai 的 `ToolResultMessage.content` 是
 * `(TextContent | ImageContent)[]` —— 宽出来的那一半现在用不到,以后(截图类工具)会用到。
 * 所以这里按 type 收窄而不是断言:将来真出现图片时,它是被跳过,不是崩掉。
 */
export function textOf(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * turn 为什么结束。**默认是停,继续才需要理由** —— 只有「模型要调工具而且这条消息是完整的」
 * 才继续下一步,其余全部落进这五种之一。
 *
 * - `completed`  模型没再要工具,正常说完
 * - `truncated`  这条回复被 maxTokens 截断了,里面的工具参数不可信
 * - `aborted`    Ctrl-C 或上游取消
 * - `error`      模型侧失败
 * - `max_steps`  步数触顶,防死循环的闸
 */
export type TurnEndReason = "completed" | "truncated" | "aborted" | "error" | "max_steps";

/**
 * 对外事件。UI 只认这一层。
 *
 * 单向广播:sink 拿到事件后不能改数据、不能拦截 —— 那是 Step 2b 的 hook 干的事。
 * 这个区分就是 dsh 里 `emit`(观察)和 `waterfall`(可改可短路)的区分,现在只有 emit 这一半。
 *
 * `assistant_event` 直接透传 pi-ai 的 14 种流式事件,不再包一层:
 * 包一层只会在需求稳定前反复改,等真有第二个模型事件源了再说。
 */
export type AgentEvent =
	| { type: "turn_start" }
	| { type: "step_start"; step: number }
	| { type: "assistant_event"; event: AssistantMessageEvent }
	| { type: "tool_start"; toolCallId: string; name: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; name: string; text: string; isError: boolean; ms: number }
	| { type: "turn_end"; reason: TurnEndReason; steps: number }
	| { type: "error"; message: string };

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
