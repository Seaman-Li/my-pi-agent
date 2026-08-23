# packages/ 架构地图

> 10 个包，约 11.6 万行 TS。行数统计只算 `src/**/*.ts`（不含 test/dist），基于 `v0.84.1`。
> 目的：知道**每个包负责什么、谁依赖谁、要找某类逻辑该去哪个包**。不求读完。

## 一张图

```
                    ┌──────────────┐
                    │  telemetry   │  935   零依赖，被所有人用
                    └──────────────┘
                           ▲
            ┌──────────────┴───────────────┐
            │                              │
      ┌─────────┐                    ┌──────────┐
      │   ai    │ 22365              │ protocol │ 1236   typebox 定义的线上协议
      │ 模型接入 │                    └──────────┘
      └─────────┘                       ▲     ▲
            ▲                           │     │
            │                    ┌──────────┐ │
      ┌─────────┐                │  client  │ │ 1225
      │  agent  │ 12191          └──────────┘ │
      │ 循环+harness│                  ▲       │
      └─────────┘                      │  ┌────────┐
            ▲                          │  │ server │ 2298
            │        ┌──────┐          │  └────────┘
            └────────┤ tui  │ 16202    │      ▲
                     └──────┘          │      │
                        ▲              │      │
                  ┌─────┴──────────────┴──────┴──┐
                  │        coding-agent          │ 58672
                  │   产品层（bin: pi）           │
                  └──────────────────────────────┘
```

依赖是**严格单向**的，没有回边。验证方式：

```bash
# ai 里 0 处引用 agent；agent 里 0 处引用 coding-agent
grep -rl "@earendil-works/pi-agent-core" packages/ai/src   # → 空
```

| 包 | 被谁引用（文件数） |
|---|---|
| `pi-ai` | agent 17、coding-agent 48、server 1 |
| `pi-agent-core` | coding-agent 32 |
| `pi-tui` | coding-agent 62 |

**`tui` 不依赖 `ai` 也不依赖 `agent`**（→ai:0 →agent:0）——它是纯终端渲染库，对 agent 一无所知，只有 coding-agent 把两边缝在一起。这是本仓库分层最干净的一处证据。

---

## 三个主力包各自装了什么

### `ai`（22365）—— 把 N 家模型收敛成一套概念

| 子目录 | 行 | 内容 |
|---|---|---|
| `api/` | 10736 | **协议适配层**，6 个协议族，见 [adapter-layer.md](adapter-layer.md) |
| `auth/` | 3510 | OAuth / 各家凭证获取 |
| `providers/` | 2430 | 87 个文件，多为生成的 provider 元数据 |
| `utils/` | 1832 | |
| `models.ts` | 944 | 模型目录、能力查询 |
| `types.ts` | 821 | **全仓最基础的类型定义**（Message / Content / Model / Context） |

对外只暴露两件事：**统一的 `Message` 类型**和**统一的流式事件**。上层不知道底下是谁。

### `agent`（12191）—— 循环本体 + harness

| 文件/目录 | 行 | 内容 |
|---|---|---|
| `harness/` | 9824 | 会话持久化、状态归约、压缩、执行环境、内置工具 |
| `agent-loop.ts` | 796 | **主循环**，见 [agent-loop.md](agent-loop.md) |
| `agent.ts` | 592 | Agent 类，包装循环 + 状态 |
| `types.ts` | 443 | AgentMessage / AgentTool / AgentEvent |
| `proxy.ts` | 369 | |

`harness/` 里的重点（Day 6 主线）：

```
reducer.ts        667   事件 → 状态的归约
compaction/       1128  上下文压缩（含 branch-summarization）
session/          2000+ 持久化，JSONL 编解码 + 一致性测试(conformance 993)
env/nodejs.ts     695   执行环境抽象
tools/            1190  内置工具的「参考实现」← 见下方注意
```

`env/` 这个抽象值得注意：工具不直接调 `child_process`，而是通过 `ExecutionEnv`。**这是为了让同一套工具能跑在本地、容器、远端三种环境里。**

### `coding-agent`（58672）—— 占全仓一半的产品层

