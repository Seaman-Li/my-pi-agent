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
import { installTrace } from "./features/trace.ts";
import { createAskUser } from "./tools/ask-user.ts";
import { estimateBudget } from "./tools/estimate-budget.ts";
import { searchHotel } from "./tools/search-hotel.ts";
import { searchPoi } from "./tools/search-poi.ts";
import { weather } from "./tools/weather.ts";

export interface ComposeOptions {
	/** 打开后把四个挂载点的进出打到 stderr。 */
	trace?: boolean;
	/**
	 * 怎么向人提问。**不给就不注册 `ask_user`** —— 模型看不到这个工具,
	 * 也就不会在没人可问的环境里白花一次调用。宿主知道有没有人可问,工具不知道。
	 */
	asker?: Asker;
}

export interface Composed {
	tools: Registry;
	hooks: Hooks;
}

/**
 * 按开关拼出这次运行的工具集和 hook 集。
 *
 * @throws 工具重名时由 `Registry.register` 抛 —— 装配期炸掉,而不是运行期选错工具。
 */
export function compose(options: ComposeOptions = {}): Composed {
	const tools = new Registry();
	tools.register(weather);
	tools.register(searchPoi);
	tools.register(searchHotel);
	tools.register(estimateBudget);
	if (options.asker) tools.register(createAskUser(options.asker));

	const hooks = emptyHooks();
	if (options.trace) installTrace(hooks);

	return { tools, hooks };
}
