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

## 14. TS 与 Python 的严格性：分布在不同阶段

读了几天的直觉是「TS 比 Python 严格得多」。**只对一半**——两者的严格性在不同阶段。

| | 编译期 | 运行期 |
|---|---|---|
| **TypeScript** | ⭐⭐⭐ 严格 | **零检查**，静默产出 `undefined` / `NaN` |
| **Python** | 默认**完全不检查**（标注被忽略） | ⭐⭐⭐ 立刻抛 `KeyError` / `AttributeError` |

### 实证

```ts
interface User { name: string; age: number }
const raw: unknown = { name: "simon" };   // 缺 age
const user = raw as User;                  // 断言：我说它是 User

console.log(user.age);      // undefined
console.log(user.age + 1);  // NaN
```

**类型检查全绿，运行时静默产出 `NaN`。** 同样的错误在 Python：

```python
raw = {'name': 'simon'}
raw['age'] + 1          # KeyError: 'age'      ← 立刻炸

class User:
    def __init__(self, name): self.name = name
User('simon').age       # AttributeError       ← 立刻炸

def f(x: int) -> int: return x
f("字符串")              # '字符串'  ← 标注被完全忽略，不报错
```

### 三个让 TS 没那么严的因素

**① 类型会撒谎**——逃生舱有一整套：

```ts
value as T      // 断言：我说是就是
value!          // 非空断言
: any           // 彻底放弃检查
// @ts-ignore   // 直接闭嘴
```

`AGENTS.md` 禁 `any`，正因为一个口子就能打穿整个类型系统。而 Python 里**骗不过运行时**——属性不存在就是不存在。

**② JS 底座本身极宽松**，TS 管不了：`"1" + 1 === "11"`、`[] == false`、`undefined + 1 === NaN`。

**③ 外部数据零保护**：`JSON.parse()` 返回 `any`，API 响应、用户输入、读文件——**类型系统对边界之外一无所知**。

> 这正是 pi 必须用 typebox 的根本原因（第 9 条）：TS 的类型在运行时保护不了工具参数这个边界。

### 反过来，Python 也没那么松

mypy / pyright 开严格模式后表达力和 TS 接近，`Literal` / `TypedDict` / `Protocol` 一应俱全。差别在**默认值**：

| | 默认状态 |
|---|---|
| TS | 类型检查**内建**，不写标注也推断，编译不过不给跑 |
| Python | 标注**默认纯装饰**，要额外装 mypy 并主动跑 |

**是「默认开」和「默认关」的区别，不是「有」和「没有」的区别。**

### 实用结论：两边姿势一样

```
外部数据 ──→ [运行时校验] ──→ 内部代码
                 │                │
   TS:      typebox / zod      静态类型
 Python:    Pydantic           mypy 标注
```

pi 就是这么做的：`packages/ai` 内部全靠 TS 类型，工具参数这个边界用 typebox schema 兜住。

**一句话**：TS 给的是「写代码时的严格」，Python 给的是「跑起来时的诚实」。前者能在改 4 万行代码时救你，后者能在数据不对时立刻告诉你。**两者都不能替代边界处的运行时校验。**

---

## 15. Promise：四条心智模型

前两条是**类型层面**，后两条是**运行时层面**。四条互不相干，不要互相推导。

```
① Promise<T> 里的 T = 未来 resolve 出来的值的类型，不是 Promise 自身的类型
② await 只剥壳，对非 Promise 恒等  → 所以 Promise<T> | T 这种签名可行
③ Promise 是急切的：函数一调用就在跑，await 只负责等，不负责启动（≠ Python 协程）
④ 想「先排队后开跑」只能包 thunk（agent-loop.ts:522）
```

---

### ① `Promise<T>` 的 `T` 是脱壳后的类型

```ts
const p: Promise<string | undefined> = keychain.get("pi-dashscope");
//    ↑ p 本身是 Promise 对象，现在就有
const v: string | undefined = await p;
//    ↑ v 是等到之后的值
```

对比 Python——说的是同一件事，但**壳的位置不同**：

| | 声明写什么 | 实际返回的对象 |
|---|---|---|
| Python | `async def f() -> str \| None` | coroutine |
| TS | `function f(): Promise<string \| undefined>` | Promise |

**Python 的返回标注是「脱壳后」的，TS 的是「带壳」的。** 所以 TS 能写出 `Promise<T> | T` 这种签名（壳在类型里，可以选择性地不要），Python 没法在一个签名里表达「可能是 coroutine 也可能不是」。

### ② `await` 只剥壳，对非 Promise 恒等

类型规则叫 `Awaited<T>`：

```ts
type A = Awaited<Promise<string>>;   // string
type B = Awaited<string>;            // string   ← 非 Promise 原样返回
```

对联合类型**逐支处理再合并去重**：