| 子目录 | 行 | 内容 |
|---|---|---|
| `modes/interactive/` | 17362 | **交互式 TUI 模式**，最大的单块 |
| `core/` | 28640 | 会话、配置、扩展、工具、模型运行时 |
| `utils/` | 3519 | |
| `cli/` | 1814 | 命令行子命令 |
| `modes/rpc/` | 1765 | RPC 模式 |
| `extensions/` | 1414 | |
| `main.ts` | 972 | 入口（那个 400 行的 main 函数在这） |

`core/` 里最大的几个：

```
agent-session.ts     3342  ← 把 agent 循环接到 UI/持久化上
package-manager.ts   2677
extensions/types.ts  1727
session-manager.ts   1714
settings-manager.ts  1272
resource-loader.ts   1096
compaction/          969
model-runtime.ts     787   ← Day 3 读过
model-resolver.ts    775
provider-composer.ts 572
```

三种运行模式并列在 `modes/` 下：`interactive`（默认 TUI）、`rpc`、`print-mode`（169 行，一次性输出）。**同一套 core，三个前端。**

---

## 解决 Day 7 的遗留问题：工具为什么有两份实现

之前发现 `agent/harness/tools/`（1190 行）和 `coding-agent/core/tools/`（4142 行）名字重复。查清楚了：

| | agent 层 | coding-agent 层 |
|---|---|---|
| bash | 161 | 508 |
| read | 144 | 356 |
| edit | 127 | 441 |
| write | 39 | 272 |
| grep/find/ls | **没有** | 390/380/230 |

**不是包装关系，是两套独立实现，服务两类调用方：**

- `coding-agent/core/tools/` → **pi CLI 实际使用的**，带权限确认、TUI 渲染、输出截断、diff 展示
- `agent/harness/tools/` → **给 SDK 使用者的最小实现**，只做事不管展示

唯一同时用到两边的是 `src/server/create-harness.ts`：它从 `pi-agent-core` 拿工具**实现**，却从 `coding-agent/core/tools/` 拿工具的**系统提示词片段**（`bashToolSystemPromptContribution` 等）。

```ts
// server/create-harness.ts:1-18
import { createBashTool, ... } from "@earendil-works/pi-agent-core";   // 实现来自 agent 层
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts"; // 提示词来自产品层
```

注意 `createCodingAgentHarness` **全仓只有 test 在调**（`test/server/create-harness.test.ts`），src 里零调用——又一个「符号存在 ≠ 被调用」的例子，它是留给 SDK 使用者的对外入口。查法：

```bash
grep -rn "createCodingAgentHarness" packages | grep -v node_modules | grep -v dist
```

**结论：agent 层的 tools 是"给别人用的参考实现"，coding-agent 层的是"pi 自己用的完整版"。行数差 2–7 倍，差的全是产品化的部分（权限、渲染、截断）。**

> 两个文件夹各自的内部结构、依赖注入手法的差别，见下一节。

---

## `tools/` 两个文件夹的结构

上一节说清了「为什么有两份」，这节说**各自长什么样、依赖注入的手法差在哪**。

### 一个 tool 就是一个对象

没有基类、没有装饰器、没有注册表：

```ts
interface AgentTool extends Tool {
	name: string;
	description: string;      // ← 这两个直接发给 LLM
	parameters: TSchema;      // ← typebox schema，转 JSON Schema 发给 LLM
	label: string;            // UI 显示用
	execute(...): Promise<AgentToolResult>;
	prepareArguments?(args: unknown): Static<TParameters>;   // 可选：兼容垫片
	executionMode?: "sequential" | "parallel";
}                                              // agent/src/types.ts:386
```

**schema 定义一次，用在三处**：

```
xxxSchema ─┬─→ 转 JSON Schema 发给 LLM（工具描述，含 description 文案）
           ├─→ 运行时校验模型传回来的参数
           └─→ Static<typeof xxxSchema> 推出 TS 类型
```

返回值的二分很关键：

```ts
interface AgentToolResult<T> {
	content: (TextContent | ImageContent)[];   // ← 给 LLM 看，进上下文，花 token
	details: T;                                // ← 给 UI / 日志看，LLM 看不到
	usage?: Usage;
	addedToolNames?: string[];                 // ← 工具的执行结果可以引入新工具
	terminate?: boolean;                       // ← 提示循环停下（agent-loop 出口②）
}                                              // agent/src/types.ts:361
```

`execute` 里**不写 try/catch**——注释明说 *"Throw on failure instead of encoding errors in `content`"*，
抛出去由循环包成 error 的 `ToolResultMessage`。

