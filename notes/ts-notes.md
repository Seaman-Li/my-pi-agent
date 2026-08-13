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

**跨越两个空间的桥梁**：

- `typeof value` —— 从**值**反推**类型**（注意：与 JS 运行时的 `typeof` 是两回事，只是长得一样）
- `Static<T>` —— typebox 提供，把 schema 类型转成普通 TS 类型

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

## 待补

遇到再加：

- `satisfies` 运算符（`openrouter-images.ts:93` 用到）
- 条件类型 / 映射类型（`ApiOptionsMap`、`ApiStreamOptions<TApi>` 里有）
- `asserts` 断言函数
- 模块解析与 `.ts` 后缀导入（pi 用的 Node strip-only 模式，见 `AGENTS.md`）
