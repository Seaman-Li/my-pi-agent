/**
 * 高德 Web 服务 REST 客户端。**不是 tool** —— 纯 HTTP,不认识 Tool 接口。
 *
 * 层:tools(旅行域)。工具文件调它,它不调工具文件。
 * 边界:**key 只在本文件里出现,而且永不进任何字符串输出。**
 *       高德把 key 放在 query string 里,所以完整 URL 本身就是凭据 ——
 *       出错只报 path + info + infocode,绝不报 url。
 */

const BASE = "https://restapi.amap.com";

/** 一天的预报。字段名照抄高德,免得在两套命名之间来回翻译。 */
export interface AmapForecastDay {
	date: string;
	week: string;
	dayweather: string;
	nightweather: string;
	daytemp: string;
	nighttemp: string;
	daywind: string;
	daypower: string;
}

export interface AmapForecast {
	city: string;
	adcode: string;
	province: string;
	reporttime: string;
	casts: AmapForecastDay[];
}

/**
 * 我们要的那部分 POI 字段。
 *
 * 高德原始响应有三十多个字段,一多半是空数组占位(`"distance": []`)。
 * details 虽然不进上下文、不花 token,但它要进 HTML 报告、将来还要进 session 文件,
 * 留着纯噪声。所以这里挑干净的一份,而不是原样透传。
 */
export interface AmapPoi {
	id: string;
	name: string;
	address: string;
	/** 高德返回的城市名,如「成都市」。用来识破下面那个静默降级,别删。 */
	city: string;
	district: string;
	/** "经度,纬度",静态地图和距离计算都要它。 */
	location: string;
	type: string;
	tel?: string;
	rating?: string;
	level?: string;
	openTime?: string;
	photos: string[];
}

/** 高德把业务错误编码在 HTTP 200 里,所以每个响应都长这样。 */
interface AmapEnvelope {
	status: string;
	info: string;
	infocode: string;
}

/**
 * 读 key。
 *
 * @throws 没配 `AMAP_KEY` 时抛。错误信息里说的是「怎么配」,不是 key 长什么样。
 */
function apiKey(): string {
	const key = process.env.AMAP_KEY;
	if (!key) throw new Error("缺少环境变量 AMAP_KEY(高德 Web 服务 key,写在 .env 里)");
	return key;
}

/**
 * 拼出带 key 的完整 URL。
 *
 * **返回值就是凭据** —— 高德把 key 放在 query string 里。所以这个函数的结果
 * 只许交给 `fetch`,不许进日志、不许进错误消息、不许进 HTML 报告。
 * 抽成一个函数是为了让「拼 key」在整个项目里只有这一处,好审。
 *
 * @throws 没配 `AMAP_KEY` 时由 `apiKey()` 抛。
 */
function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
	const query = new URLSearchParams({ key: apiKey() });
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined) query.set(name, String(value));
	}
	return `${BASE}${path}?${query}`;
}

/**
 * 退避重试的等待间隔,毫秒。长度 = 最多重试几次。
 *
 * 两次就够:并发超限是**瞬时**的,错峰几百毫秒就过去了。再多是在赌配额,不是在等窗口。
 */
const RETRY_DELAYS = [350, 900];

/** 睡一会儿,能被 abort 打断。@throws 等待期间被取消时抛。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("已取消"));
		};
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 这次失败值不值得再试一次。
 *
 * **只认并发超限(QPS),不认日配额用完(`DAILY_QUERY_OVER_LIMIT`)。** 两者都是 "LIMIT",
 * 但一个等几百毫秒就好,另一个等到明天也是白等 —— 对后者重试纯粹是把一次失败拖成三次。
 * 所以匹配 `info` 里的 "QPS" 而不是 "LIMIT"。
 */
function isRateLimited(info: string): boolean {
	return info.toUpperCase().includes("QPS");
}

/**
 * 发一次高德请求,并发超限时退避重试。
 *
 * **为什么必须重试**:system prompt 要求「互相独立的查询一次性发出」,loop 的执行阶段
 * 又是并行的,于是一批 6 个 `search_poi` 会同时打到高德 —— 个人 key 的并发额度就那么点,
 * 实测稳定有一两个吃到 `CUQPS_HAS_EXCEEDED_THE_LIMIT(10021)`。
 * 那一路的结果就整条没了,模型只能拿剩下的凑,而看输出的人根本看不出少了什么。
 * 「并行发」和「不重试」这两条同时成立就是个 bug,而并行不该退。
 *
 * @throws HTTP 层失败、重试完仍然超限、或高德返回其它 `status !== "1"` 时抛。
 *         **抛出的消息里只有 path 和高德的 info/infocode,没有 URL** ——
 *         URL 带 key,而错误消息会被 loop 包成 toolResult 回灌给模型、再进 session 文件。
 */
async function request<T>(
	path: string,
	params: Record<string, string | number | undefined>,
	signal?: AbortSignal,
): Promise<T> {
	const url = buildUrl(path, params);
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(url, { signal });
		if (!response.ok) {
			throw new Error(`高德 ${path} 请求失败:HTTP ${response.status}`);
		}
		const body = (await response.json()) as AmapEnvelope & T;
		if (body.status === "1") return body;
		if (isRateLimited(body.info) && attempt < RETRY_DELAYS.length) {
			await sleep(RETRY_DELAYS[attempt] as number, signal);
			continue;
		}
		throw new Error(`高德 ${path} 返回错误:${body.info}(${body.infocode})`);
	}
}

