/**
 * weather 工具:查某城未来几天天气。数据来自高德 `/v3/weather/weatherInfo`。
 *
 * 层:tools(旅行域)。
 * 边界:只做「高德字段 → 给模型看的一句话 + 给报告用的结构化数据」这层翻译,
 *       HTTP 在 amap.ts 里。
 */

import { Type } from "typebox";
import type { Tool, ToolResult } from "../core/types.ts";
import { fetchForecast } from "./amap.ts";

/**
 * 高德的免费预报只给「今天 + 后三天」,写 7 会让模型提出永远满足不了的要求。
 *
 * 这个上限**必须出现在返回值里**,不能只写在参数 description 上:实测用户说
 * 「10.1 去杭州」,模型照常调了 weather,拿到 8 月底这四天,然后把它当成国庆的天气报了出去。
 * 参数说明只约束「能填几」,约束不了「拿到的是哪几天」—— 后者只有结果自己说得清。
 */
const MAX_DAYS = 4;

const parameters = Type.Object({
	// 这些 description 会原样进请求体,是 prompt 的一部分。
	// 「不要带市字」写在这里比写进 system prompt 有效 —— 它就贴在参数旁边。
	city: Type.String({ description: "城市名,如「成都」。不要带「市」字" }),
	days: Type.Optional(Type.Integer({ description: `查几天,1-${MAX_DAYS}(含今天),默认 3` })),
});

export const weather: Tool<typeof parameters> = {
	name: "weather",
	description: "查询某个城市未来几天的天气预报。需要按天安排户外行程、或者判断要不要带伞时先查这个。",
	parameters,

	/**
	 * @throws days 越界、城市查不到、或高德返回错误时抛。
	 *         这里不 catch —— 按约定由 loop 包成错误结果回灌给模型。
	 */
	async execute(_toolCallId, params, signal): Promise<ToolResult> {
		const days = params.days ?? 3;
		if (days < 1 || days > MAX_DAYS) {
			throw new Error(`days 只支持 1-${MAX_DAYS},收到 ${days}`);
		}
		const forecast = await fetchForecast(params.city, signal);
		const casts = forecast.casts.slice(0, days);
		const summary = casts
			.map((cast) => `${cast.date} ${cast.dayweather}转${cast.nightweather} ${cast.nighttemp}~${cast.daytemp}°C`)
			.join("；");
		const first = casts[0]?.date ?? "";
		const last = casts[casts.length - 1]?.date ?? "";
		return {
			content: [
				{
					type: "text",
					text:
						`${forecast.city} ${summary}(数据时间 ${forecast.reporttime})。` +
						`本次预报只覆盖 ${first} 到 ${last} —— 高德最多给今天起 ${MAX_DAYS} 天,` +
						`出行日期不在这个区间里就是查不到,不要拿这几天的天气代替。`,
				},
			],
			details: { ...forecast, casts },
		};
	},
};