```
       Promise<string | undefined>  |  string  |  undefined
await       ↓                          ↓          ↓
         string | undefined         |  string  |  undefined
                              合并 → string | undefined
```

**正因为「非 Promise 原样返回」，一个 `await` 才能吃掉同步和异步两种实现**：

```ts
// agent.ts:103
getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

// agent-loop.ts:306  —— 实现方写 async 也行，写普通函数也行
const k = config.getApiKey ? await config.getApiKey(provider) : undefined;
```

三支各对应一类实现：

| 支 | 实现形态 | 例子 |
|---|---|---|
| `Promise<string \| undefined>` | 异步查 | 读钥匙串、刷 OAuth、发 HTTP |
| `string` | 同步立刻有 | 从内存 Map 读 |
| `undefined` | 明确表示「我没有」 | 让下游自己解析 |

**三支的存在是为了不强迫实现方 `async`。** 只写 `Promise<string>` 的话，「我内存里就有」的实现也得包一层 `async`，白付一次微任务调度。和第 17 条的 `Promise<void> | void` 是同一个设计动机。

### 忘写 `await` 会怎样

```ts
const k = config.getApiKey?.("p");        // 类型里还留着 Promise<...> 那一支
streamFunction({ ...config, apiKey: k }); // ❌ 编译报错：Promise 不能赋给 string
```

**`apiKey?: string` 这个标注就是防线，TS 拦得住。** 实测只有值经过 `any` 才会溜到运行时：

```ts
const k = config.getApiKey?.("p") as any;
streamFunction({ ...config, apiKey: k });   // ✅ 编译通过
```

那时 Promise 对象被当字符串用，请求头变成 `Bearer [object Promise]`，provider 返回 **401**。**不是无声失败，是症状指向错误方向**——你会去查钥匙串、查 key 过期没有，而真正原因是少写一个 `await`。「报错但报错原因误导」比完全无声更难查。

注意这个 bug 和第 ③ 条（急切性）**无关**。Python 同样会犯（`k = get_api_key(p)` 拿到 coroutine），而且 Python 还多一层 `RuntimeWarning: coroutine was never awaited`。**TS 靠类型拦，Python 靠运行时警告拦，两边都有防线。**

---

### ③④ 运行时层面：Promise 是急切的（Python 直觉会出错）

Promise 是"值还没到，但迟早会到"的占位对象，三种状态不可逆：

```
pending ──┬──→ fulfilled（有值）  ← await 拿到它
          └──→ rejected （有错）  ← await 抛出它
```

`async`/`await` 的写法和 Python 几乎一样，对应关系：

| Python | JS |
|---|---|
| `async def f()` | `async function f()` |
| `asyncio.gather(a, b)` | `Promise.all([a, b])` |
| `asyncio.Future` | `Promise` |

### 唯一必须记的差异

**Python 的协程是懒的**——调用不等于开始：

```python
c = fetch(url)      # 什么都没发生，只造了个 coroutine 对象
await c             # 到这里才真正开始执行
```

**JS 的 Promise 是急的**——函数一调用就已经在跑了：

```js
const p = fetch(url);   // ← 请求此刻已经发出去了
await p;                // 只是「等它结束」，不是「让它开始」
```

> `await` 在 JS 里**只负责等待，不负责启动**。

验证：

```bash
node -e '
const mk = n => new Promise(r => { console.log("开始", n); setTimeout(() => r(n), 100) });
const eager = [mk(1), mk(2)];              // 立刻打印「开始 1」「开始 2」
console.log("--- 数组构造完了 ---");
const lazy  = [() => mk(3), () => mk(4)];  // 什么都不打印
console.log("--- thunk 数组构造完了 ---");
Promise.all(lazy.map(f => f()));           // 此刻才打印「开始 3」「开始 4」
'
```

### 后果：JS 需要 thunk，Python 不需要

想「先排好队、之后再一起开跑」，JS 只能包一层函数（**thunk**，延迟求值的壳）。这就是 [agent-loop.md](agent-loop.md) 里 `agent-loop.ts:522` 的写法：

```ts
finalizedCalls.push(async () => { ... });   // :522 推的是「函数」，此刻不执行
const ordered = await Promise.all(          // :540 这里才调用它们
  finalizedCalls.map(e => typeof e === "function" ? e() : Promise.resolve(e)));
```

直接推 Promise 就废了：`for` 循环还在逐个做权限确认，前面已确认的工具早跑起来了——「准备串行、执行并行」的设计不成立。

### `Promise.all` 的两个性质

- **保序**：`results[0]` 永远对应 `p1`，与谁先完成无关
- **快速失败**：任一 reject，整体立刻 reject

agent-loop 敢用它，正因为工具错误从不 reject（都被 catch 成正常返回值）。**两个设计是配套的。**

