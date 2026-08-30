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
import { fetchStaticMap, searchPoi } from "./amap.ts";

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
export function slugify(title: string): string {
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

/** 最多替模型查几个点。和 `fetchStaticMap` 的 `MAX_MARKERS` 对齐 —— 多查的也画不上去。 */
const MAX_LOOKUPS = 10;

/** 行程条目名里那些不影响「指的是哪个地方」的词。**白名单,不是通配** —— 见 `cleanName`。 */
const LEADING = ["前往", "参观", "游览", "品尝", "体验", "打卡", "漫步", "逛", "游"];
const TRAILING = ["夜景", "风光", "风景", "景色", "漫步", "一日游", "半日游"];

/**
 * 把名字洗成「指的是哪个地方」。
 *
 * 三步:去掉括号里的补充、去掉开头的动词、去掉结尾的修饰。**不去城市名** ——
 * 去了之后「品尝桂林米粉」会洗成「米粉」,于是任何一家米粉店都能匹配上,
 * 实测就把它钉到了一家模型从没提过的店上。包含关系本来就容得下城市前缀
 * (「桂林市两江四湖景区」包含「两江四湖」),多剥这一层只会放进通名。
 * 行程条目是**给人读的短语**(「两江四湖夜景」「前往阳朔」),POI 名是**注册名**
 * (「桂林市两江四湖景区」),两边都得洗一遍才比得上。
 *
 * 用白名单而不是「去掉所有动词」:名单看得见、错了能改,而「所有动词」得靠分词,
 * 分错一次就把地名本身削掉了(「游龙河」)。
 */
function cleanName(name: string): string {
	let text = name.replace(/[（(][^)）]*[)）]/gu, "").replace(/\s+/gu, "");
	for (const word of LEADING) if (text.startsWith(word)) text = text.slice(word.length);
	for (const word of TRAILING) if (text.endsWith(word)) text = text.slice(0, -word.length);
	return text;
}

/**
 * 两个名字算不算同一个地方。
 *
 * 洗完之后比包含关系。**宁可漏,不可错**:「品尝桂林米粉」洗成「桂林米粉」,
 * 高德给的是「仁利米粉(施家园店)」洗成「仁利米粉」—— 谁也不包含谁,**不插这个点**。
 * 那家店是搜索随便挑的,模型没选过它;把「吃米粉」钉在一家没人提过的店上,
 * 就是又一次「编」,只不过这回是我们编的。
 */
function nameMatches(itemName: string, poiName: string): boolean {
	const item = cleanName(itemName);
	const poi = cleanName(poiName);
	if (item.length < 2 || poi.length < 2) return false;
	return poi.includes(item) || item.includes(poi);
}

/**
 * 给没有坐标的条目补上坐标。**由本文件去查,不问模型。**
 *
 * 为什么不能让模型填:它**根本看不到经纬度** —— `search_poi` 的 content 里只有
 * 名字、区、评分、地址(`tools/search-poi.ts:26` 那行注释写着「经纬度不进这里」)。
 * 于是「抄 search_poi 返回的坐标」这条指令无法执行,模型只能凭记忆编。
 * 实测它说成都宽窄巷子在 `104.0576,30.6698`,高德真值 `104.053307,30.663869`,
 * **差 750 米** —— 而这还是全国最有名的地标之一。图钉插错比没有图钉糟得多。
 *
 * 更一般的一条:**坐标是数据,不是决定,不该经过模型的手。**
 * 能让工具自己查的就别让模型转述 —— 转述必然有损。
 *
 * @throws 只在取消时抛。单个查询失败就跳过那一项 —— 少一个图钉不该让整次保存失败。
 */
async function resolveLocations(plan: TripPlan, signal?: AbortSignal): Promise<number> {
	const pending = plan.itinerary
		.flatMap((day) => day.items)
		.filter((item) => !item.location)
		.slice(0, MAX_LOOKUPS);
	if (pending.length === 0) return 0;
	const results = await Promise.all(
		pending.map(async (item) => {
			try {
				// 用洗过的名字去搜:「前往阳朔」搜不到,「阳朔」搜得到。
				const keyword = cleanName(item.name) || item.name;
				const [poi] = await searchPoi({ city: plan.city, keyword, limit: 1 }, signal);
				if (!poi?.location || !nameMatches(item.name, poi.name)) return 0;
				item.location = poi.location;
				return 1;
			} catch (error) {
				if (signal?.aborted) throw error;
				return 0;
			}
		}),
	);
	return results.reduce<number>((sum, one) => sum + one, 0);
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
			"地图不用你操心:location 留空即可,报告会自己按名字去查坐标。",
		parameters: tripPlanSchema,

		/**
		 * @throws 写盘失败、或文件名编不出来时抛。地图取不到**不抛**,只在返回文本里说明。
		 */
		async execute(_toolCallId, plan, signal): Promise<ToolResult> {
			let mapDataUri: string | undefined;
			let mapNote = "";
			try {
				// 先把缺的坐标查回来,再画图。顺序不能反 —— 反了就永远只画模型给的那些。
				await resolveLocations(plan, signal);
				mapDataUri = await fetchMapDataUri(plan, signal);
				mapNote = mapDataUri ? `;地图上 ${mapPoints(plan).length} 个点` : ";没能给任何一项定位,报告里没有地图";
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
