/**
 * 怎么判断自己在类型空间还是值空间
 *
 * 运行：  node --experimental-strip-types notes/examples/which-space.ts
 * 类型检查：npx tsc --noEmit --skipLibCheck notes/examples/which-space.ts
 *
 * 相关笔记：../ts-notes.md 第 1 条
 */

const B = { path: "/tmp" };

// ─────────── 同一个 typeof B，四个位置，两种行为 ───────────

type T1 = typeof B; // type 等号右边   → 类型空间 → { path: string }
const v1: typeof B = { path: "x" }; // 冒号右边       → 类型空间 → 用作标注
const v2 = typeof B; // 等号右边(非 type) → 值空间   → 字符串 "object"

console.log("类型空间：v1 =", v1);
console.log("值空间：  v2 =", v2, "| 直接打印 =", typeof B); // 实参位置 → 值空间

const t1: T1 = { path: "y" };
console.log("T1 用作标注 =", t1);

/* ═══════════════════════════════════════════════════════════
 * 判别规则：看「语法位置」，不看「声明还是使用」
 *
 * ✗ 常见误解：声明是编译时，使用是运行时
 *   反例 1：const b = {...}   是声明，但完全属于值空间
 *   反例 2：class C {}        是声明，但两个空间都进
 *
 * ✓ 只有这些记号会打开类型空间，其余一切都是值空间：
 *
 *   记号                例子                          类型空间范围
 *   ────────────────────────────────────────────────────────────
 *   type X =            type C = ...                  等号右边全部
 *   :  标注             const a: A / function f(): A  冒号右边
 *   <...> 类型实参      Static<...> / Tool<...>       尖括号内
 *   as / satisfies      x as A                        关键字右边
 *   interface 体        interface I { n: number }     花括号内
 *   extends/implements  <T extends TSchema>           关键字右边
 *
 * ✓ 不确定时的实用判据：
 *   问「这段代码编译成 JS 后还在吗」
 *     还在 → 值空间（console.log(typeof B) 原样保留）
 *     没了 → 类型空间（type C = ... 整行消失）
 *
 * ═══════════════════════════════════════════════════════════
 * 对照本文件：
 *
 *   type C = Static<typeof B>;
 *   ↑ type 打开类型空间，等号右边整个都是 → 这个 typeof 是类型运算符
 *
 *   console.log("typeof B =", typeof B);
 *   ↑ 实参位置，没有任何记号打开类型空间 → 这个 typeof 是 JS 运行时运算符
 *
 * 同一个关键字，落在哪个空间由「周围位置」决定，与它自己无关。
 * ═══════════════════════════════════════════════════════════ */
