/**
 * 静态工厂方法 + private constructor —— pi 里 ModelRuntime 用的模式
 *
 * 类型检查（有 2 个故意的错误，被 @ts-expect-error 吸收）：
 *   npx tsc --noEmit --skipLibCheck notes/examples/static-factory.ts
 * 运行：
 *   node --experimental-strip-types notes/examples/static-factory.ts
 *
 * 相关笔记：../ts-notes.md 第 13 条
 */

export {}; // 顶层 await 要求本文件是模块

class Runtime {
	static readonly VERSION = "1.0"; // 静态字段：挂在类上
	private readonly config: string; // 实例字段：挂在实例上
	private static instances = 0; // 私有静态字段：全类共享计数

	// 私有构造：外部无法 new，强制走 create()
	private constructor(config: string) {
		this.config = config;
		Runtime.instances++; // 静态成员通过类名访问
	}

	// 静态工厂：可以 async，构造函数不行
	static async create(path: string): Promise<Runtime> {
		const config = await Runtime.loadConfig(path); // ① 异步准备
		const rt = new Runtime(config); // ② 同步构造（静态方法能调私有构造）
		rt.warmUp(); // ③ 后续初始化
		return rt; // 拿到手就是可用的
	}

	private static async loadConfig(path: string): Promise<string> {
		await new Promise((r) => setTimeout(r, 1)); // 模拟 I/O
		return `config-from:${path}`;
	}

	private warmUp(): void {
		/* 假装预热 */
	}

	describe(): string {
		return `${this.config} (v${Runtime.VERSION}, 已创建 ${Runtime.instances} 个)`;
	}
}

const rt = await Runtime.create("/tmp/models.json");
console.log(rt.describe());
console.log("静态字段从类上访问：", Runtime.VERSION);

// ── 私有构造挡住了外部实例化 ──
// @ts-expect-error TS2673: Constructor of class 'Runtime' is private
const bad = new Runtime("x");
void bad;

// ── 静态成员不在实例上 ──
// @ts-expect-error TS2339: Property 'VERSION' does not exist on type 'Runtime'
const v = rt.VERSION;
void v;

/* ═══════════════════════════════════════════════════════
 * 为什么构造函数不能异步、必须用静态工厂
 *
 *   async constructor(...) {}   // ❌ 语法错误
 *
 * 构造函数必须返回实例，不能返回 Promise。而 pi 的
 * ModelRuntime.create() 需要 await：
 *   - ModelConfig.load()  读 models.json
 *   - runtime.refresh()   联网刷新模型目录  ← 决定性理由
 *   - 凭证读取（钥匙串 / OAuth 刷新）
 *
 * Node 里网络 I/O 没有同步形态（没有 fetchSync），
 * 所以只要这一步存在，create() 就必须 async，无从选择。
 *
 * 「逻辑上阻塞」≠「阻塞线程」：
 *   await create()        当前逻辑等待，事件循环空闲，其他启动任务可并发
 *   readFileSync + 同步网络   整个进程卡死
 *
 * ═══════════════════════════════════════════════════════
 * 为什么不用 new + init()
 *
 *   const rt = new Runtime();   // 同步造空壳
 *   await rt.init();            // 再异步初始化
 *
 * 这样会留下「拿到实例但还不能用」的窗口期，调用方可能忘记 await init()。
 * private constructor + static async create 在类型层面杜绝了这种状态：
 * 能拿到实例，就意味着它已经准备好了。
 * ═══════════════════════════════════════════════════════ */
