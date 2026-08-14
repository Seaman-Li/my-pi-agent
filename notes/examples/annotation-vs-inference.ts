/**
 * 有类型标注 vs 靠推断 —— `const a: A = {...}` 和 `const a = {...}` 差在哪
 *
 * 看类型错误（本文件用 @ts-expect-error 精确吸收了 3 个预期错误，应当无输出）：
 *   npx tsc --noEmit --skipLibCheck notes/examples/annotation-vs-inference.ts
 *
 * 运行：
 *   node --experimental-strip-types notes/examples/annotation-vs-inference.ts
 *
 * 相关笔记：../ts-notes.md 第 10 条
 */

type A = { path: string };

// ─────────── ① 形状相同时，两者等价 ───────────
const x1: A = { path: "/tmp" }; // 类型 A
const x2 = { path: "/tmp" }; // 推断为 { path: string }
const x3: A = x2; // 能赋回去，结构一致
console.log("① 等价：", x1, x2, x3);

// ─────────── ② 缺字段：标注在「声明处」就拦住 ───────────
// @ts-expect-error TS2741: Property 'path' is missing in type '{}' but required in type 'A'
const y1: A = {};
const y2 = {}; // 不报错，类型就是 {}；要等到用的时候才炸
void y1;
console.log("② 缺字段：无标注的 y2 =", y2);

// ─────────── ③ 多字段：标注触发「多余属性检查」 ───────────
// @ts-expect-error TS2353: Object literal may only specify known properties, and 'extra' does not exist in type 'A'
const z1: A = { path: "/t", extra: 1 };
const z2 = { path: "/t", extra: 1 }; // 推断为 { path: string; extra: number }
void z1;
console.log("③ 多字段：无标注的 z2 =", z2);

// 注意这个例外：经变量中转就不查多余属性了
const z3: A = z2; // ✅ 通过——多余属性检查只作用于「直接字面量赋值」
console.log("③ 中转后：", z3);

// ─────────── ④ 字面量拓宽（widening）—— 对可辨识联合影响最大 ───────────
type TextContent = { type: "text"; text: string };

const w1: TextContent = { type: "text", text: "hi" }; // 有上下文类型 → "text" 保持字面量
const w2 = { type: "text", text: "hi" }; // 无上下文 → type 被拓宽成 string

// @ts-expect-error TS2322: Type 'string' is not assignable to type '"text"'
const w3: TextContent = w2;
void w3;

console.log("④ w1 =", w1, " w2 =", w2);

// 绕过拓宽的两种写法
const w4 = { type: "text", text: "hi" } as const; // 整个对象只读 + 字面量
const w5 = { type: "text" as const, text: "hi" }; // 只锁 type 一个字段
const w6: TextContent = w5; // ✅ 通过
console.log("④ as const：", w4, w6);

/* ─────────── pi 里的真实做法 ───────────
 *
 * openai-completions.ts:274,352 —— 先声明带类型的变量，再赋值
 *   let textBlock: TextContent | null = null;
 *   textBlock = { type: "text", text: "" };     // 有上下文类型，不拓宽
 *
 * agent-session.ts:1399 —— 数组加标注，保证元素类型精确
 *   const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
 *
 * read.ts:16 —— 不加标注，因为 Type.Object() 返回 TObject<Properties>，
 *   泛型参数已把结构带出来。加标注反而丢信息：
 *   标成 TSchema 的话 Static<> 就什么都推不出来了。
 *   const readSchema = Type.Object({ ... });
 * ─────────────────────────────────────── */
