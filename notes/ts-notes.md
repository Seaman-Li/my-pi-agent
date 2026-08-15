# TypeScript 疑难点笔记

读 pi 源码过程中撞到的 TS/JS 概念。按**遇到就补**的方式增长，不追求体系完整。
每条都附 pi 里的真实出处和 Python 类比（Python 为主的读者视角）。

---

## 1. 类型空间 vs 值空间

**TS 里有两套彼此独立的命名空间**，同一个 `=` 号在两边含义不同。这是最容易混淆的一点。

```ts
function f(x = 1)                              // 值空间：默认值 1
interface Tool<TParameters extends TSchema = TSchema>   // 类型空间：默认类型
```

`Tool` 那行的 `= TSchema`，**等号两边都是类型**，不需要任何值参与。而 `parameters: TParameters` 才需要真实的值。

分清这四样东西（出处 `packages/agent/src/harness/tools/read.ts:16-22`）：

| 名字 | 是类型还是值 | 说明 |
|---|---|---|
| `TSchema` | **类型** | typebox 的标记接口 |
| `Type.Object` | **值**（函数） | 运行时可调用 |
| `readSchema` | **值**（对象） | `Type.Object({...})` 的返回结果，真实的 JSON Schema |
| `ReadToolInput` | **类型** | 由 `Static<typeof readSchema>` 提取 |

### 哪些声明进入哪个空间

| 声明 | 值空间 | 类型空间 |
|---|---|---|
| `type A = ...` | ❌ | ✅ |
| `interface I {}` | ❌ | ✅ |
| `const` / `let` / `var` | ✅ | ❌ |
| `function` | ✅ | ❌ |
| `class C {}` | ✅ | ✅ **两个都进** |
| `enum E {}` | ✅ | ✅ 两个都进 |

`class` 的双身份让这行合法：`const c: C = new C()`——左边当类型（实例形状），右边当值（构造函数）。**这正是 Java/Python 背景的人用 class 不别扭、一碰 interface 就懵的原因。**

### 怎么判断自己在哪个空间 ⭐

**判据是「语法位置」，不是「声明还是使用」。**

常见误解：声明是编译时、使用是运行时。两个反例就推翻：

- `const b = {...}` 是**声明**，但完全属于值空间
- `class C {}` 是**声明**，但两个空间都进

**只有这几个记号会打开类型空间，其余一切都是值空间**：

| 记号 | 例子 | 类型空间范围 |
|---|---|---|
| `type X =` | `type C = ...` | 等号右边全部 |
| `:` 标注 | `const a: A`、`function f(p: A): A` | 冒号右边 |
| `<...>` 类型实参 | `Static<...>`、`Tool<...>` | 尖括号内 |
| `as` / `satisfies` | `x as A` | 关键字右边 |
| `interface` 体 | `interface I { n: number }` | 花括号内 |
| `extends` / `implements` | `<T extends TSchema>` | 关键字右边 |

**不确定时的实用判据**：问「这段代码编译成 JS 后还在吗」——

- 还在 → 值空间（`console.log(typeof B)` 原样保留）
- 没了 → 类型空间（`type C = ...` 整行消失）

### 同一个 `typeof`，位置决定行为

```ts
const B = { path: "/tmp" };

type T1 = typeof B;                  // type 等号右边   → 类型空间 → { path: string }
const v1: typeof B = { path: "x" };  // 冒号右边        → 类型空间 → 用作标注
const v2 = typeof B;                 // 等号右边(非 type) → 值空间  → 字符串 "object"
console.log(typeof B);               // 实参位置        → 值空间  → 字符串 "object"
```

四个写法完全一样，行为分成两组。**落在哪个空间由周围位置决定，与 `typeof` 自己无关。**

回到最初那两行：

```ts
type C = Static<typeof B>;          // type 打开类型空间 → 类型运算符 → TObject<{path: TString}>
console.log("typeof B =", typeof B); // 实参位置        → JS 运算符   → "object"
```

**可运行验证**：[examples/which-space.ts](examples/which-space.ts)

### 为什么运行时的 `typeof` 给不出形状

JS 的 `typeof` 只有 8 种返回值（`object` / `string` / `number` / `boolean` / `undefined` / `function` / `symbol` / `bigint`），**天生无法区分对象形状**：

```ts
typeof Type.Object({...}) === typeof { path: "/tmp" } === typeof [1,2,3]  // 全是 "object"
```

三者 `constructor` 也都是 `Object`。**这正是 typebox 必须存在的根**——运行时反射不出形状，只能显式构造一个"自带形状描述"的对象（见第 9 条）。

