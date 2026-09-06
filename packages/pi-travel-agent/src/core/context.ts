/**
 * 关于 `context.messages` 形状的不变量。两条:**toolCall 必须有 toolResult 配对**,
 * **不留空的 assistant 消息**。
 *
 * 层:core —— 不认识 UI、不认识旅行,只认识协议。
 * 边界:loop.ts 只管往 messages 里追加,它不负责收拾被中途打断的历史 ——
 *       那是「两轮之间」的事,而 loop 只活在一轮之内。所以这条不变量住在这里,
 *       由 REPL(Step 5a)和将来的 session 装载(Step 5b)在轮次边界上调用。
 */

import type { Context, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * 给没等到结果的 toolCall 补一条「没执行」的 toolResult。
 *
 * **什么时候会出现断链**:turn 以 aborted / truncated / error 结束时,
 * loop 已经把带 toolCall 的 assistant 消息 push 进去了(loop.ts:254),
 * 但那一步不会再执行工具(loop.ts:68 的注释说了为什么截断的调用不能执行)。
 * 于是历史里躺着一个没人回答的调用 —— 单轮时代它随进程一起消失,
 * 有了多轮,下一轮会把它原样发回给模型。
 *
 * **为什么要补,而不是不管**:
 * - 协议上,OpenAI / Anthropic 都要求 `tool_calls` 后面跟齐 `tool` 消息。
 *   实测 dashscope 和 Ollama **都没报错**(5 次里 Ollama 有 1 次不理会新问题、
 *   把同一个工具又调了一遍)—— 但「这家忍了」是运气,不是契约。
 *   整个 core/model.ts 的存在就是为了换 provider 只动一处,不能靠某一家的宽容活着。
 *
 *   **2026-09-04 补测,证实了「运气」这个说法**:同样在 dashscope 和 DeepSeek 上试
 *   「toolCall 和 toolResult 中间插一条 user 消息」——dashscope 照样不报错,
 *   **DeepSeek 直接 400**(`Messages with role 'tool' must be a response to a preceding
 *   message with 'tool_calls'`)。同一段畸形历史,一家忍一家不忍。
 *   而 dashscope 那次「忍了」是把整个工具调用无视掉、直接去答后一句 ——
 *   **忍了不等于对了,静默走偏比 400 难查得多。** 详见 BACKLOG 里 steering 那条。
 * - 语义上,模型看到自己发过调用却没有任何结果,只能猜。补一条「被中断了」
 *   是**如实告诉它发生过什么**,它下一轮才可能说「刚才查天气被打断了,要我重来吗」。
 *
 * **为什么是补,不是删**:删等于改历史 —— 用户在终端上明明看见 `[tool] weather(...)` 打出来了,
 * 记录里却没有。Step 5b 要把这些消息落成 JSONL,一条能对上终端的记录比一条干净的记录值钱。
 *
 * @returns 补了几条。0 表示没有断链,调用方可以据此决定要不要提示用户。
 */
export function repairDanglingToolCalls(context: Context, note: string): number {
	const answered = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "toolResult") answered.add(message.toolCallId);
	}

	const repaired: Message[] = [];
	/** 欠着的调用:已经见到发起它的 assistant,还没轮到把补的结果放下去。 */
	let debt: { toolCall: ToolCall; timestamp: number }[] = [];
	let count = 0;

	/**
	 * 把欠的补上。**时机是「后面不再有 toolResult 了」,不是「见到 assistant 的当下」。**
	 * 当下就插的话,一条 assistant 发了两个调用、只有第二个断链时,
	 * 补的那条会插到真实的那条**前面**去 —— 顺序和真跑过一遍时对不上,
	 * 而这份历史将来是要落成 JSONL、用来重放的,顺序就是它的全部价值。
	 */
	function flush(): void {
		for (const item of debt) {
			repaired.push({
				role: "toolResult",
				toolCallId: item.toolCall.id,
				toolName: item.toolCall.name,
				content: [{ type: "text", text: note }],
				isError: true,
				timestamp: item.timestamp,
			} satisfies ToolResultMessage);
			count++;
		}
		debt = [];
	}

	for (const message of context.messages) {
		// 一条非 toolResult 的消息意味着「上一条 assistant 的结果收齐了」。
		if (message.role !== "toolResult") flush();
		repaired.push(message);
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (answered.has(block.id)) continue;
			answered.add(block.id);
			debt.push({ toolCall: block, timestamp: message.timestamp });
		}
	}
	flush();

	// 原地替换而不是返回新 context:调用方(REPL)手里的 `context` 就是那一个,
	// 整个项目都靠「loop 原地追加、调用方持有全量历史」这条活着,别在这儿破了例。
	if (count > 0) context.messages = repaired;
	return count;
}

/**
 * 扔掉「什么都没说」的 assistant 消息。
 *
 * 模型侧请求失败时(网络断了、provider 报错),loop 照样会把那条空消息 push 进历史
 * (loop.ts:254 —— 它拿到什么就存什么,判断留不留不是它的事)。
 * 单轮时代无所谓;多轮之下这条空消息每轮都会被重新发出去。
 *
 * **为什么这条是删,而上面那条是补**:补的那些 toolCall,用户在终端上真看见
 * `[tool] weather(...)` 打出来了,历史得对得上眼睛看到的。而一条请求失败的空消息,
 * 用户什么都没看见,模型也什么都没说 —— 留着它是在历史里编造一次沉默。
 *
 * 有内容的**不删**,哪怕它 stopReason 是 error:流到一半断的那半句话是真吐出来过的。
 *
 * 实测 dashscope 收到空 assistant 消息不报错,但那又是「这家忍了」——
 * Anthropic 那套是直接拒的。
 *
 * @returns 扔了几条
 */
export function dropEmptyAssistantMessages(context: Context): number {
	const kept = context.messages.filter(
		(message) => message.role !== "assistant" || message.content.length > 0,
	);
	const dropped = context.messages.length - kept.length;
	if (dropped > 0) context.messages = kept;
	return dropped;
}
