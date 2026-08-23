/**
 * weather 工具 —— **Step 2a 的假数据版**,只为把工具调用这条链跑通。
 *
 * 层:tools(旅行域)。Step 3a 换成高德 `/v3/weather/weatherInfo` 真接口,
 *     届时本文件的 `execute` 整个替换,`name`/`description`/`parameters` 不动。
 * 边界:不认识 loop、不认识 registry,只导出一个对象。
 */

import { Type } from "typebox";
import type { Tool, ToolResult } from "../core/types.ts";

const parameters = Type.Object({
	// 这些 description 会原样进请求体,是 prompt 的一部分。
	// 「不要带市字」这种话写在这里比写进 system prompt 有效 —— 它就贴在参数旁边。
	city: Type.String({ description: "城市名,如「成都」。不要带「市」字" }),
	days: Type.Optional(Type.Integer({ description: "查几天,1-7,默认 3" })),
});

/** 假数据用的固定天气池。按城市名的字符和取模,保证同一个城市每次结果一样。 */
const FAKE_DAYS = [
	{ text: "晴", low: 12, high: 24 },
	{ text: "多云", low: 14, high: 22 },
	{ text: "小雨", low: 11, high: 18 },
	{ text: "阴", low: 13, high: 20 },
	{ text: "雷阵雨", low: 16, high: 26 },
];

/** 拿城市名做一个稳定的偏移,让不同城市的假数据不一样、同城市每次一样。 */
function cityOffset(city: string): number {
	let sum = 0;
	for (const char of city) sum += char.codePointAt(0) ?? 0;
	return sum % FAKE_DAYS.length;
}

export const weather: Tool<typeof parameters> = {
	name: "weather",
	description: "查询某个城市未来几天的天气。需要按天安排户外行程时先查这个。",
	parameters,

	/**
	 * 返回假数据,但**保留真实工具的两个形状**:content 精简给模型看,
	 * details 结构化给 UI 和报告用。Step 3a 换成真接口时只有这一个方法变。
	 *
	 * @throws days 超出 1-7 时抛 —— 故意留一条能被模型触发的错误路径,
	 *         用来验收「工具抛异常时 loop 不崩,错误回灌给模型」。
	 */
	async execute(_toolCallId, params): Promise<ToolResult> {
		const days = params.days ?? 3;
		if (days < 1 || days > 7) {
			throw new Error(`days 只支持 1-7,收到 ${days}`);
		}
		const offset = cityOffset(params.city);
		const forecast = Array.from({ length: days }, (_unused, index) => {
			const day = FAKE_DAYS[(offset + index) % FAKE_DAYS.length]!;
			return { day: index + 1, ...day };
		});
		const summary = forecast.map((f) => `第${f.day}天 ${f.text} ${f.low}~${f.high}°C`).join("、");
		return {
			content: [{ type: "text", text: `[假数据] ${params.city}未来${days}天:${summary}` }],
			details: { city: params.city, days, forecast, source: "fake" },
		};
	},
};