---

### A. `agent/src/harness/tools/`（1190 行，10 文件）

| 文件 | 行 | 职责 |
|---|---|---|
| `edit-diff.ts` | 500 | **模糊匹配 + diff 生成**。13 个导出函数分四组：行尾（`detectLineEnding` / `normalizeToLF` / `restoreLineEndings`）、归一化（`normalizeForFuzzyMatch`）、匹配应用（`fuzzyFindText` / `applyEditsToNormalizedContent` / `applyReplacementsPreservingUnchangedLines`）、输出（`generateUnifiedPatch` / `generateDiffString`）。另有 `stripBom` |
| `bash.ts` | 161 | `createBashTool`。`BashPrepare` 钩子在执行前拦一道（**权限确认挂这**），`BashExecution` 描述一次执行 |
| `read.ts` | 144 | `createReadTool`。schema 三个参数 `path/offset/limit`（分页读）；`ReadImageProcessor` 可插（图片缩放）；输出走 `utils/truncate.ts` 的 `truncateHead` |
| `edit.ts` | 127 | `createEditTool`。schema 是 `{ path, edits: [{oldText, newText}] }` —— **一次多处替换，每处对原文匹配而非增量**（schema 的 description 里写死了这条约束）。还兼容旧的单 `oldText/newText` 形式 |
| `image.ts` | 104 | `detectSupportedImageMimeType`（嗅探 magic bytes）+ `encodeBase64` |
| `file-mutation-queue.ts` | 56 | **同文件写入串行化**。见下方三个设计点 |
| `write.ts` | 39 | `createWriteTool`。**最小完整样本**，整个工具的形状一眼看完 |
| `path-utils.ts` | 30 | **路径容错**。见下方 |
| `index.ts` | 23 | 四个工具的 re-export |
| `tool-context.ts` | 6 | `ExecutionToolContext { env: ExecutionEnv }` —— 内置工具对 context 的最小要求 |

**依赖注入：一个 `ExecutionEnv`，走 `execute` 的第五个参数。**

```ts
async execute(_toolCallId, { path, content }, signal, _onUpdate, { env }) {
	const absolutePath = await resolveToolPath(env, path, signal);
	return withFileMutationQueue(env, absolutePath, async () => {
		getOrThrow(await env.writeFile(absolutePath, content, signal));
		...
	});
}                                              // tools/write.ts
```

第五个参数是**泛型 context**，不是写死的 env：

```ts
export type AgentHarnessTool<TContext, TParameters extends TSchema = TSchema, TDetails = unknown> =
	Omit<AgentTool<TParameters, TDetails>, "execute"> & {
		execute(toolCallId, params, signal, onUpdate, context: TContext): Promise<AgentToolResult<TDetails>>;
	};                                         // harness/types.ts:81
```

```ts
export interface ExecutionToolContext { env: ExecutionEnv }   // tools/tool-context.ts
```

`createWriteTool<TContext extends ExecutionToolContext = ExecutionToolContext>()`
——**约束是「至少得有 env」，你自己的工具可以要求 `{ env, db, currentUser }`。**
调用方那头完全开放：`toolContext?: object | (() => object | Promise<object>)`（`agent-harness.ts:250`）。

> 为什么是 `Omit &` 不是 `extends`：多一个必需参数违反里氏替换，`extends` 编译不过。
> 详见 [ts-notes.md](./ts-notes.md) 第 24 条。

#### `path-utils.ts`（30 行）—— 对模型和 macOS 双重不可靠的容错

```ts
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeToolPath(path: string): string {
	const normalized = path.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;   // 去掉 UI 里 @提及 的前缀
}
```

`resolveReadToolPath` 更狠——**依次试 5 种变体，哪个存在用哪个**：

```ts
const variants = [
	resolved,
	resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),   // macOS 截图文件名里的窄空格
	resolved.normalize("NFD"),                                          // macOS 文件名的 Unicode 分解形式
	resolved.replace(/'/g, "\u2019"),                                   // 直引号 → 弯引号
	resolved.normalize("NFD").replace(/'/g, "\u2019"),
];
for (const variant of new Set(variants)) {
	if (getOrThrow(await env.exists(variant, signal))) return variant;
}
```

> **30 行里没有一行是「解析路径」，全是在猜模型到底想说哪个文件。**
> macOS 的 NFD 文件名和截图里的窄空格是真实存在的坑。