### 和 Python 的根本差异

| | 类型信息在运行时 | 标注是否求值 | 独立类型空间 |
|---|---|---|---|
| **Python** | ✅ 保留在 `__annotations__` | ✅ 是普通表达式 | ❌ 只有一个空间 |
| **TypeScript** | ❌ 全部擦除 | ❌ 编译时删掉 | ✅ 两个独立空间 |

Python 里 `f.__annotations__['x'] is A` 为 `True`——**标注里的 `A` 和值 `A` 就是同一个对象**。而且标注会在运行时求值：`def g(x: Undefined)` 直接抛 `NameError`（Python 3.11 默认行为）。TS 里类型写错只有编译期报错，运行时无事，因为那行根本不存在。

**Python 是「一个空间，类型也是值」，TS 是「两个空间，类型不是值」。** 所以 Pydantic 能读类生成 schema，而 TS 只能反过来——先造 schema 值，再派生类型。

### 越界的两个方向

| 错误码 | 消息 | 方向 | 有救吗 |
|---|---|---|---|
| `TS2693` | `'A' only refers to a type, but is being used as a value here` | 类型 → 值 | **无解** |
| `TS2749` | `'b' refers to a value, but is being used as a type here. Did you mean 'typeof b'?` | 值 → 类型 | 用 `typeof` |

`TS2693` 无解，因为**类型编译后真的不存在**。跑 [examples/value-vs-type-space.ts](examples/value-vs-type-space.ts) 能看到实证：

```
运行时访问类型 A → ReferenceError: A is not defined
```

编译器那句报错拦截的正是这个必然发生的 `ReferenceError`——**不是语法不允许，是运行时没有那个东西**。

**跨越两个空间的桥梁**：

- `typeof value` —— 从**值**反推**类型**。**单向**，只有值→类型这一条路。
- `Static<T>` —— typebox 提供，把 schema 类型转成普通 TS 类型

⚠️ **两个 `typeof` 是完全不同的东西**，只是长得一样：

```ts
console.log(typeof b);   // 值空间：运行时求值 → 字符串 "object"
type TB = typeof b;      // 类型空间：编译期提取 → { path: string }
```

`Static<typeof readSchema>` 用的是类型空间那个。

```ts
const readSchema = Type.Object({ path: Type.String() });  // 值
type ReadToolInput = Static<typeof readSchema>;           // 值 →(typeof)→ 类型 →(Static)→ 类型
// 结果：{ path: string }
```

**一处定义两处生效**：同一个 `readSchema` 既作为 JSON Schema 发给 LLM（告诉模型怎么调工具），又作为 TS 类型来源（工具实现里享受补全和检查）。

> Python 类比：Python 没有这么强的分离。`TypedDict` 类既是类型也是运行时对象，`typing.get_type_hints()` 勉强对应 `typeof`。

**可运行验证**：[examples/type-erasure.ts](examples/type-erasure.ts)

```bash
node --experimental-strip-types notes/examples/type-erasure.ts
```

编译前后对比（`type` 开头的整行消失，`const` 保留）：

| 源码 | 编译产物 |
|---|---|
| `type A = { path: string };` | **整行消失** |
| `type C = Static<typeof B>;` | **整行消失** |
| `const B = Type.Object({...})` | ✅ 原样保留 |
| `import { Type, type Static }` | → `import { Type }` |
| `const a1: A = {...}` | → `const a1 = {...}` |

`JSON.stringify(B)` 能跑；`JSON.stringify(A)` **连编译都过不了**——`A` 不是值。**这就是 pi 必须用 typebox 而不能只用 TS 类型的原因：工具定义要发给模型，发送需要值。**

`import { Type, type Static }` 里那个 `type` 前缀，作用是告诉编译器"这个导入只用于类型，编译时删掉"。`types.ts:471` 的 `import type { TSchema } from "typebox"` 是同一件事的完整形式——整行编译后消失。

---

## 2. 泛型的三段式：`T extends C = D`

```ts
interface Tool<TParameters extends TSchema = TSchema> { ... }
//             ─────┬─────  ───────┬─────  ───┬───
//               ①参数名        ②约束       ③默认值
```

| 记号 | 作用 |
|---|---|
| `TParameters` | 类型参数占位符，惯例 `T` 开头 |
| `extends TSchema` | **约束**：传入的类型必须满足 `TSchema` |
| `= TSchema` | **默认值**：不写尖括号时用它 |

**`extends` 在泛型约束里不是继承**，读作"必须满足"。和 `class A extends B` 是不同语法位置的同名关键字。