---

## 16. `void` 运算符：故意丢弃一个 Promise

```ts
// agent-loop.ts:40
void runAgentLoop(prompts, context, config, emit, signal, streamFn)
    .then((messages) => { stream.end(messages); });
```

这里的 `void` **不是返回类型 `void`**，是一元运算符：求值右边的表达式，然后丢弃结果、返回 `undefined`。

三个 `void` 的区别（又一组同名不同物，参考第 13 条的 `static`）：

| 写法 | 空间 | 含义 |
|---|---|---|
| `function f(): void` | 类型 | 返回类型：没有有意义的返回值 |
| `void expr` | 值 | 运算符：算完丢掉 |
| `void 0` | 值 | 拿 `undefined` 的老写法（压缩器爱用） |

优先级：`void` 是 14，`.` 和函数调用是 17，所以 `void a().then(b)` 解析成 `void ((a()).then(b))`——**整条链被丢弃，不是只丢 `a()`**。

### 为什么要写它

不写 `void` 代码也能跑，写它是给**人和 lint 看的信号**：

> 「我知道这是个 Promise，我是**故意**不 await 的。」

这类没人接住的 Promise 叫 **floating promise**。危险在于它 reject 时会变成 `unhandledRejection`，Node 默认直接终止进程。写 `void` 相当于留个记号——但**记号本身不提供任何保护**。

pi 里 `void` 用了十几处，写法分两类：

```ts
void this.refresh({ allowNetwork: false });          // model-runtime.ts:739  裸丢，失败即崩
void rawStdoutWriteTail.catch(() => {});             // output-guard.ts:90    带 catch，安全
void waitForChildProcess(child).then(ok, err);       // env/nodejs.ts:481     两个回调都给了
```

**只有后两种是真安全的。** `void X` 本身不吞异常——想安全就必须自己接上 `.catch()`。

Python 里的对应物是 `asyncio.create_task(coro)` 而不加引用：同样的悬空问题，同样需要显式处理异常。

---

## 17. `=>` 在两个空间里是两个东西（函数类型 vs 箭头函数）

```ts
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
```

**这不是 lambda，是一个类型。** 它描述"函数长什么样"，不产生任何函数。

判别方法还是第 1 条那套——看 `=` 左边是 `type` 还是 `const`：

```ts
type F  = (x: number) => string;    // 类型空间：描述形状，编译后整行消失
const f = (x: number) => "hi";      // 值空间：真造了个函数，运行时存在
```

同样的 `(...) => ...` 写法，一个是名词（"这种函数"），一个是动词（"造一个函数"）。**`type X = ` 之后的一切都在类型空间**，所以 `AgentEventSink` 里的箭头只是语法借用。

对应 Python：

```python
AgentEventSink = Callable[[AgentEvent], Awaitable[None] | None]   # 类型
sink = lambda event: None                                          # 值
```

Python 用两套完全不同的写法（`Callable[...]` vs `lambda`），TS 复用同一套符号——**这是 TS 更容易搞混的地方，也是必须靠位置判别的原因。**

### 整个箭头才是一个类型（别把返回部分当成整体）

容易读错成"`EventSink` 是 `Promise<void>|void` 类型，只是带个入参"。**不是。**

```ts
type EventSink = (event: Ev) => Promise<void> | void;
//               └──────────────────────────────────┘
//                    这一整串 = 一个类型：「函数」
```

`Promise<void>|void` 只是**返回部分**，是零件不是整体。类比：

```ts
type Point = { x: number; y: number };
```

不会说"Point 是 number 类型但带 x 和 y"。Point 是**对象**类型，number 是字段类型。同理 EventSink 是**函数**类型。

```ts
const a: EventSink = (e) => {};          // ✅ 必须是函数
const c: EventSink = Promise.resolve();  // ❌ TS2322
const r = a(someEvent);                  // r 的类型才是 Promise<void> | void
```

三层结构：

```
EventSink                        ← 函数类型
├── 参数：event: Ev               ← 输入
└── 返回：Promise<void> | void    ← 输出（联合在这一层内部）
```

### 返回类型是贪婪的

```ts
(event: AgentEvent) => Promise<void> | void
```

读作 `(event) => (Promise<void> | void)`，**不是** `((event) => Promise<void>) | void`。

函数类型的返回部分**一直向右吃到底**。想切断必须加括号：

```ts
type A = ((e: E) => Promise<void>) | void;   // 「函数」或「void」，完全不同的东西
```

和第 5 条 `(TextContent | ImageContent)[]` 是同一类优先级坑：**联合在类型里没有想当然的边界，看不清就补括号。**

### 参数名是文档；参数可以少写，不能多写

实测（两处 `@ts-expect-error` 都真实触发，`tsc` 通过）：