#### `edit-diff.ts` 的模糊匹配到底模糊在哪

```ts
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n").map((line) => line.trimEnd()).join("\n")   // 每行去尾部空白
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")                          // 弯单引号 → '
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')                          // 弯双引号 → "
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")      // 各种破折号 → -
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");  // 各种空格 → 普通空格
}
```

**它不做 Levenshtein、不做行级 diff 匹配。** 只做一件事：把「排版意义上等价但字节不同」的字符归一化，然后精确匹配。

```
模型写出来的                实际文件里的              归一化后
don\u2019t   （U+2019 弯撇）  don't  （U+0027 直撇）    都变成 U+0027   ✅
a \u2014 b   （em dash）      a - b  （hyphen）         都变成 -        ✅
行尾多了两个空格             没有                       都被 trimEnd    ✅
缩进 4 空格                  缩进 Tab                   ❌ 不归一，匹配失败
```

> **归一化的是「模型复述文本时会无意改掉的东西」，不是「代码格式」。**
> 缩进对不上照样匹配失败——那是模型没照抄，不是排版差异。

`applyReplacementsPreservingUnchangedLines` 是配套的另一半：匹配在归一化文本上做，
**替换要写回原始文本**，所以未改动的行必须保留原来的字节（含那些弯引号和尾部空白）。


**`file-mutation-queue.ts`（56 行）小而精**，三个设计点：

1. **队列挂在 `env` 上**（`WeakMap<ExecutionEnv, State>`），不是全局。多 env 互不干扰，env 被回收队列跟着回收
2. **key 是 canonicalPath**（解析 symlink 后的真实路径）——三个不同字符串指向同一文件也能正确串行；
   文件不存在时降级用绝对路径
3. **「入队」这个动作本身也串行化**——因为算 canonicalPath 是异步的，
   两个请求各自 `await` 完再抢队列的话，**后来的可能先抢到**。
   所以先用 `state.registration` 链把入队动作串起来

> 不只是「排队执行」，还得保证「排队」的顺序本身不乱。这个 bug 很难想到，也很难测。

---

### B. `coding-agent/src/core/tools/`（4142 行，15 文件）

| 文件 | 行 | 职责 |
|---|---|---|
| `edit-diff.ts` | 560 | 同名但独立实现，比 harness 版多 60 行的产品化处理 |
| `bash.ts` | 508 | `BashOperations` 接口可整个替换（默认 `createLocalBashOperations`）；`BashSpawnHook` 能在 spawn 前改上下文（**沙箱 / 环境变量注入挂这**）；实时输出走 `output-accumulator.ts` |
| `edit.ts` | 441 | `EditOperations`（`readFile` / `writeFile` / `access`）可换；产出 diff 交给 `render-utils.ts` 渲染 |
| `grep.ts` | 390 | **harness 没有**。`GrepOperations` 可换，默认走 ripgrep；**尊重 `.gitignore`**；单行超 `GREP_MAX_LINE_LENGTH`（500 字符）截断 |
| `find.ts` | 380 | **harness 没有**。按文件名 glob 查找；`relativizeFindResultPath` 把结果转成相对路径显示 |
| `read.ts` | 356 | 比 harness 版多：图片自动缩放、`ReadOperations` 里可插 `detectImageMimeType` |
| `truncate.ts` | 276 | **输出截断**。双限制（2000 行 / 50KB）**谁先撞谁生效**；注释明写 *"Never returns partial lines"*（bash tail 是唯一例外） |
| `write.ts` | 272 | 比 harness 版多：写前 diff 预览、权限交互 |
| `ls.ts` | 230 | **harness 没有**。`LsOperations` 可换 |
| `output-accumulator.ts` | 222 | **流式输出攒批，内存有界**。超限后**溢出到 `tmpdir()` 的临时文件**，`OutputSnapshot.fullOutputPath` 把完整日志的路径还给用户 |
| `index.ts` | 196 | **工厂总表**。`ToolName` 七元联合 + `createTool` / `createToolDefinition` 两个 switch + 三个批量工厂 |
| `path-utils.ts` | 118 | `expandPath`（展开 `~`）/ `resolveToCwd` / `resolveReadPath` |
| `render-utils.ts` | 85 | **TUI 渲染**——`shortenPath`、`linkPath`（终端超链接）、`replaceTabs`、`normalizeDisplayText`。**harness 完全没有这层** |
| `file-mutation-queue.ts` | 61 | 同名独立实现 |
| `tool-definition-wrapper.ts` | 47 | `ToolDefinition` → `AgentTool` 的转换。见下 |

