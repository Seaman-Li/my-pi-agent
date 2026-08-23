/**
 * 里氏替换：为什么 extends 不能给方法加参数
 *
 * 运行（看运行时真的崩）：
 *   node --experimental-strip-types notes/examples/liskov-arity.ts
 * 类型检查（看编译期就被拦住）：
 *   npx tsc --noEmit --skipLibCheck --strict --module esnext --target es2022 \
 *           --moduleResolution bundler notes/examples/liskov-arity.ts
 *
 * 相关笔记：../ts-notes.md 第 24 条
 * 真实出处：packages/agent/src/harness/types.ts:81 的 AgentHarnessTool
 */

interface Base {
	execute(a: string, b: number): void;
}

// ① extends 加参数 —— 编译期就被拦住
//    error TS2430: Interface 'Ext' incorrectly extends interface 'Base'.
//      Target signature provides too few arguments. Expected 3 or more, but got 2.
// @ts-expect-error 故意保留，取消这行注释可以看到真实报错
interface Ext extends Base {
	execute(a: string, b: number, c: { env: string }): void;
}

// ② extends 减参数 —— 合法。多传的实参在 JS 里看不见
interface Ext2 extends Base {
	execute(a: string): void;
}

// ③ pi 的做法：Omit 掉再交叉上新的。不声称是子类型，只复用字段
type Ext3 = Omit<Base, "execute"> & {
	execute(a: string, b: number, c: { env: string }): void;
};

// ────────────────────────────────────────────────────────────
// 运行时演示：假如 ① 被放行会发生什么
// ────────────────────────────────────────────────────────────

const base = {
	execute(a: string, b: number) {
		console.log("base ok:", a, b);
	},
};

const ext = {
	execute(a: string, b: number, c: { env: string }) {
		console.log("ext:", a, b, c.env);
	},
};

/** 只认识 Base 的调用方——它只看得见 2 个参数 */
function run(t: { execute: (...args: any[]) => void }): void {
	t.execute("x", 1);
}

run(base); // base ok: x 1
try {
	run(ext); // 💥 c 是 undefined
} catch (error) {
	console.log("💥", (error as Error).constructor.name + ":", (error as Error).message);
}

// 实测输出：
//   base ok: x 1
//   💥 TypeError: Cannot read properties of undefined (reading 'env')
//
// 对照 Python（mypy 报同一条规则，运行时反而更早暴露）：
//   t.py:6: error: Signature of "execute" incompatible with supertype "Base"  [override]
//   💥 TypeError: Ext.execute() missing 1 required positional argument: 'c'

export type { Ext, Ext2, Ext3 };
