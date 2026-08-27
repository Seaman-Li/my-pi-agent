/**
 * confirm —— 不可逆的工具,先问过人再执行。
 *
 * 层:features。挂 `beforeToolCall`,**loop.ts 一个字都不改**。
 * 边界:它是一道**硬闸,不是一条 prompt 规矩**。写进 system prompt 的
 *       「存报告前先问一句」是软的,模型忘了就忘了(实测就是这么翻车的);
 *       挂在这儿的,模型连「有人在替用户把关」这件事都不知道,也就无从绕过。
 *       这条更一般的说法在 BACKLOG 的 Q6 那节:**能不给模型的决定权就别给。**
 */

import type { Hooks, ToolCallContext, ToolCallOverride } from "../core/hooks.ts";
import type { Asker } from "../core/types.ts";

/** 一个工具要怎么确认。规则由装配处给 —— 只有那里既知道有哪些工具、又知道该怎么措辞。 */
export interface ConfirmRule {
	tool: string;
	/**
	 * 问用户的那句话。
	 *
	 * **拿到的是未经校验的原始参数**:`beforeToolCall` 跑在 `validateArguments` 之前
	 * (`core/loop.ts:165` vs `:189`),所以这里的 `args` 可能缺字段、类型也可能不对。
	 * 实现必须防着任何形状,别直接当成 schema 里那个类型用。
	 */
	question(args: Record<string, unknown>): string;
	/** 用户说不要时,**回灌给模型**的话。写给模型看的,不是写给人看的。 */
	declined: string;
}

/**
 * 什么算同意。
 *
 * 前缀匹配而不是全等:人会答「好的」「可以存」「要」,不会只答一个字母。
 */
const APPROVE = ["y", "yes", "是", "好", "要", "存", "可以", "行", "嗯", "ok", "确认", "保存"];

/**
 * 判断这条答复算不算同意。
 *
 * **空答复一律算「不要」** —— 这里的空包括「直接回车」和「压根读不到」
 * (终端被关、管道到头、Ctrl-C 之后 asker 返回空串)。确认闸的默认必须落在安全那一侧:
 * 读不到人的意思就当他没同意,而不是替他点头。代价是每次都得真敲一下,值。
 */
function approved(answer: string): boolean {
	const text = answer.trim().toLowerCase();
	if (text === "") return false;
	return APPROVE.some((word) => text.startsWith(word));
}

export interface ConfirmOptions {
	asker: Asker;
	rules: ConfirmRule[];
}

/**
 * 把确认闸挂上去。
 *
 * **没有 `asker` 就别调这个函数**(装配处判断),而不是在里面写个 if 放行 ——
 * 和 `ask_user` 一样的处理:没人可问的环境里(管道、CI)这块积木根本不存在。
 * 拦截的意义是尊重用户的意愿,没有用户就没有意愿要尊重。
 *
 * 一个白捡的性质:确认发生在 loop 的**串行准备阶段**(`core/loop.ts:159` 那段),
 * 所以哪怕模型一次并行发了六个工具,也不会同时弹出两个确认框 ——
 * loop 当初把准备和执行分开,理由里写的就是这件事。
 */
export function installConfirm(hooks: Hooks, options: ConfirmOptions): void {
	const byTool = new Map(options.rules.map((rule) => [rule.tool, rule]));
	hooks.beforeToolCall.push(async (ctx: ToolCallContext): Promise<ToolCallOverride | undefined> => {
		const rule = byTool.get(ctx.toolCall.name);
		if (!rule) return undefined;
		const answers = await options.asker.ask([
			{
				id: `confirm:${ctx.toolCall.name}`,
				question: rule.question(ctx.toolCall.arguments),
				hint: "y = 好,回车或 n = 先不",
			},
		]);
		if (approved(answers[0]?.answer ?? "")) return undefined;
		// **不是 error。** 用户的决定不是故障 —— 标成错误的话模型会当成出了问题,
		// 很可能换个参数再试一次,那就把闸绕过去了。
		return { result: { content: [{ type: "text", text: rule.declined }] }, isError: false };
	});
}