**依赖注入：每个工具一个 `XxxOperations` 接口，构造时传，且有默认实现。**

```ts
export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}
const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),                    // ← 直接 node:fs
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};                                             // core/tools/edit.ts:84
```

```ts
createEditTool(cwd, options?)     // cwd 构造时就烤进去，不是每次调用传
```

#### 每个工具还导出一段系统提示词片段

```ts
export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;                                    // core/tools/grep.ts:38
```

`bash` / `grep` / `find` / `ls` 都有。**这解释了上一节那个奇怪的 import**：

```ts
// server/create-harness.ts
import { createBashTool, ... } from "@earendil-works/pi-agent-core";       // 实现来自 agent 层
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts";  // 提示词来自产品层
```

**工具的「怎么做」和「怎么跟模型介绍自己」是分开的两件事**，可以来自不同的包。

#### `output-accumulator.ts`（222 行）—— 内存有界的流式输出

bash 跑 `npm install` 会吐几万行。三件事：

```ts
export interface OutputSnapshot {
	content: string;            // 截断后的，给 LLM 和 UI
	truncation: TruncationResult;
	fullOutputPath?: string;    // ★ 完整日志溢出到 tmpdir() 的文件路径
}
```

1. 边流边攒，只保尾部（`truncateTail`）
2. 超限后**溢出到临时文件**（`join(tmpdir(), \`${prefix}-${随机 8 字节 hex}.log\`)`）
3. 把那个路径还回去——**模型或用户想看全的，自己去读那个文件**

> **截断不等于丢弃。** harness 那边的 `utils/truncate.ts` 只截不存，
> 这 222 行的差别就在「存哪儿、怎么告诉你」。


#### ★ 三层形状与 `tool-definition-wrapper.ts`

coding-agent 的内置工具走的是**扩展面向的接口**，再统一 wrap：

```
createReadToolDefinition(cwd, options)  →  ToolDefinition   扩展面向（extensions/types.ts）
        ↓  wrapToolDefinition
createReadTool(cwd, options)            →  AgentTool        运行时面向
```

```ts
export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}                                              // core/tools/read.ts:354
```

> **内置工具没有特权，和第三方扩展工具走同一个形状（`ToolDefinition`），
> 只是内置的那批顺手也导出了 wrap 好的版本。**

工厂总表在 `index.ts`：

```ts
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";   // :83
export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef  // :96
export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool               // :117
export function createCodingToolDefinitions(cwd, options): ToolDef[]      // 全套
export function createReadOnlyToolDefinitions(cwd, options): ToolDef[]    // 只读子集 ← 审计/沙箱场景
```

---

### 两边的结构差异

| | `harness/tools/` | `coding-agent/core/tools/` |
|---|---|---|
| 行数 | 1190 | 4142（3.5×） |
| 工具数 | 4 | 7 |
| **依赖注入** | **一个 `ExecutionEnv`**，`execute` 第 5 参 | **每工具一个 `XxxOperations`**，构造时传 |
| **默认实现** | ❌ 必须自己给 env | ✅ `defaultXxxOperations` 直接用 `node:fs` |
| **cwd** | 每次调用从 env 解析 | **构造时烤进去** |
| 工具形状 | `AgentHarnessTool`（5 参 execute） | `ToolDefinition` → wrap → `AgentTool`（4 参） |
| 和扩展的关系 | 无 | **内置与扩展同一形状** |
| TUI 渲染 | ❌ | ✅ `render-utils.ts` |
| 输出截断 | 在 `harness/utils/truncate.ts` | 在 `tools/truncate.ts` |

**两种注入手法的取舍：**

```
一个 ExecutionEnv    换环境只实现一个接口；但每次调用都得把 env 传进来
每工具 Operations    颗粒更细、能只 mock 一个工具的 IO；但接口数量 = 工具数量
```

harness 那套更适合「整体换执行环境」（浏览器、远程沙箱）；
coding-agent 那套更适合「单个工具打桩测试」。**两边都是本地跑，只是抽象的切法不同。**

---

## 四个边缘包（合计不到 6000 行，可以先不看）

