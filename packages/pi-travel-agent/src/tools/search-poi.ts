/**
 * search_poi 工具:按关键词在某城搜地点(景点、餐厅、商圈都走它)。
 * 数据来自高德 `/v3/place/text`。
 *
 * 层:tools(旅行域)。
 * 边界:content 精简、details 完整 —— 这个二分在这个工具上体现得最明显,
 *       给模型看名字和评分就够,经纬度和图片留给 HTML 报告。
 */

import { Type } from "typebox";
import type { Tool, ToolResult } from "../core/types.ts";
import { type AmapPoi, searchPoi as amapSearchPoi } from "./amap.ts";
import { truncateLines } from "./truncate.ts";

/** 给模型看的上限。搜索能返回几十条,全塞进上下文很贵而且没用。 */
const CONTENT_LIMIT = { maxLines: 12, maxBytes: 1200 };

const parameters = Type.Object({
	city: Type.String({ description: "城市名,如「成都」。不要带「市」字" }),
	keyword: Type.String({ description: "搜什么,如「博物馆」「川菜」「宽窄巷子」。越具体结果越准" }),
	limit: Type.Optional(Type.Integer({ description: "最多返回几条,1-25,默认 10" })),
});

/** 一条 POI 压成一行:名字、区、评分、地址。经纬度和图片不进这里。 */
function poiLine(poi: AmapPoi, index: number): string {
	const rating = poi.rating ? ` ★${poi.rating}` : "";
	const level = poi.level ? ` ${poi.level}` : "";
	const address = poi.address ? ` — ${poi.address}` : "";
	return `${index + 1}. ${poi.name}(${poi.district})${rating}${level}${address}`;
}

export const searchPoi: Tool<typeof parameters> = {
	name: "search_poi",
	description: "在指定城市按关键词搜索地点,返回名称、所在区、评分和地址。找景点、餐厅、商圈、具体地标都用它。",
	parameters,

	/**
	 * @throws limit 越界或高德返回错误时抛。搜不到结果**不算错误** ——
	 *         返回一句「没找到」让模型换个关键词,比抛异常更有用。
	 */
	async execute(_toolCallId, params, signal): Promise<ToolResult> {
		const limit = params.limit ?? 10;
		if (limit < 1 || limit > 25) {
			throw new Error(`limit 只支持 1-25,收到 ${limit}`);
		}
		const pois = await amapSearchPoi({ city: params.city, keyword: params.keyword, limit }, signal);
		if (pois.length === 0) {
			return {
				content: [{ type: "text", text: `在${params.city}没搜到「${params.keyword}」,换个关键词试试` }],
				details: { city: params.city, keyword: params.keyword, pois: [] },
			};
		}
		const { text } = truncateLines(pois.map(poiLine).join("\n"), CONTENT_LIMIT);
		return {
			content: [{ type: "text", text: `${params.city}「${params.keyword}」搜到 ${pois.length} 条:\n${text}` }],
			details: { city: params.city, keyword: params.keyword, pois },
		};
	},
};