默认值的实际价值：让不关心具体 schema 的地方能省略尖括号。

```ts
export interface Context {
	tools?: Tool[];       // 因为有默认值，等价于 Tool<TSchema>[]
}
```

没有 `= TSchema` 的话，每个引用点都得写 `Tool<TSchema>[]`。

> Python：`TypeVar("T", bound=TSchema)` —— `bound=` 对应 `extends`，但**默认值要 Python 3.13+（PEP 696）**才有。

---

## 3. 结构化类型：interface 不需要「被实现」

```ts
export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}
```

**全项目零处 `implements TextContent`**（可自行 `grep -rn "implements TextContent" packages/` 验证）。

Java/C# 是**名义类型**，必须显式 `implements`；TS 是**结构类型**——**形状对上就是它**：

```ts
const a = { type: "text", text: "hi" };   // 这就是一个 TextContent
```

实际构造点全是对象字面量，一个 `class` 都没有：

```ts
// packages/ai/src/api/openai-completions.ts:352
textBlock = { type: "text", text: "" };
```

**关键推论：类型编译后全部被抹除**，运行时不存在任何叫 `TextContent` 的东西。所以 session JSONL 里存的 `{"type":"text","text":"2"}` 直接 `JSON.parse` 出来就能当 `TextContent` 用，**不需要反序列化成类**。

> Python 类比：用 `TypedDict`（结构化、运行时就是 dict），不是 `class`。`Protocol` 也结构化，但那是给行为/方法用的。

### 副作用：多余属性检查

结构类型有个例外规则：

```ts
const a: TextContent = { type: "text", text: "hi", extra: 1 };  // ❌ 报错
const b = { type: "text", text: "hi", extra: 1 };
const c: TextContent = b;                                        // ✅ 通过
```

**直接字面量赋值**时额外检查多余属性（为了捕获 `text` 拼成 `txt` 这类错误），经变量中转就不查了。

---

## 4. 可辨识联合（discriminated union）

类型被抹除后，运行时靠一个**字面量标签字段**判别分支：

```ts
export type Message = UserMessage | AssistantMessage | ToolResultMessage;   // 靠 role 判别
export type AssistantMessageEvent = ...                                     // 靠 type 判别
```

```ts
if (block.type === "text")           block.text;      // TS 收窄为 TextContent
else if (block.type === "thinking")  block.thinking;  // 收窄为 ThinkingContent
```

**同一个字段两头都用**：编译期靠它收窄类型，运行期靠它走分支。这是 pi 表达所有消息和事件类型的基础手法。

> Python：`Union[...] + Literal["text"]` 标签字段，`match` 语句配合。

---

## 5. `(A | B)[]` —— 括号优先级

```ts
content: string | (TextContent | ImageContent)[];
```

从里往外读：

| 步骤 | 表达式 | 含义 |
|---|---|---|
| 1 | `TextContent \| ImageContent` | 联合：文本块**或**图片块 |
| 2 | `(...)[]` | 数组，**元素类型是括号里那个联合** |
| 3 | `string \| (...)[]` | 要么字符串，要么那种数组 |

**`[]` 优先级高于 `|`，括号不能省**：

```ts
(TextContent | ImageContent)[]    // 数组，元素可为两者之一 ✅
 TextContent | ImageContent[]     // 「一个 TextContent」或「ImageContent 的数组」 ❌
```

第二种写法下无法在一个数组里混放文字和图片——而混放正是该字段的意义（一条消息既有文字又有截图）。

> Python：`Union[str, List[Union[TextContent, ImageContent]]]`

---

## 6. `Partial<Record<K, V>>` 表达三态

```ts
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
```

逐层拆：

| 步骤 | 结果 |
|---|---|
| `ModelThinkingLevel` | 7 个字符串字面量的联合（`off` / `minimal` / … / `max`） |
| `Record<K, V>` | 键为 K、值为 V 的对象，**要求全部 7 个键都在** |
| `Partial<T>` | 把所有属性变可选 |

**为什么要 `Partial` + `| null` 叠加**——为了表达三种状态：

| 状态 | 含义 |
|---|---|
| 键不存在 | 用 provider 默认值 |
| 值是字符串 | 该 provider 的具体取值 |
| 值是 `null` | **该模型明确不支持这个档位** |

「不存在」≠「null」。实现见 `openai-completions.ts:927`，一行三元链对应三态：

```ts
return mappedValue === undefined ? reasoningEffort              // 键缺失
     : typeof mappedValue === "string" ? mappedValue            // 有映射
     : undefined;                                               // null → 不发送
```

