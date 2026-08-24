/**
 * estimate_budget 工具:把一堆开销条目加起来,按类目汇总。
 *
 * 层:tools(旅行域)。**唯一不联网的工具** —— 纯计算。
 * 边界:不猜价格。金额全部由调用方(模型)给出,这里只负责算对、算清楚。
 *       让模型自己编价格是它的事,但**算术不能也交给它** —— 那是它最容易错的地方。
 */

import { Type } from "typebox";
import type { Tool, ToolResult } from "../core/types.ts";

const CATEGORIES = ["交通", "住宿", "餐饮", "门票", "购物", "其他"] as const;

const parameters = Type.Object({
	items: Type.Array(
		Type.Object({
			category: Type.String({ description: `类目,取值:${CATEGORIES.join("/")}` }),
			name: Type.String({ description: "这笔开销是什么,如「成都往返高铁」「武侯祠门票」" }),
			amount: Type.Number({ description: "单价,人民币元" }),
			quantity: Type.Optional(Type.Number({ description: "数量(人数或份数),默认 1" })),
		}),
		{ description: "所有开销条目。行程里每一笔都列出来,别合并成一条" },
	),
	budget: Type.Optional(Type.Number({ description: "用户给的预算上限,元。给了就会算出结余或超支" })),
});

export const estimateBudget: Tool<typeof parameters> = {
	name: "estimate_budget",
	description: "把行程里的各项开销加总并按类目汇总,可选地和预算上限比较。给出总价前先用它算,不要口算。",
	parameters,

	/** @throws 条目为空、金额为负、或类目不认识时抛。 */
	async execute(_toolCallId, params): Promise<ToolResult> {
		if (params.items.length === 0) throw new Error("items 不能为空");

		const lines: string[] = [];
		const byCategory = new Map<string, number>();
		let total = 0;

		for (const item of params.items) {
			if (item.amount < 0) throw new Error(`「${item.name}」的金额不能是负数`);
			const quantity = item.quantity ?? 1;
			if (quantity <= 0) throw new Error(`「${item.name}」的数量必须大于 0`);
			const subtotal = item.amount * quantity;
			total += subtotal;
			byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + subtotal);
			lines.push(`${item.category} ${item.name} ${item.amount}×${quantity} = ${subtotal}`);
		}

		const breakdown = [...byCategory.entries()].map(([category, sum]) => `${category} ${sum}`).join("、");
		let verdict = `合计 ${total} 元(${breakdown})`;
		if (params.budget !== undefined) {
			const diff = params.budget - total;
			verdict += diff >= 0 ? `,预算 ${params.budget},结余 ${diff}` : `,预算 ${params.budget},超支 ${-diff}`;
		}

		return {
			content: [{ type: "text", text: verdict }],
			details: {
				total,
				budget: params.budget,
				byCategory: Object.fromEntries(byCategory),
				items: params.items.map((item) => ({ ...item, quantity: item.quantity ?? 1 })),
				lines,
			},
		};
	},
};