```ts
type Ev = { type: string };
type EventSink = (event: Ev) => Promise<void> | void;

const a: EventSink = (whatever) => { void whatever; };   // ✅ 参数名随便叫
const b: EventSink = () => {};                            // ✅ 少写参数也行
// @ts-expect-error 不是函数
const c: EventSink = Promise.resolve();
// @ts-expect-error 多出来的参数不行
const d: EventSink = (e: Ev, extra: number) => { void e; void extra; };
```

**① 类型里的参数名纯属文档。** `event` 这个名字不参与任何匹配，实现方叫 `e` / `whatever` / `x` 都行。TS 的函数类型**按位置**匹配——不像 Python 的关键字参数，名字在这里没有语义。

**② 可以少写参数，不能多写。** 调用方传了你不接，没问题；你要求的调用方没有，才是问题。`arr.map(x => x * 2)` 能省略 `index`、`array` 两个参数，就是同一条规则。

（注意别把类型名起作 `Event`——它和 DOM lib 的全局 `Event` 撞名，报 `TS2300: Duplicate identifier`。）

### `Promise<void> | void` 为什么这么写

意思是"**同步异步都行**"。实现方可以两种都写：

```ts
const a: AgentEventSink = (e) => { console.log(e); };          // 同步，返回 void
const b: AgentEventSink = async (e) => { await save(e); };     // 异步，返回 Promise<void>
```

调用方统一 `await emit(...)` 就能兼容两者——**`await` 一个非 Promise 值是合法的**，它会立即 resolve（只让出一个微任务 tick）：

```bash
node -e 'const f = () => 42; (async () => { console.log(await f()) })()'   # 42
```

pi 靠这一条同时支持两类消费者：`Agent.processEvents` 是真 async（有背压），`stream.push` 是同步 void（无背压）。见 [agent-loop.md](agent-loop.md) 第七节。

---

## 18. `satisfies`：既要检查，又不要拓宽

### 它解决什么

标注和推断各有一半缺陷（见第 10 条）：

```ts
const a: FinalizedToolCallOutcome = { toolCall, result, isError };
//    ↑ 检查了，但 a 的类型被"压平"成 FinalizedToolCallOutcome，具体信息丢了

const b = { toolCall, result, isError };
//    ↑ 保留了具体类型，但拼错字段名不会被发现
```

`satisfies` 两个都要——**检查形状，但保留推断出的具体类型**：

```ts
// agent-loop.ts:513
const finalized = {
	toolCall,
	result: preparation.result,
	isError: preparation.isError,
} satisfies FinalizedToolCallOutcome;
```

写错字段名立刻报错；同时 `finalized` 的类型仍是那个精确的对象字面量类型，不是被拓宽的接口。

### 经典组合 `as const satisfies`

```ts
// harness/telemetry.ts:118
} as const satisfies TelemetrySchemaDefinition;
```

`as const` 保住字面量类型（`"turn_start"` 而不是 `string`），`satisfies` 保证整体符合 schema。**两个都不用 `:` 标注,因为标注会把 `as const` 的效果抹掉。**

### 和 `as` 的区别

```ts
const x = {...} as T;          // 断言：我说是 T 就是 T，编译器不查
const y = {...} satisfies T;   // 校验：编译器查，不符合就报错
```

`as` 是**闭嘴**，`satisfies` 是**核对**。pi 里有一处两个连用：

```ts
// proxy.ts:319
} satisfies ToolCall & { partialJson: string } as ToolCall;
//  ↑ 先校验多带了 partialJson 的完整形状     ↑ 再抹掉多余字段对外宣称是 ToolCall
```

**先证明自己是对的，再降级暴露。** 这个顺序不能反。

---

## 19. 条件类型与 `infer`

### 条件类型 = 类型层面的三元表达式

```ts
A extends B ? X : Y
```

`Model.compat`（`ai/src/types.ts:805`）是最直观的例子——**同一个字段，类型随 `api` 变化**：

```ts
compat?: TApi extends "openai-completions"
	? OpenAICompletionsCompat
	: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
		? OpenAIResponsesCompat
		: TApi extends "anthropic-messages"
			? AnthropicMessagesCompat
			: TApi extends "bedrock-converse-stream"
				? BedrockCompat
				: never;
```

嵌套条件类型就是 `else if` 链，末尾的 `never` 是"都不匹配"。所以你写 dashscope（`api: "openai-completions"`）的配置时，IDE 只提示 `OpenAICompletionsCompat` 那几个字段。

### `infer` = 在条件里给匹配到的部分起个名

```ts
// ai/src/providers/all.ts:58
type ModelApi<TProvider, TModelId> =
	(typeof MODELS)[TProvider][TModelId] extends { api: infer TApi }
		? (TApi extends Api ? TApi : never)
		: never;
```

