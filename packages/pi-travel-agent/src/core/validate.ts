/**
 * 工具参数校验:先 Convert 再 Check。
 *
 * 层:core —— 只认 typebox schema,不认识任何具体工具。
 * 边界:失败时抛,由 loop 包成错误结果回灌给模型。所以错误消息是**写给模型看的**,
 *       要说清哪个字段错了,它才可能改对重试。
 */

import type { TSchema } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { Tool } from "./types.ts";

/** 编译一次能复用。按 schema 对象缓存 —— 工具是常量,schema 也是。 */
const validators = new WeakMap<TSchema, ReturnType<typeof Compile>>();

/** 取(或编译)某个 schema 的校验器。 */
function validatorFor(schema: TSchema): ReturnType<typeof Compile> {
	const cached = validators.get(schema);
	if (cached) return cached;
	const compiled = Compile(schema);
	validators.set(schema, compiled);
	return compiled;
}

/**
 * 校验并转换一次工具调用的参数。
 *
 * **先 Convert 再 Check**:模型经常把数字写成字符串(`"days": "3"`),
 * 直接 Check 会失败,Convert 能救回来。反过来先 Check 就白白拒掉一批本可用的调用。
 *
 * 在**副本**上做转换:`Value.Convert` 是原地改的,而 `toolCall.arguments`
 * 挂在已经进了上下文的那条 assistant 消息上 —— 改它等于事后篡改日志,
 * 将来 replay 出来的东西就不是模型当时真正发出的东西了。
 *
 * @throws 校验不过时抛,消息里逐条列出哪个字段错在哪。
 */
export function validateArguments(tool: Tool, args: Record<string, unknown>): unknown {
	const converted = Value.Convert(tool.parameters, structuredClone(args));
	const validator = validatorFor(tool.parameters);
	if (validator.Check(converted)) return converted;

	// 只报前 5 条:一次错五个以上多半是模型完全没看懂 schema,列再多也没用。
	const problems = [...validator.Errors(converted)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "(根)"} ${error.message}`);
	throw new Error(`参数不合法:${problems.join(";")}`);
}
