/**
 * `save_plan` 工具:把排好的行程存成一份自包含 HTML 报告。**唯一会写磁盘的工具。**
 *
 * 层:tools(旅行域)。它是这一层唯一「组合」性质的文件 —— trip-plan(形状)
 *     + report(渲染)+ amap(地图)三块拼起来,所以它认识 report.ts,反过来不成立。
 * 边界:**文件名不由模型决定。** 模型给的是 `title`,落到磁盘的名字由本文件算,
 *       算完再断言一次仍在 outDir 内 —— 路径穿越在这里没有入口,不是被挡住了。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { Tool, ToolResult } from "../core/types.ts";
import { mapPoints, renderReport } from "../report.ts";
import { type TripPlan, tripPlanSchema } from "../trip-plan.ts";
import { fetchStaticMap } from "./amap.ts";

/** 文件名最多留几个字符。太长的名字在 Finder 和终端里都难认。 */
const MAX_SLUG = 40;

/** 同名时最多往后编到几号。撞到这个数说明有人在刷,不是正常使用。 */
const MAX_SUFFIX = 99;

export interface SavePlanOptions {
	/** 报告落在哪个目录。由入口给绝对路径 —— 工具不从 `import.meta.url` 自己推,那会跟着文件移动。 */
	outDir: string;
}

/**
 * 把标题压成一个安全的文件名主干。
 *
 * **白名单,不是黑名单**:只留字母、数字、下划线和连字符(`\p{L}` 含汉字),
 * 别的一概删掉。所以 `.` `/` `\` 根本活不到下一行 —— `../../.ssh/config` 变成 `sshconfig`。
 * 写成「过滤掉 `..`」那种黑名单是另一回事:总有下一个没想到的写法(`....//`、URL 编码、
 * NUL 截断),而白名单不需要想全。
 */
function slugify(title: string): string {
	const kept = title
		.normalize("NFKC")
		.replace(/\s+/gu, "-")
		.replace(/[^\p{L}\p{N}_-]/gu, "");
	return kept.slice(0, MAX_SLUG) || "行程";
}

/**
 * 挑一个还没被占用的文件名。
 *
 * **不覆盖同名文件**:同一个人对同一座城市连问两次是常态,第二份报告悄悄盖掉第一份
 * 就没法比较了。宁可留一堆 `成都2日游-2.html`。
 *
 * @throws 编到 `MAX_SUFFIX` 还占着时抛;算出来的路径跑到 `outDir` 外面时也抛
 *         —— 后者在 `slugify` 之后本该不可能,留着是因为「不可能」是推理出来的,
 *         而这一行是检查出来的,成本一行。
 */
function pickPath(outDir: string, slug: string): string {
	const root = resolve(outDir);
	for (let index = 1; index <= MAX_SUFFIX; index++) {
		const name = index === 1 ? `${slug}.html` : `${slug}-${index}.html`;
		const target = resolve(root, name);
		if (!target.startsWith(root + sep)) throw new Error("生成的文件名越出了报告目录");
		if (!existsSync(target)) return target;
	}
	throw new Error(`「${slug}」已经有 ${MAX_SUFFIX} 份报告了,换个标题`);
}

/** 本地时间 `YYYY-MM-DD HH:mm`。报告页脚要它,`toISOString()` 是 UTC,差八小时。 */
function localTimestamp(now: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	return `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * 取一张内嵌用的静态地图。
 *
 * 返回 `data:` URI 而不是 URL:高德静态地图的地址里带着 key,存成 `<img src="http://…">`
 * 就等于把凭据写进一个用户会随手转发的文件。取回来变成 base64,报告里就没有外链了。
 *
 * @throws 只在**取消**时抛。其余失败返回 undefined —— 没有地图的报告仍然有用,
 *         为一张配图让整次保存失败不划算。但失败必须**说出来**(见 execute 里的 mapNote),
 *         静默少一块内容正是 Step 3 踩过的那种坑。
 */
async function fetchMapDataUri(plan: TripPlan, signal?: AbortSignal): Promise<string | undefined> {
	const points = mapPoints(plan);
	if (points.length === 0) return undefined;
	const markers = points.map((point) => ({ location: point.item.location as string, label: point.label }));
	const png = await fetchStaticMap(markers, signal);
	return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * 造一个绑定了输出目录的 `save_plan`。
 *
 * 和 `ask_user` 一样写成工厂:目录属于宿主,不属于工具。
 */
export function createSavePlan(options: SavePlanOptions): Tool<typeof tripPlanSchema> {
	return {
		name: "save_plan",
		description:
			"把最终排好的行程存成一份可以双击打开的 HTML 报告,返回文件路径。" +
			"行程已经排完、该问的都问过之后调用一次。" +
			"每一项尽量带上 location(直接抄 search_poi 返回的那串经纬度),有它才能画出路线图。",
		parameters: tripPlanSchema,

		/**
		 * @throws 写盘失败、或文件名编不出来时抛。地图取不到**不抛**,只在返回文本里说明。
		 */
		async execute(_toolCallId, plan, signal): Promise<ToolResult> {
			let mapDataUri: string | undefined;
			let mapNote = "";
			try {
				mapDataUri = await fetchMapDataUri(plan, signal);
				if (!mapDataUri) mapNote = ";没有一项带 location,报告里没有地图";
			} catch (error) {
				// 取消要原样往上抛:那是「别做了」,不是「这块没做成」。
				if (signal?.aborted) throw error;
				mapNote = `;地图没生成(${error instanceof Error ? error.message : String(error)})`;
			}

			const html = renderReport(plan, { mapDataUri, generatedAt: localTimestamp(new Date()) });
			mkdirSync(options.outDir, { recursive: true });
			const target = pickPath(options.outDir, slugify(plan.title));
			writeFileSync(target, html, "utf8");

			const items = plan.itinerary.reduce((sum, day) => sum + day.items.length, 0);
			const total = plan.budget ? `,合计 ${plan.budget.total} 元` : "";
			const shown = `${basename(options.outDir)}/${basename(target)}`;
			return {
				content: [
					{
						type: "text",
						text: `报告已保存到 ${shown}:${plan.itinerary.length} 天、${items} 项安排${total}${mapNote}`,
					},
				],
				details: { path: target, file: basename(target), bytes: Buffer.byteLength(html), plan },
			};
		},
	};
}