读法：**"如果这个模型的类型长得像 `{ api: 某某 }`，把那个『某某』叫做 `TApi`"**。

`infer` 只能出现在 `extends` 右边，作用域是 `?` 之后的分支。这就是 `Static<>`（第 9 条）内部的机制——从 typebox 的 schema 值类型里把对应的 TS 类型"抠"出来。

Python 没有直接对应物。最近的类比是 `TypeVar` + 结构匹配，但 Python 的类型系统不能在类型层面做分支计算。

---

## 20. 映射类型 `[K in ...]`

### `Record` 和 `Partial` 都是它做的

```ts
type Record<K extends keyof any, T> = { [P in K]: T };
type Partial<T> = { [P in keyof T]?: T[P] };
```

所以第 6 条那个 `ThinkingLevelMap`：

```ts
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
```

展开后就是 `{ off?: string|null; minimal?: string|null; ... }` —— **七个键各自可选**。三态（缺省 / `null` / 字符串）的来源就在这。

### 仓库里最值得读的 27 行

`ai/src/model-catalog.ts` 全文只有 27 行，把映射类型、`keyof`、索引访问、条件类型、`const` 类型参数全用上了：

```ts
type ModelId<TGroups extends ModelGroups> = {
	[TApi in keyof TGroups]: keyof TGroups[TApi];
}[keyof TGroups] & string;
```

拆开读：

1. `{ [TApi in keyof TGroups]: keyof TGroups[TApi] }` —— 造一个"每个 api → 它下面所有 model id"的中间对象类型
2. `[keyof TGroups]` —— 用索引访问把所有值**并成一个联合**（第 12 条那个套路）
3. `& string` —— 收窄成字符串

**"造一个临时对象类型，再用 `[keyof T]` 把它的值全部取出来变成联合"是类型体操最常见的手法**，值得记住形状。

`-?` 这类修饰符也在仓库里出现过（`telemetry/src/index.ts:115`），意思是"去掉可选标记"，反向操作是 `+?`。

---

## 21. `asserts`：给运行时检查加上类型收窄

全仓只有一处（`ai/src/api/openai-codex-responses.ts:117`）：

```ts
type SuccessfulAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };

function assertSuccessfulOutput(output: AssistantMessage): asserts output is SuccessfulAssistantMessage {
	if (output.stopReason === "pending") throw new Error("Codex stream ended without a stop reason");
	if (output.stopReason === "error" || output.stopReason === "aborted")
		throw new Error(output.errorMessage || "An unknown error occurred");
}
```

调用之后，**编译器认为 `output.stopReason` 只剩三种可能**：

```ts
assertSuccessfulOutput(output);
// 这行之后 output 的类型自动变窄，不需要 if 包裹
```

和类型守卫（`x is T`）的区别：

| | 写法 | 不满足时 |
|---|---|---|
| 类型守卫 | `function isX(v): v is X` | 返回 `false`，调用方自己分支 |
| 断言函数 | `function assertX(v): asserts v is X` | **抛异常**，之后的代码直接享受窄类型 |

⚠️ **两个坑**：

1. **不能是"靠推断拿到类型"的函数**。写成箭头函数赋给 `const` 时，**调用点**会报错（不是声明处）：

   ```ts
   const assertArrow = (x: { s: string }): asserts x is Ok => { ... };
   assertArrow(y);   // ❌ TS2775: Assertions require every name in the call target
                     //    to be declared with an explicit type annotation
   ```

   修法是给 `const` 本身加类型标注，或者干脆用 `function` 声明——pi 那处就是 `function`。
2. **编译器完全信任你**。函数体里不 throw 也不会被发现，收窄是凭签名给的，不是凭实现验证的。

Python 的 `assert isinstance(x, T)` 在 mypy 下有类似效果，但那是内建行为；TS 的 `asserts` 是把这个能力开放给了自定义函数。

---

## 22. 模块解析：为什么 pi 的 import 都带 `.ts` 后缀

```ts
import { getDefaultStreamFn } from "./stream-fn.ts";   // 带后缀，且是 .ts 不是 .js
```

一般 TS 项目要么不写后缀，要么按 ESM 规范写 `.js`（哪怕源文件是 `.ts`）。pi 直接写 `.ts`，靠 `tsconfig.base.json` 两个选项：

```jsonc
"allowImportingTsExtensions": true,      // 允许 import 里写 .ts
"rewriteRelativeImportExtensions": true, // 编译时把 .ts 改写成 .js
```

**源码里写你实际看到的文件名，构建时自动改写。** 这样 `node --experimental-strip-types` 能直接跑源码（剥掉类型后路径依然有效），`tsc` 构建出的 dist 里路径也正确。

配套的还有：

