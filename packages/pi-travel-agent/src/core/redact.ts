/**
 * 脱敏:把已知的密钥值从一段文本里抹掉。**兜底,不是主力。**
 *
 * 层:core —— 只认识「字符串」和「一组要抹掉的值」,不认识 key 是从哪来的。
 * 边界:主力仍然是「**别让密钥进到会被打印的东西里**」——
 *       key 只在 `tools/amap.ts` 和 `core/model.ts` 出现,`buildUrl` 拼完就交给 fetch。
 *       这里做的是第二道:万一哪天有人往错误消息里塞了 URL,不至于当场泄出去。
 *       **一道兜底不能用来放松第一道。**
 */

/** 抹掉之后留下的东西。留个可见标记而不是删空 —— 人看到它才知道「这里本来有个密钥」。 */
const MASK = "[已脱敏]";

/**
 * 太短的值不参与替换。
 *
 * 防的是误伤:某个「密钥」如果只有几个字符(比如本地 Ollama 那个随便填的占位值 `x`),
 * 拿它做全局替换会把正常文本里的每个 `x` 都挖掉,而那种损坏很难查
 * —— 症状是模型收到一段莫名其妙的乱码,不是报错。
 * 真密钥都远长于这个数,所以这条限制不会漏掉真的。
 */
const MIN_SECRET_LENGTH = 8;

/**
 * 造一个脱敏函数。
 *
 * 长的先替换:两个密钥互为前缀时(比如同一个 key 带不带前缀两种写法),
 * 先换短的会把长的切成两半,剩下的尾巴照样泄出去。
 *
 * @param secrets 要抹掉的值。空串、太短的、重复的都会被丢掉。
 * @returns 一个纯函数。**没有可抹的东西时返回恒等函数** —— 省掉每条结果上的无谓扫描。
 */
export function createRedactor(secrets: string[]): (text: string) => string {
	const values = [...new Set(secrets.filter((value) => value.length >= MIN_SECRET_LENGTH))].sort(
		(a, b) => b.length - a.length,
	);
	if (values.length === 0) return (text) => text;
	return (text: string): string => {
		let output = text;
		for (const value of values) output = output.split(value).join(MASK);
		return output;
	};
}
