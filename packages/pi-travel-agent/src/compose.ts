/**
 * 装配处:把工具和 feature 拼成一次运行需要的东西。
 *
 * 层:入口 —— 唯一知道「这个 agent 由哪些积木组成」的地方。
 * 边界:加一块积木 = 这里加一行。cli 只管 IO,core 谁都不认识,
 *       所以「组合」这件事必须有个明确的家,就是本文件。
 *       真正的自由组合发生在这儿的 `if` 里,不发生在 git 分支上 ——
 *       分支只能线性叠加,想验证「只开 A 不开 B」得靠开关。
 */

import { emptyHooks, type Hooks } from "./core/hooks.ts";
import { Registry } from "./core/registry.ts";
import type { Asker } from "./core/types.ts";
import { type CompactionOptions, type Compactor, installCompaction } from "./features/compaction.ts";
import { installConfirm } from "./features/confirm.ts";
import { type GuardOptions, installGuard } from "./features/guard.ts";
import { installMemory } from "./features/memory.ts";
import { installTrace } from "./features/trace.ts";
import type { MemoryStore } from "./memory/store.ts";
import { createAskUser } from "./tools/ask-user.ts";
import { estimateBudget } from "./tools/estimate-budget.ts";
import { createRemember } from "./tools/remember.ts";
import { createSavePlan } from "./tools/save-plan.ts";
import { searchHotel } from "./tools/search-hotel.ts";
import { searchPoi } from "./tools/search-poi.ts";
import { weather } from "./tools/weather.ts";

export interface ComposeOptions {
	/**
	 * HTML 报告写到哪儿。**必填,而且必须是绝对路径** —— 它不是功能开关,是宿主的资源。
	 * 让工具自己从 `import.meta.url` 推目录,文件一挪位置就写到别处去了。
	 */
	outDir: string;
	/** 打开后把四个挂载点的进出打到 stderr。 */
	trace?: boolean;
	/**
	 * 怎么向人提问。**不给就不注册 `ask_user`** —— 模型看不到这个工具,
	 * 也就不会在没人可问的环境里白花一次调用。宿主知道有没有人可问,工具不知道。
	 */
	asker?: Asker;
	/**
	 * 跨会话记忆。不给就**既不注册 `remember` 也不注入记忆块** —— 整块积木不存在。
	 *
	 * `basePrompt` 必须和 `context.systemPrompt` 是同一份:注入是「拿它重新拼一遍」,
	 * 不是往当前值上追加。两者对不上的话,第二步开始 prompt 就悄悄变了。
	 */
	memory?: { store: MemoryStore; basePrompt: string };
	/**
	 * 上下文压缩。不给就**一次都不会压** —— 上下文照常长下去,长到撞窗口为止。
	 *
	 * 里面要 `session` 是硬性的:压缩会让历史变短,而「这段历史不再发给模型了」
	 * 不落盘的话,就成了一次没人知道、事后也查不回来的信息丢失。
	 * 所以**没有会话记录的运行(单轮模式)压根不装这块积木**。
	 */
	compaction?: CompactionOptions;
	/**
	 * 域外拦截 + 单条输入上限。不给就**一道闸都没有** ——
	 * `prompts/system.md` 里那层写死的角色照样在(它才是主力),只是不再省那次请求。
	 */
	guard?: GuardOptions;
}

export interface Composed {
	tools: Registry;
	hooks: Hooks;
	/** 手动压一次(`/compact`)。没开压缩就没有它 —— 命令也就跟着不存在。 */
	compact?: Compactor;
}

/**
 * 按开关拼出这次运行的工具集和 hook 集。
 *
 * @throws 工具重名时由 `Registry.register` 抛 —— 装配期炸掉,而不是运行期选错工具。
 */
export function compose(options: ComposeOptions): Composed {
	const tools = new Registry();
	tools.register(weather);
	tools.register(searchPoi);
	tools.register(searchHotel);
	tools.register(estimateBudget);
	tools.register(createSavePlan({ outDir: options.outDir }));
	if (options.asker) tools.register(createAskUser(options.asker));
	if (options.memory) tools.register(createRemember(options.memory.store));

	const hooks = emptyHooks();
	// trace 先挂:它只观察不拦截,得让它先把这次调用记下来,再轮到别人决定放不放。
	if (options.trace) installTrace(hooks);
	// **guard 必须排在 memory 前面。** Step 8a 之后 `beforeStep` 会短路
	// (第一个返回拒绝的赢),而这道闸的全部价值就是「不发请求」——
	// 排在注入后面的话,挡下来的那一步已经白拼过一次 system prompt 了。
	// 这是 hook 顺序第一次真的有意义,不再只是风格问题。
	if (options.guard) installGuard(hooks, options.guard);
	// 记忆挂 `beforeStep`,和 confirm 的 `beforeToolCall` 是两个不同的挂载点 ——
	// 注入上下文和拦截调用是两件事,凑在一个点上只会让顺序变得要紧而没有理由。
	if (options.memory) installMemory(hooks, options.memory);
	// 压缩挂 `afterStep`,不是 `beforeStep`:要看到**这一步的工具结果也进了上下文之后**的样子。
	// 挂在 beforeStep 的话,一步里查了六个 POI 撑爆上下文,得等到下一步才发现。
	const compact = options.compaction ? installCompaction(hooks, options.compaction) : undefined;
	// 和 `ask_user` 同一条判断:没人可问就**根本不挂这块积木**。
	// 管道 / CI 里 save_plan 照常执行 —— 拦截是为了尊重用户的意愿,没有用户就没有意愿要尊重。
	if (options.asker) {
		installConfirm(hooks, {
			asker: options.asker,
			rules: [
				{
					tool: "save_plan",
					// 参数没经过校验(见 confirm.ts),所以 title 得这么取。
					question: (args) => {
						const title = typeof args.title === "string" && args.title ? args.title : "这份行程";
						return `要把「${title}」存成 HTML 报告吗?`;
					},
					// 这句话是**写给模型看的**。不写「别再存了」的话,它多半会换个 title 再试一次。
					declined: "用户这次不需要保存报告。不要再调 save_plan,除非他后面明确又提出来。",
				},
			],
		});
	}

	return { tools, hooks, compact };
}