/**
 * 查天气预报。`extensions=all` 才有多天预报,默认只给实况。
 *
 * @throws 城市查不到时高德返回空 forecasts,这里当错误抛 —— 让模型知道城市名不对,
 *         它往往能自己改(「成都市」→「成都」)。
 */
export async function fetchForecast(city: string, signal?: AbortSignal): Promise<AmapForecast> {
	const body = await request<{ forecasts?: AmapForecast[] }>(
		"/v3/weather/weatherInfo",
		{ city, extensions: "all" },
		signal,
	);
	const forecast = body.forecasts?.[0];
	if (!forecast) throw new Error(`查不到城市「${city}」的天气,换个写法试试(比如去掉「市」字)`);
	return forecast;
}

/**
 * 去掉行政区划后缀,好把「成都」和「成都市」看成一个。
 *
 * 只脱最外面一层:「黑龙江省」→「黑龙江」,不动「自治州」这类中间成分 ——
 * 宁可少归一化(多留几条结果)也不要过度归一化(把对的滤掉)。
 */
function normalizeCity(name: string): string {
	return name.trim().replace(/[市省]$/u, "");
}

/**
 * 滤掉不属于目标城市的 POI。
 *
 * **这是在防高德的一个静默降级**:`city` 参数它解析不了时(外国城市、拼音、乱码),
 * `citylimit=true` 会被**悄悄忽略**,接口照样返回 `status:"1"`,给一批按全国热度排的结果。
 * 实测 `city="Kuala Lumpur"` 返回 count=1000,前三条是军事博物馆、故宫、天安门。
 *
 * 静默的错数据比报错危险得多:模型会拿故宫去规划吉隆坡行程,而看输出的人会以为是幻觉。
 * 每条 POI 自带的 `cityname` 是唯一能识破这件事的证据,所以 `AmapPoi` 必须留着它。
 *
 * `cityname` 缺失的条目一律**保留** —— 判不了就别judge,过度过滤会把对的结果扔掉。
 */
function keepSameCity(pois: AmapPoi[], city: string): AmapPoi[] {
	const wanted = normalizeCity(city);
	if (!wanted) return pois;
	return pois.filter((poi) => {
		if (!poi.city) return true;
		const got = normalizeCity(poi.city);
		return got.includes(wanted) || wanted.includes(got);
	});
}

/** 高德原始 POI 里可能是空数组占位的字段,取出来当字符串用。 */
function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 关键词搜 POI。`citylimit=true` 把结果锁在这个城市里 ——
 * 不加的话搜「古镇」会把全国的古镇都返回来。
 */
export async function searchPoi(
	options: { city: string; keyword: string; limit: number },
	signal?: AbortSignal,
): Promise<AmapPoi[]> {
	const body = await request<{ pois?: Record<string, unknown>[] }>(
		"/v3/place/text",
		{ keywords: options.keyword, city: options.city, citylimit: "true", offset: options.limit, page: 1 },
		signal,
	);
	const pois = (body.pois ?? []).map((poi) => {
		const ext = (poi.biz_ext ?? {}) as Record<string, unknown>;
		const photos = Array.isArray(poi.photos) ? (poi.photos as Record<string, unknown>[]) : [];
		return {
			id: String(poi.id ?? ""),
			name: String(poi.name ?? ""),
			address: optionalText(poi.address) ?? "",
			city: optionalText(poi.cityname) ?? "",
			district: optionalText(poi.adname) ?? "",
			location: String(poi.location ?? ""),
			type: String(poi.type ?? ""),
			tel: optionalText(poi.tel),
			rating: optionalText(ext.rating),
			level: optionalText(ext.level),
			openTime: optionalText(ext.opentime2),
			photos: photos.map((photo) => optionalText(photo.url)).filter((url): url is string => Boolean(url)),
		};
	});
	return keepSameCity(pois, options.city);
}

/** 静态地图上的一个点。`label` 是画在图钉里的那个字符。 */
export interface MapMarker {
	/** "经度,纬度",原样用 POI 的 `location`。 */
	location: string;
	/** 单个字符,高德只认 `0-9`、`A-Z` 和单个汉字。 */
	label: string;
}

/** 一张图最多几个点。高德把参数放 query string 里,点太多会把 URL 撑爆。 */
const MAX_MARKERS = 10;

/**
 * 取一张静态地图,返回 PNG 字节。
 *
 * 每个点单独成一个 marker 分组(`样式:坐标`,分组之间用 `|`)——
 * 一个分组只能有一个 label,想让每个点显示不同的序号就只能这么拼。
 *
 * @throws 一个点都没有、HTTP 失败、或者高德返回的不是图片时抛。
 *         **最后一条是必查的**:高德的业务错误是「HTTP 200 + 一段 JSON」,
 *         不看 content-type 就会把一段错误 JSON 当成 PNG 存进报告里。
 */
export async function fetchStaticMap(markers: MapMarker[], signal?: AbortSignal): Promise<Buffer> {
	if (markers.length === 0) throw new Error("静态地图至少要一个点");
	const spec = markers
		.slice(0, MAX_MARKERS)
		.map((marker) => `mid,0x2563EB,${marker.label}:${marker.location}`)
		.join("|");
	const response = await fetch(buildUrl("/v3/staticmap", { markers: spec, size: "750*500" }), { signal });
	if (!response.ok) throw new Error(`高德静态地图请求失败:HTTP ${response.status}`);
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.startsWith("image/")) {
		throw new Error(`高德静态地图没返回图片(content-type: ${contentType})`);
	}
	return Buffer.from(await response.arrayBuffer());
}
