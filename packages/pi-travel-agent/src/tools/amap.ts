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
 * 发一次高德请求。
 *
 * @throws HTTP 层失败、或高德返回 `status !== "1"` 时抛。
 *         **抛出的消息里只有 path 和高德的 info/infocode,没有 URL** ——
 *         URL 带 key,而错误消息会被 loop 包成 toolResult 回灌给模型、再进 session 文件。
 */
async function request<T>(
	path: string,
	params: Record<string, string | number | undefined>,
	signal?: AbortSignal,
): Promise<T> {
	const query = new URLSearchParams({ key: apiKey() });
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined) query.set(name, String(value));
	}
	const response = await fetch(`${BASE}${path}?${query}`, { signal });
	if (!response.ok) {
		throw new Error(`高德 ${path} 请求失败:HTTP ${response.status}`);
	}
	const body = (await response.json()) as AmapEnvelope & T;
	if (body.status !== "1") {
		throw new Error(`高德 ${path} 返回错误:${body.info}(${body.infocode})`);
	}
	return body;
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