注意它**没写 `=== null`**，靠 `typeof === "string"` 反向兜底——因为类型是 `string | null`，排除 string 后必然是 null。这是联合类型收窄的典型用法，也是值类型要精确写成 `string | null` 而非 `any` 的理由。

> Python：`TypedDict(..., total=False)` + `Optional[str]`。同样要区分「键缺失」和「值为 None」——`dict.get()` 的经典坑。

---

## 7. `unknown | T` 会坍缩

```ts
onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
```

`unknown` 是**顶层类型**（top type），任何类型与它取并集还是它：`unknown | T ≡ unknown`。

所以这个返回类型**等价于直接写 `=> unknown`**，那三个分支对编译器毫无约束力，只是**写给人看的文档**。真正的契约在 JSDoc 和调用点：

```ts
// openai-completions.ts:237-240
const nextParams = await options?.onPayload?.(params, model);
if (nextParams !== undefined) { params = nextParams as ...; }   // 返回 undefined = 不改
```

**看到 `unknown | 别的` 就该意识到后半截是装饰。**

### `unknown` vs `any`

`AGENTS.md` 明令禁止 `any`，而这里用 `unknown` 是正面示范：

| | 能否直接使用 | 
|---|---|
| `any` | 直接放行，丢失所有检查 |
| `unknown` | **必须先收窄或断言**才能用（注意第 239 行必须 `as`） |

---

## 8. 类型允许 ≠ 实际这么用

不是语法点，是**读 TS 代码的方法论**，但踩过两次坑所以记在这里。

`UserMessage.content: string | (TextContent | ImageContent)[]` 的 `string` 分支，实际调用点统计：

| 场景 | 裸字符串 | 数组 |
|---|---|---|
| `packages/ai/test/` | **181 处** | 6 处 |
| `packages/*/src/` 生产代码 | **1 处** | 全部 |

CLI 和 SDK 都用不到那个分支（`agent-session.ts:1399` 一律包装成数组），它的真实用户是测试代码。

> **类型描述的是可能性空间，数据才是事实。**

`packages/ai` 为兼容 N 家 provider 故意留了大量宽松分支，实际走到的往往只有一条。看到联合类型的分支，先 `grep -c` 数调用点再下结论。详见 [agent-factcheck.md](agent-factcheck.md)。

---

## 9. typebox 不是 TS 自带的

读 `types.ts` 时最容易混的一点。**分清三类东西**：

| 类别 | 例子 | 来源 | 要 import 吗 |
|---|---|---|---|
| **TS 语法** | `interface` / `type` / `extends` / `\|` / `[]` / 泛型 `<T>` | 语言本身 | 不需要 |
| **TS 内置工具类型** | `Partial<>` / `Record<>` / `Pick<>` / `Omit<>` / `ReturnType<>` | 语言本身（全局可用） | 不需要 |
| **typebox 提供的** | `TSchema` / `TObject` / `Type.Object` / `Static<>` | **第三方 npm 包** | **必须 import** |

**判别方法：要不要 import。** 同一个 `types.ts` 里，`Partial`/`Record` 白用（第 84 行），`TSchema` 必须导入（第 471 行）。

`typebox: "1.3.7"` 是 `packages/ai/package.json` 里明写的依赖。

### `Type.Object` 不是「TS 的对象」

名字有迷惑性。`Type` 是 typebox 导出的一个**普通 JS 对象**，上面挂着 `Object` / `String` / `Number` / `Array` / `Optional` 等一堆**构造 JSON Schema 的函数**。它和 TS 的对象类型 `{ path: string }` 毫无关系。

### `TSchema` / `TObject` / `readSchema` 三者的关系

```
interface TSchema {}                    ← 空的基接口（纯标记）
        ▲ extends
interface TObject extends TSchema {     ← 具体种类，有真实字段
    '~kind': 'Object';
    type: 'object';
    properties: Properties;
    required: TRequiredArray<Properties>;
}
        ▲ 类型是
const readSchema = Type.Object({...})   ← 你的那个值
```

`Type.Object()` 的返回类型是 **`TObject<Properties>`**，不是 `TSchema`。所以 `readSchema` 和 `TSchema` 之间**隔了两层**——说"满足 `TSchema`"没错，但真正描述它形状的是中间那层 `TObject`。

**`Static<>` 靠的正是 `TObject` 这层的具体字段**：它读 `properties` 和 `required` 才能推出 `{path: string; offset?: number}`。如果返回类型真的只是空的 `TSchema`，`Static<>` 什么都推不出来。

### 为什么基接口是空的

