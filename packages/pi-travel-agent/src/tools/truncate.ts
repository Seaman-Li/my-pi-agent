/**
 * 输出截断:双限制,谁先撞上谁生效,**永不返回半行**。
 *
 * 层:tools。纯函数,不认识高德也不认识 Tool 接口。
 * 边界:只截给模型看的 `content`。`details` 从不截 —— 报告要用完整数据。
 */

export interface TruncateOptions {
	maxLines: number;
	maxBytes: number;
}

export interface Truncated {
	text: string;
	/** 被砍掉的行数。0 表示没截。 */
	omittedLines: number;
}

/**
 * 按行截断。
 *
 * 为什么是双限制:只限行数挡不住一行几千字的情况(高德的 `opentime2` 就能写很长),
 * 只限字节数又会把最后一行砍成半句 —— 半个 JSON、半个地址喂给模型比不给还糟,
 * 它会当成完整信息接着用。所以**字节超了就整行丢掉**,宁可少给一行。
 */
export function truncateLines(text: string, options: TruncateOptions): Truncated {
	const lines = text.split("\n");
	const kept: string[] = [];
	let bytes = 0;

	for (const line of lines) {
		if (kept.length >= options.maxLines) break;
		// +1 是换行符。用 Buffer 而不是 length:中文一个字三字节,按字符数算会严重低估。
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > options.maxBytes) break;
		kept.push(line);
		bytes += size;
	}

	const omittedLines = lines.length - kept.length;
	if (omittedLines <= 0) return { text, omittedLines: 0 };
	// 把「还有多少条」告诉模型,它才知道结果不全,可以决定要不要缩小范围重搜。
	return { text: `${kept.join("\n")}\n…还有 ${omittedLines} 条未显示`, omittedLines };
}