```jsonc
"module": "NodeNext", "moduleResolution": "NodeNext",   // tsconfig.json:5-6
"erasableSyntaxOnly": true,                              // tsconfig.base.json:7
```

### `erasableSyntaxOnly` 是编译器强制的

第 1 条讲过 `enum` / `namespace` / 参数属性不可擦除。`AGENTS.md:20` 那条规则**不是靠自觉——`erasableSyntaxOnly: true` 会直接报错**：

```
Parameter property is only allowed in a .ts file when 'erasableSyntaxOnly' is disabled.
```

对比一下 `any`：`AGENTS.md:18` 说 "No `any` unless absolutely necessary"，但 `biome.json` 里 `noExplicitAny: "off"`——**那条是约定，这条是强制**（见 [adapter-layer.md](adapter-layer.md) 末尾）。

**同一份 AGENTS.md 里的规则，强制力不一样。** 判断方法：去 `tsconfig` / `biome.json` 里找对应开关，找不到的就是纯约定。

### 自己写示例时的注意

`notes/examples/` 下的文件用 `node --experimental-strip-types` 跑，走的是 Node 的剥离模式而不是 tsconfig，所以：

```bash
# 顶层 await 需要额外标志（见 emit-backpressure.ts 头注释）
npx tsc --noEmit --skipLibCheck --module esnext --target es2022 \
        --moduleResolution bundler notes/examples/X.ts
```

**显式传文件路径时 `tsconfig.json` 是被忽略的**，所有选项得手动给。

---

## 23. `void` 作为返回类型：裸的宽松，联合的严格

从 `harness/agent-harness.ts:211/215` 这一对接口来的——它俩长得几乎一样，
差别只在返回类型：

```ts
export interface Hooks  { on(name: HookName, handler: (e) => unknown | Promise<unknown>, ...): () => void }
export interface Events { on(type: string,   listener: (e) => void    | Promise<void>): () => void }
```

（顺带：`handler` / `listener` 和 `name` / `type` 这些**参数名纯粹是文档**，见第 17 条。
把它们互换，两个接口的行为一个字都不变。）

### 那条著名的宽松规则

TS 有个特例：**目标函数类型的返回类型是 `void` 时，源函数返回什么都放行。**

```ts
const arr: number[] = [];
[1, 2, 3].forEach(x => arr.push(x));   // push 返回 number，forEach 声明的是 void  ✅
```

没这条规则你得写 `x => { arr.push(x); }`——多一对花括号只为丢掉返回值。

规则的含义不是「你不能返回」，是 **「我不会用你的返回值，你爱返回什么返回什么」**。
宽松到连 async 都放行：

```ts
type D = (e: unknown) => void;
const d1: D = (e) => 42;          // ✅ number → void
const d2: D = async (e) => 42;    // ✅ Promise<number> → void
```

### 但一并成联合就失效

5 组隔离实测（`tsc --strict`）：

```ts
type P1 = (e: unknown) => void;               const p1: P1 = (e) => 42;   // ✅
type P2 = (e: unknown) => (void);             const p2: P2 = (e) => 42;   // ✅
type P3 = (e: unknown) => void | void;        const p3: P3 = (e) => 42;   // ✅
type P4 = (e: unknown) => void | undefined;   const p4: P4 = (e) => 42;   // ❌ TS2322
type P5 = (e: unknown) => void | never;       const p5: P5 = (e) => 42;   // ✅
```

分界线是**归约之后还是不是 `void` 本身**：

| 写法 | 归约结果 | 宽松规则 |
|---|---|---|
| `void` / `(void)` | `void` | ✅ 触发 |
| `void \| void` | `void`（重复成员去掉） | ✅ 触发 |
| `void \| never` | `void`（`never` 被吸收） | ✅ 触发 |
| `void \| undefined` | **两个成员的真联合** | ❌ 不触发 |
| `void \| Promise<void>` | **两个成员的真联合** | ❌ 不触发 |

> **触发条件是「目标的返回类型**就是 `void` 这个类型本身**」。
> 一旦是真联合，它就不是 `void` 了，特例不触发，回落到普通赋值检查。**

普通检查：`number` 能赋给 `void | Promise<void>` 吗？逐个试——
`number → void`？不行。`number → Promise<void>`？不行。→ 失败。

### 为什么这条规则只能是「特例」

因为 `void` **不是**万能超类型：

```ts
const v: void = 42;   // ❌ Type 'number' is not assignable to type 'void'
```

`void` 要真是 top type，这行就该通过。它不通过 → **宽松规则没法做进类型格里**，
只能写成「比较函数签名时的一个 if」：

```
比较两个函数类型
  ├─ 比参数
  └─ 比返回类型
       ├─ if (目标返回类型 === void) return true      ← 特例，认的是 void 这个具体类型
       └─ else 普通赋值检查
```

