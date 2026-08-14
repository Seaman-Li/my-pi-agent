/**
 * 类型擦除 vs 运行时值 —— 为什么 pi 必须用 typebox 而不能只用 TS 类型
 *
 * 运行：  node --experimental-strip-types notes/examples/type-erasure.ts
 * 看产物：npx tsc --target es2022 --module esnext --moduleResolution bundler \
 *              --outDir /tmp/out --skipLibCheck notes/examples/type-erasure.ts
 *        然后 cat /tmp/out/type-erasure.js —— type A 和 type C 会整行消失
 *
 * 相关笔记：../ts-notes.md 第 1 条（类型空间 vs 值空间）
 */
import { Type, type Static } from "typebox";

// ① TS 语法：一个类型。编译后整行消失。
type A = { path: string };

// ② typebox：一个值。编译后原样保留，因为它必须被发送给 LLM。
const B = Type.Object({ path: Type.String() });

// ③ 从 ② 派生出的类型，结构等价于 ①。同样编译后消失。
type C = Static<typeof B>;

console.log("B 是值，运行时存在：", JSON.stringify(B));
console.log("typeof B =", typeof B);

// 类型只能用在类型位置
const a1: A = { path: "/tmp/x" };
const c1: C = { path: "/tmp/y" };
console.log("a1 =", a1, " c1 =", c1);

// 关键：B 能被序列化发给 LLM，A 不能——它在运行时根本不存在
console.log("能发给 LLM 的：", JSON.stringify(B));

// 取消注释逐个试，三个都会在「编译期」被拦下：
 
//  console.log(A);              // ❌ "A" 只表示类型，不能用作值
//  const bad: A = { path: 1 };  // ❌ number 不能赋给 string
//  const c2: C = { path: 1 };   // ❌ 同样被拦
 
 /* ─────────────────────────────────────────────────────────────
 * 第三个最值得试：它证明 Static<typeof B> 不是退化成 any，
 * 而是真的从 B 里提取出了 { path: string }。
 * 因为 Type.Object() 返回的是 TObject<Properties> 而非 TSchema，
 * 泛型参数把字段结构一路带进了类型层，Static<> 才有东西可读。
 * ───────────────────────────────────────────────────────────── */
