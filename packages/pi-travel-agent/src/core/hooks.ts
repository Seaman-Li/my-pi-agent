/**
 * Hook 注册表:loop 上的四个挂载点,以及在它们上面串起 handler 的规则。
 *
 * 层:core —— 不知道有哪些 hook,只知道它们长什么样、按什么规则跑。
 * 边界:loop 只调本文件的四个 `run*`;feature 只往数组里 push。
 *       两边都不认识对方 —— 这就是「加一块积木不用改 loop」的全部机制。
 */

import type { AssistantMessage, Context, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolResult } from "./types.ts";

export interface StepContext {
	/** 第几步,从 1 开始。 */
	step: number;
	/** 可以原地改:往 messages 里塞东西就是「注入上下文」,memory 和 compaction 都从这儿下手。 */
	context: Context;
}

export interface AfterStepContext extends StepContext {
	message: AssistantMessage;
	/**
	 * 这一步执行出来的工具结果。turn 在这一步结束时为空数组。
	 *
	 * 压缩判定要它:工具输出往往是上下文里最大的一块(POI 搜索能返回几十条),
	 * 只看 `message` 会严重低估这一步实际吃掉多少上下文。
	 */
	results: ToolResultMessage[];
}

export interface ToolCallContext {
	step: number;
	toolCall: ToolCall;
}

export interface AfterToolContext {
	step: number;
	toolCall: ToolCall;
	/** 原地改。给工具输出加「以下是外部数据」这类标注就是改这里的 content。 */
	result: ToolResultMessage;
}

/**
 * `beforeToolCall` 想拦下这次调用时返回的东西。返回它 = 工具不执行,拿这个当结果。
 *
 * 单独包一层而不是直接返回 `ToolResult`:拦截既可能是「拒绝」(Step 8 的 guard,
 * 要让模型知道被挡了),也可能是「命中缓存」(不是错误)。两种都得表达。
 */
export interface ToolCallOverride {
	result: ToolResult;
	isError?: boolean;
}

/**
 * `beforeStep` 想把这一步挡下来时返回的东西。返回它 = **这次请求根本不发**,turn 就此结束。
 *
 * 只有一个字段,而且它是**给模型也给人看的那句话**:它会作为一条 assistant 消息
 * 进历史(loop.ts),用户在终端上看到的就是它。所以写的时候当成「助手会怎么回绝」,
 * 不是「系统错误信息」。
 *
 * **为什么值得为它改 loop。** `runBeforeStep` 原来返回 `void`,handler 只能改 context,
 * 没法说「这步别发了」。而域外拦截和输入上限这两件事的**全部价值就在于不发请求** ——
 * 发出去再判断,省不下钱也省不下延迟。「改 loop 的唯一合法理由是增加挂载点能力」,
 * 这条属于那一类,Step 2b 建骨架时就记在 BACKLOG 里免得到时候当成意外。
 */
export interface StepRejection {
	message: string;
}

export interface Hooks {
	// 和 `beforeToolCall` 同一个形状:返回值 = 拦下来,什么都不返回 = 放行。
	// void 是必需的,理由见下面那条注释。
	// biome-ignore lint/suspicious/noConfusingVoidType: 见 beforeToolCall
	beforeStep: ((ctx: StepContext) => Promise<StepRejection | void> | StepRejection | void)[];
	// 这里的 void 是必需的:只观察不拦截的 handler 得能「什么都不返回」;
	// 换成 undefined 就要求每个观察者显式 `return undefined`。
	// biome-ignore lint/suspicious/noConfusingVoidType: 见上
	beforeToolCall: ((ctx: ToolCallContext) => Promise<ToolCallOverride | void> | ToolCallOverride | void)[];
	afterToolCall: ((ctx: AfterToolContext) => Promise<void> | void)[];
	afterStep: ((ctx: AfterStepContext) => Promise<void> | void)[];
}

/** 一个什么都没挂的注册表。装配处从这里开始往上加。 */
export function emptyHooks(): Hooks {
	return { beforeStep: [], beforeToolCall: [], afterToolCall: [], afterStep: [] };
}

/**
 * 按注册顺序串行跑 `beforeStep`,**第一个返回拒绝的赢,后面的不再跑**。
 *
 * 串行不是性能问题:后一个 handler 要看到前一个改过的 context。
 * 短路和 `beforeToolCall` 同一条理由 —— 拦不拦是个单点决策,两个 handler 同时说
 * 「我来拒」没有合理的合并方式。只想注入上下文的 handler 什么都别返回。
 *
 * **顺序因此变得有意义了**:闸要挂在注入前面。挡下来的那一步不发请求,
 * 后面那些注入白做 —— 而这正是那道闸存在的理由。装配顺序在 compose.ts 里定。
 */
export async function runBeforeStep(hooks: Hooks, ctx: StepContext): Promise<StepRejection | undefined> {
	for (const handler of hooks.beforeStep) {
		const rejection = await handler(ctx);
		if (rejection) return rejection;
	}
	return undefined;
}

/**
 * 按注册顺序跑 `beforeToolCall`,**第一个返回值的赢,后面的不再跑**。
 *
 * 短路是有意的:拦截是个单点决策,两个 handler 同时说「我来给结果」没有合理的合并方式。
 * 想观察而不拦截的 handler 什么都别返回 —— 这正是 dsh 里 waterfall
 * 「调 next() 就是委派,不调就是短路」的最小版本。
 */
export async function runBeforeToolCall(hooks: Hooks, ctx: ToolCallContext): Promise<ToolCallOverride | undefined> {
	for (const handler of hooks.beforeToolCall) {
		const override = await handler(ctx);
		if (override) return override;
	}
	return undefined;
}

/** 按注册顺序串行跑 `afterToolCall`。handler 原地改 `ctx.result`,没有返回值可言。 */
export async function runAfterToolCall(hooks: Hooks, ctx: AfterToolContext): Promise<void> {
	for (const handler of hooks.afterToolCall) await handler(ctx);
}

/** 按注册顺序串行跑 `afterStep`。一步的模型请求**和它的工具**都跑完了才触发。压缩判定将来挂这里。 */
export async function runAfterStep(hooks: Hooks, ctx: AfterStepContext): Promise<void> {
	for (const handler of hooks.afterStep) await handler(ctx);
}