| 包 | 行 | 是什么 |
|---|---|---|
| `protocol` | 1236 | typebox 定义的 RPC 消息格式，纯类型 + schema |
| `client` | 1225 | 连 server 的客户端，只依赖 protocol |
| `server` | 2298 | HTTP/RPC 服务端 |
| `telemetry` | 935 | 埋点，零依赖 |
| `evals` | 1277 | 评测 |
| `session-backends` | 0 | **空包**（src 下 0 个 ts 文件），占位 |

`protocol` + `client` + `server` 三件套是把 pi 跑成服务的那条路径，和本地 CLI 是并列的两种形态。

---

## 找东西该去哪个包

| 想改/想找 | 去哪 |
|---|---|
| 支持一家新模型厂商 | `ai/src/api/` + `ai/src/types.ts` 的 `KnownApi` |
| 改 agent 循环的终止/重试逻辑 | `agent/src/agent-loop.ts` |
| 改上下文压缩策略 | `agent/src/harness/compaction/` |
| 改会话怎么存 | `agent/src/harness/session/` |
| 加一个 pi 的内置工具 | `coding-agent/src/core/tools/`（写成 `ToolDefinition`，见 [tools 结构](#tools-两个文件夹的结构)） |
| 给 SDK 用户加一个工具 | `agent/src/harness/tools/`（写成 `AgentHarnessTool`，5 参 execute） |
| 改终端界面 | `tui/` + `coding-agent/src/modes/interactive/` |
| 改命令行参数 | `coding-agent/src/main.ts` |
| 加扩展/插件 | `coding-agent/src/core/extensions/` |

---

## `agent` vs `coding-agent`：能力清单

Day 6 查清的。**核心结论：`packages/agent` 是通用 agent 库，`coding-agent` 是它的一个具体产品实例。你完全可以只用前者做别的类型的 agent——这就是它的主要用途。**

`packages/agent/README.md` 的 Quick Start 就是干这个的，20 行造一个 agent：

```ts
const agent = new Agent({
	initialState: { systemPrompt: "You are a helpful assistant.", model },
	streamFn: models.streamSimple.bind(models),
});
agent.subscribe((event) => { /* 渲染 */ });
await agent.prompt("Hello!");
```

**README 513 行里一次都没提 `harness`**——讲的全是 `Agent` 类、事件流、工具、自定义消息类型。印证那条规律：**`Agent` 类是现在给外部用的稳定 API，`AgentHarness` 是将来的。**

### 两个包的分工

| | `packages/agent`（12191） | `packages/coding-agent`（58672） |
|---|---|---|
| 定位 | **通用 agent 库** | **一个具体产品**（编码助手 CLI） |
| npm 名 | `@earendil-works/pi-agent-core` | `@earendil-works/pi-coding-agent`（`bin: pi`） |
| 核心 | `agent-loop.ts` 796 + `agent.ts` 592 | `agent-session.ts` 3342（缝合层） |
| 工具 | 4 个最小实现（1190） | 10 个产品级（4142，带权限/渲染/截断） |
| UI | ❌ 无 | ✅ `modes/interactive` 17362 + 依赖 tui |
| 配置系统 | ❌ 无 | ✅ `settings-manager` 1272 + `models.json` |
| 扩展机制 | ❌ 无 | ✅ `extensions/` 1414 |
| 测试 | 20 文件 / 8260 行 | 221 文件 / 49251 行 |

**后者是前者的 4.8 倍——这个比例说明「从内核到产品」要补多少东西。**

### `agent` 现在**能**给你

| 能力 | 在哪 | 状态 |
|---|---|---|
| Agent 循环（工具调用、终止、错误回喂） | `agent-loop.ts` | ✅ 见 [agent-loop.md](agent-loop.md) |
| 状态管理 + 事件订阅 | `agent.ts` | ✅ |
| steering / followUp 队列 | `agent.ts:125` | ✅ |
| 中断（AbortSignal） | 全程 | ✅ |
| 自定义消息类型（声明合并） | `types.ts:316` | ✅ |
| 换模型 / 换上下文 | `prepareNextTurn` | ✅ |
| 工具前后钩子（权限拦截、结果改写） | `beforeToolCall`/`afterToolCall` | ✅ |
| bash / read / edit / write 四个基础工具 | `harness/tools/` | ✅ 可直接用 |
| 上下文压缩 | `harness/compaction/` | ✅ 848 行 + 测试 |
| 会话持久化（JSONL） | `harness/session/` | ✅ 993 行一致性测试 |
| Skills / 提示词模板 | `harness/skills.ts`、`prompt-templates.ts` | ✅ |
| 执行环境抽象（本地/容器/远端） | `harness/env/` | ✅ 695 行 |
| 埋点 | `harness/telemetry.ts` | ✅ |

### `agent` **不能**给你

| 缺什么 | 后果 | 谁补 |
|---|---|---|
| **任何 UI** | 终端/Web/Slack 前端全自己写 | 你 |
| **配置系统** | model 得代码里硬写或自己读文件 | 你 |
| **凭证管理** | `getApiKey` 是空钩子（见 [provider-loading.md](provider-loading.md)） | 你 |
| **provider 目录 + 覆盖** | 得自己组 `Model` 对象 | 你，或抄 `model-runtime.ts` |
| **grep / find / ls 工具** | 只有 bash/read/edit/write | 你 |
| **权限确认交互** | 钩子有了，UI 没有 | 你 |
| **崩溃恢复 / 会话树 / 多 lane / 子 agent** | `AgentHarness` 22 方法 reject | **等 pi**，或按 `harness.md` 自己实现 |

### 关于 `harness/` 的成熟度——一个要点

> 📖 harness 的数据模型（Session / Lane / Entry / Record、树与分支、恢复流程）
> 单独记在 [harness-model.md](./harness-model.md)。

「pi 不用 harness」≠「harness 没做完」。**除顶层 `agent-harness.ts` 外全部是真实现**：

```
模块                       行数   未实现标记   测试
reducer.ts                  667      0        ✅
compaction/compaction.ts    848      0        ✅
session/（8 文件）          2000+     0        ✅ 含 993 行 conformance
skills.ts / prompt-templates 637      0        ✅
env/nodejs.ts               695      0        ✅
tools/                     1190      0        ✅
telemetry.ts                615      0        ✅
──────────────────────────────────────────────────
agent-harness.ts            508     22 处     ⚠️ scaffold
```

**积木都做好了，缺的是把它们串起来的指挥。** 上游（`v0.84.2`，比我们的锚点新 208 个提交）17 个 harness 提交全落在 `session/` 和新增的 `events.ts`，`reducer.ts` 与 `agent-harness.ts` **一个字未改**。

开发顺序自下而上，对应 `packages/agent/docs/harness.md`（上游新增的 2941 行规格书，v0.84.1 里没有）：

```
Part 1 Storage         ← 现在在这（session/ 在猛改）
Part 2 Tree            ← session/types.ts 在改
Part 3 State machine   ← reducer.ts，写好了但没接
Part 4 Recovery        ← 还没
Part 5 Public surface  ← agent-harness.ts，接口定了，实现全空
```

---

## 改造成自己的项目时的取舍

按「保留 / 替换 / 丢弃」分三档：

**直接复用（约 3.5 万行，自己写不划算）**
`ai` 全部 + `agent/agent-loop.ts` + `agent.ts` + `harness/{session,compaction,tools,env}`。协议适配和会话持久化是纯苦力活，没有产品特色。

**参考后重写（约 1.5 万行）**
`coding-agent/core/tools/` —— 工具集是产品定位的体现，你的场景大概率不是 coding。
`coding-agent/core/model-runtime.ts` + `provider-composer.ts` —— **凭证与 provider 组合逻辑值得整段抄**，`agent` 层没有替代品。
`coding-agent/core/agent-session.ts` —— 3342 行缝合层，逻辑要看懂但代码要自己写。

**多半用不上（约 5 万行）**
`tui` + `modes/interactive` + `package-manager` + `extensions`。除非也要做终端交互产品。

**⚠️ 不要动 `AgentHarness`** —— 半成品，接上去会跟着上游一起变。要崩溃恢复/会话树这些能力，按 `packages/agent/docs/harness.md` 自己实现，或者等它做完。

```
你的 agent = packages/ai                          原样用
           + packages/agent 的 Agent + agent-loop  原样用
           + harness/{tools, compaction, session}  挑着用
           + 抄一份 model-runtime 的凭证/provider 逻辑
           + 你自己的工具集      ← 产品定位在这
           + 你自己的前端        ← 最大工作量
```
