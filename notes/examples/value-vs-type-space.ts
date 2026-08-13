/**
 * 值空间 vs 类型空间 —— TS 最容易绊倒 Python/Java 背景读者的一点
 *
 * 看类型错误（本文件故意留了 3 个）：
 *   npx tsc --noEmit --skipLibCheck notes/examples/value-vs-type-space.ts
 *
 * 运行合法部分（剥离模式不做类型检查，所以能跑起来）：
 *   node --experimental-strip-types notes/examples/value-vs-type-space.ts
 *
 * 相关笔记：../ts-notes.md 第 1 条（类型空间 vs 值空间）
 */

// ─────────── 只存在于类型空间：编译后消失 ───────────
type A = { path: string };
interface I {
	n: number;
}

// ─────────── 只存在于值空间：运行时真实存在 ───────────
const b = { path: "/tmp" };
function f(): number {
	return 1;
}

// ─────────── 同时存在于两个空间（class / enum 特有） ───────────
class C {
	x = 1;
}

// ─────────── 合法：各自用在对的位置 ───────────
const a1: A = { path: "x" }; // A 用在类型位置
const i1: I = { n: 1 }; // I 用在类型位置
const c1: C = new C(); // C 左边当类型，右边当值
type TB = typeof b; // typeof 把值拉进类型空间 → { path: string }
const b2: TB = { path: "/var" };

console.log("a1 =", a1, "i1 =", i1, "c1.x =", c1.x, "b2 =", b2, "f() =", f());

// 同一个关键字，两个空间做完全不同的事
console.log("值空间的 typeof b  =", typeof b); // 运行时求值 → "object"
// 类型空间的 typeof b 见上面的 TB → { path: string }

/* ─────────── 故意留下的 3 个错误 ───────────
 * 运行上面的 tsc 命令会看到：
 *
 * TS2693: 'A' only refers to a type, but is being used as a value here.
 * TS2749: 'b' refers to a value, but is being used as a type here. Did you mean 'typeof b'?
 * TS2749: 'f' refers to a value, but is being used as a type here. Did you mean 'typeof f'?
 *
 * 注意 TS2749 直接给出了解法 typeof —— 那正是「值 → 类型」的桥。
 * 而 TS2693 无解：类型编译后不存在，无法在运行时凭空造出值。
 * 「类型 → 值」这个方向没有桥，是单向的。
 * ─────────────────────────────────────── */
// @ts-expect-error TS2749: b 是值，不能当类型
const bad1: b = { path: "x" };
// @ts-expect-error TS2749: f 是值，不能当类型
const bad2: f = 1;
void bad1;
void bad2;

// TS2693 的那行单独放进 try，因为它在运行时也会炸——而这正是重点：
// 类型编译后真的不存在，不是「语法不允许」，是「运行时没有那个东西」。
try {
	// @ts-expect-error TS2693: A 是类型，不能当值
	console.log(A);
} catch (e) {
	console.log("运行时访问类型 A →", (e as Error).constructor.name + ":", (e as Error).message);
}

/* ─────────── 各类声明进入哪个空间 ───────────
 *   声明              值空间   类型空间
 *   type A = ...        ❌       ✅
 *   interface I {}      ❌       ✅
 *   const / let / var   ✅       ❌
 *   function            ✅       ❌
 *   class C {}          ✅       ✅   ← 特例，所以 const c: C = new C() 合法
 *   enum E {}           ✅       ✅
 *
 * class 的双身份，正是 Java/Python 背景的人用 class 不别扭、
 * 一碰 interface 就懵的原因。
 * ─────────────────────────────────────── */