**特例认「精确等于」，不会对联合做分配。**

### pi 为什么还写联合

因为**调用方要 `await`**：

```ts
await emit({ type: "message_start", message });   // agent-loop.ts
```

如果 `AgentEventSink` 写成 `=> void`：

- 注册这头没问题——宽松规则已经能接受 `async` handler
- 但**调用这头** `await` 一个声明为 `void` 的东西语义不对，
  类型上它根本不是 thenable（`await-thenable` 这类 lint 会报）

```
=> void                  宽松，但调用方 await 站不住脚
=> void | Promise<void>  严格，调用方 await 名正言顺   ← pi 用的
```

> **严格性是顺带来的副作用。** 写联合的动机是让调用方能 `await`，
> 结果连带把「别返回值」也变成编译器真拦得住的事——
> 于是 `Events` 的「只能看不能改」不是约定，是类型系统兜住的。

Python 里没有对应物：`Callable[..., None]` 返回别的东西 mypy 直接报错，没有这条特例。

---

## 24. 里氏替换：为什么 `extends` 不能给方法加参数（以及 `Omit &` 这个惯用法）

从 `harness/types.ts:81` 来的——`AgentHarnessTool` 想给 `AgentTool.execute` 加第五个参数：

```ts
export type AgentHarnessTool<TContext, TParameters extends TSchema = TSchema, TDetails = unknown> =
	Omit<AgentTool<TParameters, TDetails>, "execute"> & {
		execute(toolCallId, params, signal, onUpdate, context: TContext): Promise<AgentToolResult<TDetails>>;
	};
```

为什么不直接 `interface AgentHarnessTool extends AgentTool { execute(...5 个参数) }`？

### `extends` 在承诺什么

```ts
interface Ext extends Base
```

意思是 **「任何一个 `Ext` 都可以当 `Base` 用」**。所以判断能不能 extends，
不看 `Ext` 自己怎么用，看——**那些只认识 `Base` 的代码，拿到一个 `Ext` 会怎么调它**。

```ts
function run(t: Base) {
	t.execute("x", 1);      // ← 它只看得见 Base 的签名，就传 2 个
}
```

`Ext.execute` 的第三个参数是**必需的**，实现里一定会用；而 `run` 只传两个 → `undefined` → 炸。

**方向是关键**：不是「函数被调用时能不能多传」，是**「被冒充的那个类型的调用方会传几个」**。

### 跑一遍，真的崩

```js
const base = { execute(a, b)    { console.log("base ok:", a, b); } };
const ext  = { execute(a, b, c) { console.log("ext:", a, b, c.env); } };   // c 必需
function run(t) { t.execute("x", 1); }    // 只传 2 个

run(base);   // base ok: x 1
run(ext);    // 💥 TypeError: Cannot read properties of undefined (reading 'env')
```

**JS 对实参个数不做任何检查**——多传的看不见，少传的悄悄变 `undefined`，
然后在你用它的时候才炸。类型系统是**唯一**能提前拦住的地方。

### 少参数为什么安全

```ts
interface Ext2 extends Base { execute(a: string): void }   // ✅ 通过
```

`run` 传了 `("x", 1)`，`Ext2` 的实现只用 `"x"`，那个 `1` 被忽略。**多传实参在 JS 里完全合法。**

> **少参数 = 我要的比你给的少 → 用不完，没事**
> **多参数 = 我要的比你给的多 → 不够用，炸**

这就是第 17 条「能少不能多」的实际含义。

### 错误信息逐字解读

```
error TS2430: Interface 'Ext' incorrectly extends interface 'Base'.
  Type '(a, b, c: object) => void' is not assignable to type '(a, b) => void'.
    Target signature provides too few arguments. Expected 3 or more, but got 2.
```

- **Target** = 被冒充的那个 = `Base` 的签名
- **provides too few arguments** = `Base` 的调用方只会**提供** 2 个实参
- **Expected 3 or more** = 但你这个函数**期望** 3 个

**主语是「调用方提供得不够」，不是「你的参数太多」。** 看懂主语这句话就顺了。

### 参数个数 vs 参数类型：两条规则不一样

实测（`tsc --strict`）：

```ts
// A. 参数「个数」——两种写法都严格
interface M2 extends M1 { f(a: string, b: object): void }        // 方法简写   ❌ TS2430
interface P2 extends P1 { f: (a: string, b: object) => void }    // 属性写法   ❌ TS2430

// B. 参数「类型」收窄——只有属性写法严格
interface T2 extends T1 { g(x: string): void }        // 方法简写   ✅ 通过（双变特例）
interface U2 extends U1 { g: (x: string) => void }    // 属性写法   ❌ TS2430
```

（原类型是 `(x: string | number) => void`。）