`interface TSchema {}` 空着不是偷懒——它要容纳所有 schema 种类，而这些子类型**字段互不相同**（`TObject` 有 `properties`，`TArray` 有 `items`，`TUnion` 有 `anyOf`），公共字段是空集。

代价：`extends TSchema` 这个约束在编译期几乎不设防。

```ts
Tool<{ foo: 1 }>   // ✅ 能过，空接口拦不住普通对象
Tool<string>       // ❌ 报错，基本类型不是对象
```

真正的校验靠运行时的类型守卫 `IsSchema(value): value is TSchema`。**约束的实际强度比看起来弱。**

### 运行时长什么样

`Type.Object({...})` 求值后就是一个普通对象（`constructor === Object`），内容是标准 JSON Schema：

```json
{
  "type": "object",
  "required": ["path"],
  "properties": {
    "path":   { "type": "string", "description": "..." },
    "offset": { "type": "number", "description": "..." },
    "limit":  { "type": "number", "description": "..." }
  }
}
```

`TObject` 声明的 `'~kind': 'Object'` **不在 JSON 里**——`~` 前缀是 typebox 标记"非 JSON Schema 标准字段"的约定，序列化时剔除，保证发给 LLM 的是干净的标准 schema。

`Type.Optional(...)` 做的事就是**把该字段排除出 `required` 数组**，对应到派生类型就是 `offset?: number`。

### 一份定义，两处生效

```
        readSchema（运行时对象）
              ├──→ JSON.stringify 后塞进 HTTP 请求体，告诉 LLM 工具怎么调
              │     （见 openai-completions.ts:1366，注释写着
              │      "TypeBox already generates JSON Schema"）
              └──→ Static<typeof readSchema>，工具实现里 input.path 有补全和检查
```

### 和 Python 的 `@dataclass` / Pydantic 对比

| | `@dataclass` | Pydantic | typebox |
|---|---|---|---|
| 生成 `__init__`/`__repr__` | ✅ 核心功能 | ✅ | ❌ 完全不做 |
| 产出 JSON Schema | ❌ | ✅ `.model_json_schema()` | ✅ **本体就是** |
| 运行时校验 | ❌ | ✅ | 有能力，但 **pi 没用**（只 import 了 `Type`/`Static`/`TSchema`，没导入 `Value`） |

**最接近的是 Pydantic，不是 `@dataclass`。而且派生方向是反的**：

```python
# Python：先有类，再导出 schema（类是运行时对象，可反射）
class ReadInput(BaseModel): path: str
schema = ReadInput.model_json_schema()      # 类 → schema
```

```ts
// TS：先有 schema，再导出类型（类型运行时不存在，无从反射）
const readSchema = Type.Object({ path: Type.String() });
type ReadToolInput = Static<typeof readSchema>;   // schema → 类型
```

**方向必须反过来，是被类型擦除逼的。** 同类库还有 zod（更流行）——pi 选 typebox 是因为它直接产出标准 JSON Schema，而 zod 需要 `zod-to-json-schema` 多转一层，而 LLM 工具定义要的正是 JSON Schema。

---

## 10. 有标注 vs 靠推断

`const a: A = {...}` 和 `const a = {...}` 差在哪。**可运行验证**：[examples/annotation-vs-inference.ts](examples/annotation-vs-inference.ts)

### 形状相同时，两者等价

```ts
const x1: A = { path: "/tmp" };   // 类型 A
const x2   = { path: "/tmp" };    // 推断为 { path: string }，能赋给 A
```

差异出现在下面三种情况。

### ① 缺字段：标注把错误提前到「声明处」

```ts
const y1: A = {};   // ❌ TS2741: Property 'path' is missing
const y2   = {};    // ✅ 不报错，类型就是 {}——等到用的时候才炸
```

出问题时离现场更近，是加标注的主要收益之一。

### ② 多字段：标注触发多余属性检查

```ts
const z1: A = { path: "/t", extra: 1 };   // ❌ TS2353: 'extra' does not exist in type 'A'
const z2   = { path: "/t", extra: 1 };    // ✅ 类型是 { path: string; extra: number }
const z3: A = z2;                          // ✅ 通过——中转后就不查了
```

多余属性检查**只作用于直接字面量赋值**（详见第 3 条）。设计意图是抓 `text` 写成 `txt` 这类拼写错误。

### ③ 字面量拓宽（widening）—— pi 里最要命的一条

```ts
type TextContent = { type: "text"; text: string };

const w2 = { type: "text", text: "hi" };   // 推断为 { type: string; text: string }
//                                                        ↑ "text" 被拓宽成 string
const w3: TextContent = w2;                // ❌ Type 'string' is not assignable to type '"text"'
```

