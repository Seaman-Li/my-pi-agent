/**
 * `TripPlan` → 一个自包含的 HTML 文件。纯函数:不联网、不读写磁盘、不认识高德。
 *
 * 层:旅行域,和 tools/ 平级。只 import trip-plan.ts。
 * 边界:**本文件里每一处模板插值,要么是 `esc(…)`,要么是名字以 `Html` 结尾的变量。**
 *       行程文字全部由模型生成,原样插进 HTML 就是双击即执行的 XSS ——
 *       这条规则是这个文件存在的主要理由,而且它可以被 grep 检查(见 README 自查表)。
 */

import type { TripBudget, TripDay, TripHotel, TripItem, TripPlan } from "./trip-plan.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * 转义成 HTML 文本。
 *
 * 五个字符一个都不能少:`<>` 挡标签,`&` 挡二次解码,`"'` 挡属性逃逸 ——
 * 现在的模板里所有插值都在文本节点上,但少转义引号这种事,只在有人往属性里塞了个变量的
 * 那天才会暴露,那时已经晚了。
 *
 * 名字取三个字母是故意的:插值处密集,`esc(` 短到不会有人嫌麻烦而跳过它。
 */
function esc(value: unknown): string {
	return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

/** 金额统一成「1,200 元」。整数不留小数位,小数保留一位。 */
function money(amount: number): string {
	const rounded = Number.isInteger(amount) ? amount : Math.round(amount * 10) / 10;
	return `${rounded.toLocaleString("zh-CN")} 元`;
}

const styleHtml = `
:root { color-scheme: light }
* { box-sizing: border-box }
body { margin: 0; padding: 2rem 1rem; background: #f6f7f9; color: #1c1e21;
  font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif }
main { max-width: 760px; margin: 0 auto }
h1 { font-size: 1.6rem; margin: 0 0 .4rem }
h2 { font-size: 1.05rem; margin: 0 0 .8rem; color: #4a5568 }
h3 { font-size: 1rem; margin: 0 0 .6rem }
.meta { color: #6b7280; font-size: .87rem; margin-bottom: 1.6rem }
.meta span + span::before { content: " · " }
section { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
  padding: 1.1rem 1.3rem; margin-bottom: 1rem }
.day { border-left: 3px solid #2563eb; padding-left: .9rem; margin-bottom: 1.4rem }
.day:last-child { margin-bottom: 0 }
.day > .theme { color: #6b7280; font-size: .87rem; margin: -.4rem 0 .6rem }
.item { display: grid; grid-template-columns: 4.5rem 1fr; gap: .2rem .8rem; padding: .5rem 0;
  border-top: 1px dashed #e5e7eb }
.item .time { color: #2563eb; font-variant-numeric: tabular-nums }
.item .detail { color: #4b5563; font-size: .9rem }
.item .src { color: #9ca3af; font-size: .8rem }
.item .cost { color: #b45309; font-size: .87rem }
.item .pin { display: inline-block; min-width: 1.25rem; text-align: center; border-radius: 999px;
  background: #2563eb; color: #fff; font-size: .78rem; line-height: 1.25rem }
table { width: 100%; border-collapse: collapse; font-size: .92rem }
th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid #eef0f3 }
th { color: #6b7280; font-weight: 500 }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums }
tr.total td { font-weight: 600; border-bottom: none }
ul { margin: 0; padding-left: 1.2rem }
li { margin: .25rem 0 }
.note { background: #fffbeb; border-color: #fde68a }
img.map { width: 100%; border-radius: 8px; display: block }
footer { color: #9ca3af; font-size: .82rem; text-align: center; margin: 1.6rem 0 0 }
@media print { body { background: #fff } section { break-inside: avoid } }
`;

/** 一个区块。`bodyHtml` 已经是拼好的 HTML,不再转义。 */
function sectionHtml(title: string, bodyHtml: string, className = ""): string {
	const attrHtml = className ? ` class="${esc(className)}"` : "";
	return `<section${attrHtml}><h2>${esc(title)}</h2>${bodyHtml}</section>`;
}

/** 一串字符串渲染成无序列表;空数组渲染成空串,让调用方能直接判断要不要出这个区块。 */
function listHtml(lines: string[] | undefined): string {
	if (!lines?.length) return "";
	return `<ul>${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
}

/** 地图上的一个点,以及它在行程里对应的那一项。 */
export interface MapPoint {
	item: TripItem;
	/** 图钉里显示的字符,同时也印在行程条目前面。 */
	label: string;
}

/** 图钉标号。高德一个图钉只放得下一个字符,所以 9 个之后接字母。 */
const MAP_LABELS = "123456789A";

/**
 * 挑出能画到地图上的条目并编号。
 *
 * 放在 report.ts 而不是各算各的:编号必须**同时**出现在图钉里和行程条目前面,
 * 两边各写一份迟早会错开一位,那种错误看图的人根本发现不了。
 * 所以这里是唯一的编号来源,`save_plan` 拿它去要图,`renderReport` 拿它去标行程。
 */
export function mapPoints(plan: TripPlan): MapPoint[] {
	const located = plan.itinerary.flatMap((day) => day.items).filter((item) => Boolean(item.location));
	return located.slice(0, MAP_LABELS.length).map((item, index) => ({ item, label: MAP_LABELS[index] as string }));
}

/** 行程里的一件事。可选字段一律「没有就不出现」,而不是留个空位或者写「未知」。 */
function itemHtml(item: TripItem, label: string | undefined): string {
	const whereHtml = item.district ? `<span class="src">${esc(item.district)}</span>` : "";
	const detailHtml = item.detail ? `<div class="detail">${esc(item.detail)}</div>` : "";
	const costHtml = item.cost === undefined ? "" : `<div class="cost">约 ${esc(money(item.cost))}</div>`;
	const sourceHtml = item.source ? `<div class="src">来源:${esc(item.source)}</div>` : "";
	const pinHtml = label ? `<span class="pin">${esc(label)}</span> ` : "";
	return `<div class="item"><div class="time">${esc(item.time)}</div><div>
${pinHtml}<strong>${esc(item.name)}</strong> ${whereHtml}${detailHtml}${costHtml}${sourceHtml}</div></div>`;
}

/** 一天一张卡片。`labels` 是「这一项在地图上是几号」,没上图的项拿不到。 */
function dayHtml(day: TripDay, labels: Map<TripItem, string>): string {
	const dateHtml = day.date ? ` · ${esc(day.date)}` : "";
	const themeHtml = day.theme ? `<p class="theme">${esc(day.theme)}</p>` : "";
	const itemsHtml = day.items.map((item) => itemHtml(item, labels.get(item))).join("");
	return `<div class="day"><h3>第 ${esc(day.day)} 天${dateHtml}</h3>${themeHtml}${itemsHtml}</div>`;
}

/** 住宿表。 */
function hotelsHtml(hotels: TripHotel[]): string {
	const rowsHtml = hotels
		.map((hotel) => {
			const place = [hotel.district, hotel.address].filter(Boolean).join(" ");
			return `<tr><td>${esc(hotel.name)}</td><td>${esc(place)}</td><td>${esc(hotel.rating ?? "")}</td>
<td>${esc(hotel.reason ?? "")}</td></tr>`;
		})
		.join("");
	return `<table><tr><th>名称</th><th>位置</th><th>评分</th><th>推荐理由</th></tr>${rowsHtml}</table>`;
}

/** 预算表。有上限时多出一行结余/超支 —— 那一行才是用户真正想看的。 */
function budgetHtml(budget: TripBudget): string {
	const rowsHtml = budget.byCategory
		.map((line) => `<tr><td>${esc(line.category)}</td><td class="num">${esc(money(line.amount))}</td></tr>`)
		.join("");
	const totalHtml = `<tr class="total"><td>合计</td><td class="num">${esc(money(budget.total))}</td></tr>`;
	let limitHtml = "";
	if (budget.limit !== undefined) {
		const diff = budget.limit - budget.total;
		const labelHtml = diff >= 0 ? `结余 ${esc(money(diff))}` : `超支 ${esc(money(-diff))}`;
		limitHtml = `<tr class="total"><td>预算 ${esc(money(budget.limit))}</td><td class="num">${labelHtml}</td></tr>`;
	}
	return `<table><tr><th>类目</th><th class="num">金额</th></tr>${rowsHtml}${totalHtml}${limitHtml}</table>`;
}

export interface ReportOptions {
	/** 静态地图,已经是 `data:image/png;base64,…`。**不接受 http 链接** —— 见下面的注释。 */
	mapDataUri?: string;
	/** 生成时间。由调用方给,本函数才是纯函数(同样的输入永远得到同样的 HTML,可以直接比对)。 */
	generatedAt: string;
}

/**
 * 把一份行程渲染成一个能双击打开的 HTML 文件。
 *
 * 三件和安全有关的事,都在这个函数里定死:
 * 1. **没有一行 JavaScript。** 报告是静态文档,不需要脚本;没有脚本,注入的门就少一半。
 * 2. **CSP 兜底**:`default-src 'none'` + `img-src data:`,即使转义漏了一处,
 *    这个文件也发不出任何外部请求。它是第二道,不是第一道 —— 第一道永远是 `esc()`。
 * 3. **地图只收 data URI**。高德静态地图的 URL 里带 key,写成 `<img src="http://…key=…">`
 *    等于把凭据存进一个用户会随手转发的文件。所以图片在上游就被取回来变成 base64,
 *    这个文件里没有任何外链。
 */
export function renderReport(plan: TripPlan, options: ReportOptions): string {
	const metaHtml = [
		`<span>${esc(plan.city)}</span>`,
		`<span>${esc(plan.itinerary.length)} 天</span>`,
		plan.startDate ? `<span>${esc(plan.startDate)} 出发</span>` : "",
		plan.travelers ? `<span>${esc(plan.travelers)} 人</span>` : "",
	].join("");

	const labels = new Map(mapPoints(plan).map((point) => [point.item, point.label]));
	const bodyHtml = [
		sectionHtml("思路", `<p>${esc(plan.summary)}</p>`),
		options.mapDataUri
			? sectionHtml("路线示意", `<img class="map" alt="行程地图" src="${esc(options.mapDataUri)}">`)
			: "",
		sectionHtml("行程", plan.itinerary.map((day) => dayHtml(day, labels)).join("")),
		plan.hotels?.length ? sectionHtml("住宿", hotelsHtml(plan.hotels)) : "",
		plan.budget ? sectionHtml("预算", budgetHtml(plan.budget)) : "",
		plan.assumptions?.length ? sectionHtml("本方案的假设", listHtml(plan.assumptions), "note") : "",
		plan.notes?.length ? sectionHtml("注意事项", listHtml(plan.notes), "note") : "",
	].join("");

	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(plan.title)}</title>
<style>${styleHtml}</style></head>
<body><main>
<h1>${esc(plan.title)}</h1>
<p class="meta">${metaHtml}</p>
${bodyHtml}
<footer>${esc(options.generatedAt)} 由 pi-travel-agent 生成 · 门票与营业时间以官方公告为准</footer>
</main></body></html>
`;
}
