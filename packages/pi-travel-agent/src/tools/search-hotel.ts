/**
 * search_hotel 工具:在某城(可限定到区/商圈)搜住宿。
 * 数据来自高德 `/v3/place/text`,和 search_poi 同一个接口、不同的默认关键词。
 *
 * 层:tools(旅行域)。
 * 边界:**不提供价格筛选**。高德 Web 服务的 POI 搜索没有价格字段,
 *       给个 `priceLevel` 参数等于在 schema 里对模型撒谎 ——
 *       它会照着传,然后拿到一批和价格无关的结果,还以为筛过了。
 */

import { Type } from "typebox";
import type { Tool, ToolResult } from "../core/types.ts";
import { type AmapPoi, searchPoi } from "./amap.ts";
import { truncateLines } from "./truncate.ts";

const CONTENT_LIMIT = { maxLines: 10, maxBytes: 1000 };

const parameters = Type.Object({
	city: Type.String({ description: "城市名,如「成都」。不要带「市」字" }),
	area: Type.Optional(Type.String({ description: "区或商圈,如「武侯区」「春熙路」。会拼进搜索词,用来缩小范围" })),
	keyword: Type.Optional(Type.String({ description: "住宿类型,如「酒店」「民宿」「青年旅舍」。默认「酒店」" })),
	limit: Type.Optional(Type.Integer({ description: "最多返回几条,1-25,默认 8" })),
});

/** 一条住宿压成一行。评分对选酒店最有用,放在名字后面。 */
function hotelLine(poi: AmapPoi, index: number): string {
	const rating = poi.rating ? ` ★${poi.rating}` : "";
	const address = poi.address ? ` — ${poi.address}` : "";
	return `${index + 1}. ${poi.name}(${poi.district})${rating}${address}`;
}

export const searchHotel: Tool<typeof parameters> = {
	name: "search_hotel",
	description:
		"在指定城市搜索住宿,返回名称、所在区、评分和地址。可以用 area 限定到某个区或商圈,让住处离行程更近。" +
		"注意:数据源没有价格,拿不到房价,不要凭结果编价格。",
	parameters,

	/** @throws limit 越界或高德返回错误时抛。搜不到不算错误。 */
	async execute(_toolCallId, params, signal): Promise<ToolResult> {
		const limit = params.limit ?? 8;
		if (limit < 1 || limit > 25) {
			throw new Error(`limit 只支持 1-25,收到 ${limit}`);
		}
		const keyword = [params.area, params.keyword ?? "酒店"].filter(Boolean).join(" ");
		const pois = await searchPoi({ city: params.city, keyword, limit }, signal);
		if (pois.length === 0) {
			return {
				content: [{ type: "text", text: `在${params.city}没搜到「${keyword}」,换个区或换个说法试试` }],
				details: { city: params.city, keyword, pois: [] },
			};
		}
		const { text } = truncateLines(pois.map(hotelLine).join("\n"), CONTENT_LIMIT);
		return {
			content: [{ type: "text", text: `${params.city}「${keyword}」搜到 ${pois.length} 条:\n${text}` }],
			details: { city: params.city, keyword, pois },
		};
	},
};
