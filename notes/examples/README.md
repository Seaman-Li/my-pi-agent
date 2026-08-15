# 可运行示例

配合 [../ts-notes.md](../ts-notes.md) 的最小可执行验证。**都从仓库根目录运行**（`node_modules` 在根上，Node 会自动向上查找）。

| 文件 | 验证什么 | 对应笔记 |
|---|---|---|
| [type-erasure.ts](type-erasure.ts) | TS 类型编译后消失，typebox 的 schema 是运行时的值 | ts-notes 第 1 条 |
| [value-vs-type-space.ts](value-vs-type-space.ts) | 值空间/类型空间的边界，`TS2693` 与 `TS2749` 两个方向的越界 | ts-notes 第 1 条 |
| [annotation-vs-inference.ts](annotation-vs-inference.ts) | 加不加类型标注的四个差异，重点是字面量拓宽对可辨识联合的影响 | ts-notes 第 10 条 |
| [static-factory.ts](static-factory.ts) | 静态工厂方法、`private constructor`、`static` 成员的空间归属 | ts-notes 第 13 条 |
| [which-space.ts](which-space.ts) | **怎么判断自己在类型空间还是值空间**——同一个 `typeof` 四个位置两种行为 | ts-notes 第 1 条 |

## 运行

```bash
cd /Users/simonli/Downloads/MyProjects/PiAgent
node --experimental-strip-types notes/examples/type-erasure.ts
node --experimental-strip-types notes/examples/value-vs-type-space.ts
```

`value-vs-type-space.ts` 的最后一行输出是重点：

```
运行时访问类型 A → ReferenceError: A is not defined
```

编译器那句 `'A' only refers to a type, but is being used as a value here`，拦截的正是这个必然发生的 `ReferenceError`。**不是语法不允许，是运行时真的没有那个东西。**

`--experimental-strip-types` 是 Node 22+ 的类型剥离模式——**只删类型，不做类型检查**，所以跑得很快。pi 自己也用这个模式（见 `AGENTS.md` 里"只用 erasable TypeScript 语法"那条规则的由来）。

## 看编译产物

想亲眼确认哪些行消失了：

```bash
npx tsc --target es2022 --module esnext --moduleResolution bundler \
        --outDir /tmp/out --skipLibCheck notes/examples/type-erasure.ts
cat /tmp/out/type-erasure.js
```

`type A` / `type C` 会整行不见，`const B` 原样保留，`import { Type, type Static }` 变成 `import { Type }`。

## 想看类型错误

剥离模式不检查类型。要验证示例末尾注释里那三行确实会被拦下，用：

```bash
npx tsc --noEmit --skipLibCheck notes/examples/type-erasure.ts
```

## 约定

- 每个示例文件顶部注释写清：验证什么、怎么跑、对应哪条笔记
- 保持单文件、零配置、可直接运行
- 新增示例后更新上面的表格
