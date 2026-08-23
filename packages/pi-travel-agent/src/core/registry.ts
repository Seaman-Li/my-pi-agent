/**
 * 工具注册表:按名字存工具,并把「发给模型的那一半」摘出来。
 *
 * 层:core —— 不知道有哪些工具,只知道工具长什么样。
 * 边界:注册发生在装配处(Step 2a 在 cli.ts,2b 之后搬去 compose.ts)。
 *       loop 只从这里 `get`,不认识任何具体工具。
 */

import type { Tool as AiTool } from "@earendil-works/pi-ai";
import type { Tool } from "./types.ts";

// 注:`Tool<typeof parameters>` 能直接赋给 `Tool`(即 `Tool<TSchema>`),
// 因为 `execute` 用的是方法语法 —— 方法的参数是双变的,不受 strictFunctionTypes 约束。
// 换成 `execute: (…) => …` 的属性语法这里就会报错,得退回 `Tool<any>`。

export class Registry {
	private readonly tools = new Map<string, Tool>();

	/**
	 * 注册一个工具。
	 *
	 * @throws 重名时抛。工具名是模型唯一的抓手,悄悄覆盖会让「模型调了 A 却执行了 B」
	 *         变成一个查不出来的 bug,所以在装配期就炸掉。
	 */
	register(tool: Tool): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`工具重名:${tool.name}`);
		}
		this.tools.set(tool.name, tool);
	}

	/** 按名字取工具。取不到返回 undefined —— 模型有可能编一个不存在的工具名出来。 */
	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	/** 已注册的工具,按注册顺序。 */
	list(): Tool[] {
		return [...this.tools.values()];
	}

	/**
	 * 摘出发给模型的那一半,喂给 `Context.tools`。
	 *
	 * 明确剥掉 `execute` 而不是直接把 `Tool` 传过去:`Tool` 结构上本来就兼容
	 * `AiTool`,传过去也能跑,但那样请求体里塞了什么就取决于下游怎么读这个对象。
	 * 剥一次只要三行,换来「进请求体的东西是我明确列出来的」。
	 */
	schemas(): AiTool[] {
		return this.list().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
	}
}
