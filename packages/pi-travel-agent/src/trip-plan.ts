/**
 * `TripPlan`:一次行程的结构化形状。**它同时就是 `save_plan` 的参数 schema**。
 *
 * 层:旅行域的叶子 —— 只 import typebox,不 import 本项目任何东西。
 * 边界:tools/ 和 report.ts 本来「互相不认识」,这里是唯一的破例 ——
 *       一边产生行程、一边渲染行程,共用一个形状是必须的,各写一份必然漂移。
 *       所以它被放在两者下面,而不是放进其中一边。
 *       本文件只描述形状,不含逻辑。
 */

import { type Static, Type } from "typebox";

/**
 * 行程里的一件事。
 *
 * `location` **不用填** —— 报告会自己按名字去查(见 `tools/save-plan.ts` 的 `resolveLocations`)。
 * `source` 是给 Q7 用的:报告里每条具体信息都标出处,看的人能自己核对,
 * 而「没出处的字段留空」比「编一个」在事后可查得多。
 */
const planItem = Type.Object({
	time: Type.String({ description: "什么时候,如「09:00」「上午」「傍晚」" }),
	name: Type.String({ description: "去哪/做什么,如「武侯祠博物馆」「宽窄巷子吃晚饭」" }),
	district: Type.Optional(Type.String({ description: "所在区,如「武侯区」" })),
	location: Type.Optional(
		Type.String({
			description:
				"「经度,纬度」。**不知道就留空**,报告会自己按 name 去查。" +
				"凭印象写的坐标会把图钉插到错的地方(实测差 750 米),比没有图钉糟得多",
		}),
	),
	detail: Type.Optional(Type.String({ description: "具体安排:看什么、玩多久、怎么过去" })),
	cost: Type.Optional(Type.Number({ description: "这一项大概花多少钱,人民币元。不确定就留空,别编" })),
	source: Type.Optional(
		Type.String({ description: "这条信息哪来的,如「search_poi 评分 4.7」「weather 2026-08-26」。查不到就留空" }),
	),
});

/** 一天的安排。`items` 至少一条 —— 空着的一天进不了报告,那是没规划完。 */
const planDay = Type.Object({
	day: Type.Integer({ description: "第几天,从 1 开始" }),
	date: Type.Optional(Type.String({ description: "日期,如「2026-08-27」。用户没给具体日期就留空" })),
	theme: Type.Optional(Type.String({ description: "这天的主题,如「三国历史线」" })),
	items: Type.Array(planItem, { minItems: 1, description: "这天按时间顺序的安排" }),
});

const planHotel = Type.Object({
	name: Type.String(),
	district: Type.Optional(Type.String()),
	address: Type.Optional(Type.String()),
	rating: Type.Optional(Type.String({ description: "评分,原样抄 search_hotel 的结果" })),
	reason: Type.Optional(Type.String({ description: "为什么推荐它,如「离武侯祠步行 10 分钟」" })),
});

/** 预算。数字应当来自 `estimate_budget` 的返回值,不要在这里重算一遍。 */
const planBudget = Type.Object({
	total: Type.Number({ description: "总计,元。用 estimate_budget 算出来的那个数" }),
	byCategory: Type.Array(Type.Object({ category: Type.String(), amount: Type.Number() }), {
		minItems: 1,
		description: "按类目汇总",
	}),
	limit: Type.Optional(Type.Number({ description: "用户给的预算上限,元。用户没给就留空" })),
});

/**
 * 完整的一份行程。
 *
 * **必填字段的取舍就是这个文件的全部决策。** `city` 和 `itinerary`(至少一天、
 * 每天至少一件事)是必填,意味着模型在不知道「去哪、去几天」的时候**根本调不成这个工具**——
 * schema 校验会挡下来。这比在 system prompt 里写「请先问清楚」可靠:
 * prompt 是建议,schema 是闸。
 *
 * 反过来,`budget` 和 `startDate` 是可选的:用户没给预算、没定日期也应该能出一份行程,
 * 把它们设成必填只会逼模型编数字 —— **必填字段是用来逼出追问的,不是用来逼出编造的**。
 */
export const tripPlanSchema = Type.Object({
	title: Type.String({ description: "报告标题,如「成都 2 日历史文化之旅」" }),
	city: Type.String({ description: "目的地城市" }),
	summary: Type.String({ description: "一段话概述这次行程的思路,2-4 句" }),
	startDate: Type.Optional(Type.String({ description: "出发日期,如「2026-08-27」。用户没定就留空" })),
	travelers: Type.Optional(Type.Integer({ description: "几个人" })),
	itinerary: Type.Array(planDay, { minItems: 1, description: "按天排的行程,一天一项" }),
	hotels: Type.Optional(Type.Array(planHotel, { description: "推荐的住处。没搜过就留空,不要编" })),
	budget: Type.Optional(planBudget),
	notes: Type.Optional(Type.Array(Type.String(), { description: "注意事项:天气、闭馆、交通、证件" })),
	assumptions: Type.Optional(
		Type.Array(Type.String(), {
			description: "你替用户做的假设,如「按 2 人估算」「未含往返交通」。做了假设就必须写在这里",
		}),
	),
});

export type TripPlan = Static<typeof tripPlanSchema>;
export type TripDay = Static<typeof planDay>;
export type TripItem = Static<typeof planItem>;
export type TripHotel = Static<typeof planHotel>;
export type TripBudget = Static<typeof planBudget>;