**无标注时字符串字面量会被拓宽成 `string`**（TS 假设你以后可能改这个值）。而 `TextContent.type` 要的是字面量类型 `"text"`，`string` 太宽，赋不回去。

**这直接影响 pi 里所有可辨识联合**（第 4 条）。`w1` 和 `w2` 运行时输出完全一样，差异纯在编译期——所以这个坑不容易发现。

绕过拓宽的两种写法：

```ts
const w4 = { type: "text", text: "hi" } as const;   // 整个对象只读 + 字面量
const w5 = { type: "text" as const, text: "hi" };   // 只锁 type 一个字段
```

### pi 的实际做法

```ts
// openai-completions.ts:274,352 —— 先声明带类型的变量，再赋值
let textBlock: TextContent | null = null;
textBlock = { type: "text", text: "" };     // 有上下文类型，不拓宽

// agent-session.ts:1399 —— 数组加标注，保证元素类型精确
const content: (TextContent | ImageContent)[] = [{ type: "text", text }];

// read.ts:16 —— 不加标注
const readSchema = Type.Object({ ... });
```

最后一个**故意不加**：`Type.Object()` 返回 `TObject<Properties>`，泛型参数已把结构带出来。**加标注反而丢信息**——标成 `TSchema` 的话 `Static<>` 就什么都推不出来了（见第 9 条）。

### 什么时候加

| 场景 | 建议 |
|---|---|
| 值要参与**可辨识联合** | **必须加**，否则字面量被拓宽 |
| 想让错误早点暴露 | 加 |
| 想启用多余属性检查 | 加 |
| 函数返回值（对外契约） | 通常加 |
| 局部临时变量、类型显而易见 | 不加，让推断做事 |
| 返回值已带精确泛型（如 `Type.Object()`） | **不加**，加了丢信息 |

---

## 11. 穷尽性检查：`const _exhaustive: never = m`

pi 里 9 处，出处如 `coding-agent/src/core/messages.ts:190`、`agent/src/proxy.ts:364`。

```ts
switch (m.role) {
	case "user":       return ...;
	case "assistant":  return ...;
	case "toolResult": return ...;
	default:
		const _exhaustiveCheck: never = m;   // ← 编译期断言
		return undefined;
}
```

**机制**：`never` 是空类型，没有任何值属于它。`switch` 每处理一个 `case`，TS 就从 `m` 的类型里减去那一支：

| 位置 | `m` 的类型 |
|---|---|
| `case "user"` 内 | `{ role: "user"; ... }` |
| `default` 内（全处理完） | `never` → 赋值成功 ✅ |
| `default` 内（漏了一支） | 剩下那支 → 赋值失败 ❌ |

报错会**直接点名漏掉的是哪一个**：`Type 'ReminderMessage' is not assignable to type 'never'`。

**三个部分**：变量名随意（`_` 开头是"故意不用"的约定）；`: never` 才是干活的；`= m` 提供待检查的类型。

**运行时它还在**：`const _exhaustive: never = m` 编译成 `const _exhaustive = m`——只有标注被擦除，赋值语句是值空间的（第 1 条判据）。这是一行永不执行的死代码，所以 pi 加了 `// biome-ignore lint/correctness/noSwitchDeclarations: fine`。

**价值**：把"加新类型时忘了更新某处"从线上 bug 变成编译失败。这是纯 JS 无法表达的东西——JS 里新类型会静默走 `default`，信息悄悄丢失。

---

## 12. `keyof` + 索引访问 + 声明合并 = 开放式联合

pi 用这三样组合出了消息类型的扩展机制，值得整套抄。

### `keyof T` 与 `T[K]`

```ts
interface CustomAgentMessages {
	bashExecution:     BashExecutionMessage;
	custom:            CustomMessage;
	branchSummary:     BranchSummaryMessage;
	compactionSummary: CompactionSummaryMessage;
}

keyof CustomAgentMessages
// = "bashExecution" | "custom" | "branchSummary" | "compactionSummary"

CustomAgentMessages["custom"]                    // → CustomMessage（索引访问）
CustomAgentMessages["custom" | "branchSummary"]  // → CustomMessage | BranchSummaryMessage
//                                                   索引访问对联合会「分配」
```

所以 `T[keyof T]` 的含义是——**取出接口所有值类型的联合**。实测展开结果：

```
CustomAgentMessages[keyof CustomAgentMessages]
  = CustomMessage<unknown> | BashExecutionMessage | BranchSummaryMessage | CompactionSummaryMessage
```