| | 方法简写 `f(a): R` | 属性写法 `f: (a) => R` |
|---|---|---|
| 参数**个数** | 严格 | 严格 |
| 参数**类型** | **宽松（双变，历史遗留的坑）** | 严格逆变（`strictFunctionTypes`） |

> **收窄参数类型同样不安全**（调用方可能传 `number`），但方法简写放行了。
> 这是 TS 为了兼容早期代码留的口子，**不是有意的设计**。

### `Omit<X, "k"> & { k: 新类型 }`：替换字段的惯用法

TS **没有** override 成员的语法。要改一个字段的类型，标准做法是**先减掉，再交叉上新的**：

```ts
Omit<AgentTool<TParameters, TDetails>, "execute">   // 拿掉 execute，其余字段原样保留
& { execute(..., context: TContext): ... }          // 交叉上新的 execute
```

`Omit` 是标准库里的映射类型（第 20 条），展开就是「遍历 `keyof X`，跳过 `"execute"`」。

三件事要记住：

1. **原类型一个字节都没变。** `Omit` 是**产生**一个新类型，不是修改原类型——
   像 `const b = {...a, x: 1}`，`a` 还在。`AgentTool` 别处照用，还是 4 参。
2. **整个是编译期的。** 运行时那个对象只有一个 `execute` 函数，
   JS 里根本不存在 `AgentTool` / `AgentHarnessTool` 这两个名字（第 1 条：类型空间 vs 值空间）。
3. **它不声称是子类型。** 两个类型互不兼容，谁也不能冒充谁。

> **`Omit &` 不是绕过检查的技巧，是如实表达「这两个类型不兼容」。**
> **`extends` 会撒一个谎；`Omit &` 说的是实话**——harness 工具确实不能当普通 `AgentTool` 用。

其他常见变体：

```ts
Omit<T, "a" | "b">                      // 减多个
Partial<T> & Pick<T, "id">              // 除 id 外全可选
Omit<T, keyof U> & U                    // 用 U 覆盖 T 的同名字段（浅合并）
```

### 和 Python 对照：**这条规则两边一样**

容易误以为「Python 子类可以随便加东西」。要分开两件事：

| | Python | TS |
|---|---|---|
| 子类**新增**一个方法 | ✅ 完全 OK | ✅ 完全 OK |
| 子类**覆盖同名方法并加必需参数** | ❌ mypy 报错 | ❌ 编译报错 |

mypy 实测，措辞几乎一样：

```python
class Base:
    def execute(self, a: str, b: int) -> None: ...

class Ext(Base):
    def execute(self, a: str, b: int, c: dict) -> None: ...   # 覆盖，多一个必需参数
    def extra(self) -> None: ...                              # 纯新增
```

```
t.py:6: error: Signature of "execute" incompatible with supertype "Base"  [override]
    Superclass:  def execute(self, a: str, b: int) -> None
    Subclass:    def execute(self, a: str, b: int, c: dict[Any, Any]) -> None
Found 1 error in 1 file
```

**`extra()` 一个字都没报**——纯新增方法没人管。**两边是同一条规则：里氏替换。**

#### 运行时反而是 Python 更严

```
Python:  💥 TypeError: Ext.execute() missing 1 required positional argument: 'c'
JS:      💥 TypeError: Cannot read properties of undefined (reading 'env')
```

| | 什么时候炸 | 报什么 |
|---|---|---|
| Python | **调用那一刻** | 直指病根 |
| JS | **用到那个值**的时候 | 只有症状，得自己回溯 |

**TS 这条类型检查某种意义上是在补 JS 运行时的短板。**

那为什么平时在 Python 里感觉「可以」？——**因为默认没人跑 mypy**。
`Ext` 单独用一切正常，只有「拿 `Ext` 冒充 `Base`」时才炸，而那个场景不一定出现。
TS 这边不存在这个选择：**编译就是检查**。

#### Python 里对应 `Omit &` 的写法

没有 `Omit`，对应的做法是**放弃继承**——用 `Protocol`（结构化类型，不需要继承关系）：

```python
from typing import Protocol

class HarnessTool(Protocol):
    name: str
    description: str
    def execute(self, a: str, b: int, c: dict) -> None: ...
```

或者干脆两个类各写各的。**关键是不声称继承关系。**

---

## 待补

遇到再加：

- 装饰器（`experimentalDecorators: true` 开着，但 `packages/*/src` 里一处未用——大概率是模板残留。注意装饰器**不可擦除**，真用了会和 `erasableSyntaxOnly` 冲突）
- `const` 类型参数（`model-catalog.ts:23` 的 `<const TProvider>`，与第 20 条相关）
- 变型（协变/逆变）的完整规则（第 24 条已覆盖参数个数与方法简写的双变特例，还差返回类型的协变、泛型位置的变型标注）