### 开放式联合的完整套路

`packages/agent/src/types.ts:316,325`：

```ts
export interface CustomAgentMessages {}                                    // 空的注册表
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

下游注册（`coding-agent/src/core/messages.ts:69`）：

```ts
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
	}
}
```

**为什么要绕这一圈**：那些消息类型定义在 coding-agent 里，agent 包不认识也不该认识（依赖方向是 coding-agent → agent，反过来就循环了）。空接口 + `T[keyof T]` 让底层包说出"所有注册进来的都算一支"，而无需知道注册了什么。

### 声明合并 ≠ 继承

| | 继承 `extends` | 声明合并 `declare module` |
|---|---|---|
| 产生什么 | **新类型**，原类型不变 | **修改原类型本身** |
| 影响范围 | 只有子类 | **全局**，所有引用处 |
| 原包能否感知 | 感知不到 | 被动接受，无法拒绝 |

继承是"基于你造个新的"，声明合并是"**伸手进你家里加个字段**"。

实测：在 coding-agent 里注册第 5 种消息 `reminder`，**agent 包内部的 `AgentMessage` 也跟着变**——而 agent 包对 coding-agent 一无所知。继承做不到。

### 路径要和 import 一致

```ts
// 包内部（agent/src/harness/messages.ts:53）
declare module "../types.ts" { ... }                      // 相对路径

// 跨包（coding-agent/src/core/messages.ts:69）
declare module "@earendil-works/pi-agent-core" { ... }    // 包名
```

`declare module` 按**模块说明符**匹配，所以路径必须和 `import` 时写的字符串一致。

### 只有 `interface` 能合并

```ts
interface I { a: number }
interface I { b: string }   // ✅ 合并成 { a: number; b: string }

type T = { a: number }
type T = { b: string }      // ❌ 重复标识符
```

**这就是 pi 在扩展点用 `interface` 而非 `type` 的原因**——可合并性正是扩展机制的实现基础。

> Python 类比：最接近的是猴子补丁（`somelib.SomeClass.new_field = ...`），但有本质差别——猴子补丁在**运行时**改行为，声明合并**只在类型层**，编译后什么都不剩，不改变任何运行时行为。

### 两条链路合起来

```
declare module 注册新消息
      ↓
AgentMessage = Message | CustomAgentMessages[keyof ...]   自动多一支
      ↓
convertToLlm 的 switch 没有对应 case
      ↓
messages.ts:190 的 never 断言 ❌ 编译失败，并点名缺哪个
```

**agent 包提供开放扩展点，coding-agent 用 `never` 断言给自己上锁**——可以自由加消息类型，但加了就必须说明"它怎么变成 LLM 能懂的形式"。没有这行断言，新类型会静默走 `default` 返回 `undefined` 被 `filter` 掉，LLM 永远看不到，且无任何报错。

---

## 13. `static` 的三种含义 + 静态工厂方法

**可运行验证**：[examples/static-factory.ts](examples/static-factory.ts)

### ⚠️ 先消歧：三个 static 互不相干

| 写法 | 是什么 | 来源 |
|---|---|---|
| `static` 小写关键字 | 类的静态成员 | TS/JS 语言 |
| `Static<T>` 大写泛型 | 从 typebox schema 提取编译期类型（第 9 条） | **typebox 库**，需 import |
| C 的 `static` | 存储期 / 链接性 | 与前两者都无关 |

typebox 用 `Static` 这个词，取的是 **static typing（静态类型）** 里的"静态"——**编译期已知**，对应"动态"（运行时才知道）。和"静态成员"毫无关系。

### `static` 成员：挂在类上，不在实例上

```ts
class Runtime {
	static readonly VERSION = "1.0";   // 静态字段
	private static instances = 0;      // 私有静态字段，全类共享
	private readonly config: string;   // 实例字段

	static async create(...) { }       // 静态方法
	static { /* 静态初始化块，ES2022 */ }
}

Runtime.VERSION      // ✅ 从类上访问
new Runtime().VERSION // ❌ TS2339: 实例上没有
```

**关键：`static` 成员是运行时真实存在的**（挂在构造函数对象上），属于**值空间**。对比同一行的 `implements Models`——那部分纯属类型空间，编译后消失：

```ts
export class ModelRuntime implements Models { static async create() {} }
// 编译后：export class ModelRuntime { static async create() {} }
//                                  ↑ implements 整段蒸发，static 原样保留
```

**一行代码，一半保留一半蒸发**（第 1 条的判据）。

静态方法里的 `this` 指向类本身，所以 `new this(...)` 可行；pi 直接写 `new ModelRuntime(...)`，更明确。

### 静态工厂方法：pi 的 `ModelRuntime.create()`

`core/model-runtime.ts:154,172`：

```ts
private constructor(...)                          // 154：私有，外部造不出来
static async create(...): Promise<ModelRuntime>   // 172：唯一入口
```

**为什么必须异步**——构造函数不能 `async`（必须返回实例，不能返回 Promise），而 `create()` 里有：

| 工作 | 能否同步 |
|---|---|
| 读 `models.json` | ✅ `readFileSync` 可以 |
| **联网刷新模型目录**（`model-runtime.ts:205` 的 `await runtime.refresh(...)`） | ❌ **不可能** |
| 读凭证（钥匙串 / OAuth 刷新） | ❌ 通常也不行 |

**Node 里网络 I/O 没有同步形态**（没有 `fetchSync`）。只要这一步存在，`create()` 就必须 async，无从选择。还有 `model-runtime.ts:200-207` 那套 `AbortController` + `setTimeout` 超时取消——同步调用没法"等 3 秒还没好就放弃"。

**"逻辑上阻塞" ≠ "阻塞线程"**：

```
await create()          当前逻辑等待，事件循环空闲，其他启动任务可并发
readFileSync + 同步网络   整个进程卡死
```

pi 启动时并行做很多事（加载设置、扫扩展、检查项目信任、读会话历史），同步 I/O 会强制串行。

**为什么不用 `new` + `init()`**：

```ts
const rt = new Runtime();   // 同步造空壳
await rt.init();            // 再异步初始化
```

会留下「拿到实例但还不能用」的窗口期，调用方可能忘记 `await init()`。`private constructor` + `static async create` **在类型层面杜绝了这种状态**——能拿到实例，就意味着它准备好了。这是"用类型和可见性让非法状态不可表达"的又一例。

### ⚠️ 这不是 GoF 的「工厂模式」

| | GoF **工厂方法模式** | 这里的**静态工厂方法** |
|---|---|---|
| 目的 | 让**子类**决定实例化哪个类 | 给构造过程一个有名字的入口 |
| 结构 | 抽象方法 + 多个子类实现 | 一个静态方法 |
| 返回 | 接口/基类，具体类型可变 | **就是自己这个类** |
| 出处 | GoF《设计模式》 | Effective Java 第 1 条 |

`ModelRuntime.create()` 总是返回 `ModelRuntime`，无子类、无多态选择——是**静态工厂方法**，不是 GoF 工厂模式。中文语境里"工厂模式"常被泛化，区分的意义在于：GoF 工厂方法为了**多态和扩展性**，静态工厂方法为了**构造过程的可控性**。

pi 里同套路的还有 `ModelConfig.load()`、`SettingsManager.create()`、`SessionManager.inMemory()`。

### `extends` / `implements` 和 Java 的差异

| | Java | TypeScript |
|---|---|---|
| `class A extends B` | 继承，单继承 | 一致 |
| `class A implements I` | **必须写**，否则类型关系不存在 | **可以不写**，写了只是编译期断言 |
| `interface I extends J` | 接口继承 | 一致 |
| `<T extends X>` 泛型约束 | 有界类型参数 | 一致，读作"必须满足"（第 2 条） |

差异源于**名义类型 vs 结构类型**（第 3 条）。TS 里类只要形状对上，不写 `implements` 也自动满足接口：

```ts
interface Greeter { greet(): string }
class A implements Greeter { greet() { return "A"; } }
class B                     { greet() { return "B"; } }   // 没写 implements

const g1: Greeter = new A();   // ✅
const g2: Greeter = new B();   // ✅ 照样能过
class C implements Greeter { greett() {...} }  // ❌ TS2420，拼错方法名被抓住
```

**TS 的 `implements` 是「自检」而非「注册」**。`export class ModelRuntime implements Models` 去掉照样能跑，它的价值是：哪天 `Models` 接口加了方法而 `ModelRuntime` 没跟上，**这里立刻报错**。

---

## 待补

遇到再加：

- `satisfies` 运算符（`openrouter-images.ts:93` 用到）
- 条件类型 / `infer`（`Static<>` 内部大量使用，见第 9 条）
- 映射类型 `[P in K]`（`Record<K,V>` 的实现原理，与第 12 条的 `keyof` 是一套机制的两面）
- `asserts` 断言函数
- 模块解析与 `.ts` 后缀导入（pi 用的 Node strip-only 模式，见 `AGENTS.md`）
