# harness 数据模型 —— Session / Lane / Entry / Record

> Day 6 产出。`packages/agent/src/harness/`，基于 `v0.84.1`。
> 读 `reducer.ts`（667 行）和 `agent-session.ts`（3342 行）之前先建这张地图，否则一定晕。
>
> ⚠️ 前置事实：整个 `harness/` 树目前**没有任何生产调用方**，pi 自己的 coding-agent 走的是 `AgentSession`
> 这条老路。但除 `agent-harness.ts` 外全部模块零未实现标记、全部有测试——**积木都做好了，缺的是指挥**。
> 详见 [architecture-map.md](./architecture-map.md)。

## 速记（30 秒版）

> **Entry** 是这次 session 的节点，装**内容**（消息、压缩、配置变更），
> 靠 `parentId` 构成一棵树。
>
> **Record** 是旁边一条**不进树**的流水账，记「打算做什么、开过工没」，
> 靠**预分配的 entry id** 跟树对账。
>
> **成败在树上**（LLM 要看到），**过程在带子上**（只有恢复要看）。
> 要 trace agent 干过什么，两边合起来看。
>
> **Lane ≈ git 的 branch ref**（不是 HEAD），指向树上某个 entry，可以有多条同时存在。

```
树   = 做成了什么          带子 = 打算做什么、开过工没
lane = 下一笔挂哪儿        恢复 = 拿带子上的号去树上找货，找不到就是断点
```

### 三个容易记反的点

**① 工具调用失败**记在**树上**，不在 record 里。

失败的 toolResult 要喂给 LLM 看，所以它是一条 entry。`tool_started` 的字段里
**没有 `outcome`、没有 `error`**——它只记「开工了、结果会叫 e7」。
带 `error` 的只有 `operation_finished`，那是整次 operation 级别的，不是单个工具。

**② lane 不是 HEAD，是 branch ref。**

HEAD 全局只有一个；lane 可以同时存在多条，各指各的。
而且 pi 里**没有「当前 lane」这个概念**——每次调用都显式带 lane 名。

**③ entry 不是完全不含工作状态**，漏了两个字段进来：

```ts
interface MessageEntry { message: AgentMessage; terminate?: true }
```

- `terminate?: true` —— 上游文档原话：*"It is **orchestration state** that `ToolResultMessage` has no field for."*
- `message.stopReason` —— reducer 靠 `"deferred"` / `"error"` 算出 `deferred` 和 `terminalFailure`

因为它们没别的地方放。

---

## 文件框架（导航）

**9824 行，41 个文件，6 组。**

```
harness/
│
├─ 顶层 *.ts        3007  编排 + 契约 + 横切
├─ session/         3127  持久化              ← 最大的一块（32%）
├─ compaction/      1260  上下文压缩
├─ tools/           1190  四个内置工具
├─ env/              695  执行环境（Node 实现）
└─ utils/            545  截断 / shell 捕获
```

### ① 顶层编排（1175 行）

| 文件 | 行 | 职责 | 状态 |
|---|---|---|---|
| `agent-harness.ts` | 508 | `AgentLane` 接口（25 个方法 + 2 个只读属性）+ `AgentHarness` 类 + 全部错误类型 + `Hooks`/`Events` | ⚠️ **22 处 `unavailable`**，只有 getter/setter 是真的 |
| `reducer.ts` | 667 | **崩溃恢复的全部大脑**。校验 39% + 归约 41%，纯函数零 I/O | ✅ 完整，1127 行测试 |

这两个是核心，也是**唯一互相知道对方存在的一对**：`agent-harness.ts` 定义「有哪些动作」，
`reducer.ts` 决定「现在该做哪个」。

### ② 契约层（546 行）

| 文件 | 行 | 职责 |
|---|---|---|
| `types.ts` | 315 | **接口总集**：`Result` / `Skill` / `PromptTemplate` / `AgentHarnessTool` / `FileSystem` / `Shell` / `ExecutionEnv` + 4 个错误类 |
| `messages.ts` | 168 | `AgentMessage` 的四种扩展（bash / custom / branchSummary / compactionSummary）+ **`convertToLlm`** |
| `result.ts` | 63 | `Result` + `TaggedError` |

`ExecutionEnv` 的定义就一行（`types.ts:315`）：

```ts
export interface ExecutionEnv extends FileSystem, Shell {}
```

**整个 harness 对外部世界的依赖，全部收敛到这一个接口。**
想换执行环境（浏览器、远程沙箱），实现它就够了。

#### 📌 发现：`Result` 定义了两遍

```ts
types.ts:6   export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
result.ts:1  export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
```

一模一样，但用的人完全不同：

| | 用户 |
|---|---|
| `types.ts` 的 | `skills` / `prompt-templates` / `compaction` × 2 / `session/search` / `utils/shell-output` —— **6 个成熟模块** |
| `result.ts` 的 | **只有 `agent-harness.ts`**，还起了别名 `import { type Result as ResultValue }` |

`result.ts` 是跟着 scaffold 一起进来的新文件（多了个 `TaggedError` 错误风格）。
**又一个「半路改造还没收尾」的痕迹**，和 22 处未实现是同一件事的两面。

### ③ `session/` 持久化（3127 行，32%）

分四层，上层只认下层的接口：

```
接口定义     types.ts        372   Entry / Record / Session / Storage / Repo 全部接口
   ↓
门面 + 校验   session.ts      294   Session 类，实现 SessionTree；转发给 storage，写前校验 JSON 可序列化
   ↓
内存状态     state.ts        344   SessionState：树 + lane Map + applyMutation 重放  ← 分支规则在这
   ↓
后端实现     jsonl/ + memory.ts
```

| 文件 | 行 | 职责 |
|---|---|---|
| `types.ts` | 372 | **7 种 Entry + 9 种 Record + 查询类型 + Storage/Repo 接口**。整个数据模型的定义处 |
| `state.ts` | 344 | `SessionState`。`applyMutation:97` 是重放核心——`:112` 硬校验「必须接在 leaf 上」，`:121` 隐式挪指针 |
| `session.ts` | 294 | `Session` 类。`assertJsonSerializable` 在这（拒绝循环引用、稀疏数组、非有限数） |
| `context.ts` | 100 | ★ **Entry → `AgentMessage[]` 的唯一投影点**。`defaultContextEntryTransform:45` 实现「不读过压缩点」 |
| `memory.ts` | 192 | `InMemorySessionStorage` / `InMemorySessionRepo`——测试后端 |
| `search.ts` | 71 | 扫描式会话搜索 |
| `jsonl/storage.ts` | 272 | JSONL 后端主体。`createLane` / `moveLane` / `appendEntry` / `appendRecord` 都在这，**全过同一个 `enqueue` 串行队列** |
| `jsonl/codec.ts` | 193 | 一行 JSON ↔ mutation。`ENTRY_TYPES` / `RECORD_TYPES` 白名单，读时校验 |
| `jsonl/repo.ts` | 179 | 会话文件的增删查、fork、原子发布 |
| `jsonl/types.ts` `errors.ts` `jsonl.ts` `index.ts` | 95 | v4 header 类型、错误、re-export |
| **`testing/conformance.ts`** | **993** | **后端一致性测试套件** |

`testing/conformance.ts` 单文件占整个 harness 的 10%，而且是**发布出去的产物**
（`session/testing/index.ts` 导出 `createSessionBackendConformance`）——你自己实现 Postgres 后端，直接跑它。

### ④ 能力模块（1921 行）

| 文件 | 行 | 职责 |
|---|---|---|
| `compaction/compaction.ts` | 848 | token 估算、`shouldCompact` 阈值判定、生成摘要、带重试 |
| `compaction/branch-summarization.ts` | 280 | 跨分支跳转时生成 `branch_summary` |
| `compaction/utils.ts` | 132 | 从消息里提取读过/改过的文件列表，塞进摘要 |
| `skills.ts` | 375 | 从磁盘扫 skill 目录、解析 frontmatter、诊断错误 |
| `prompt-templates.ts` | 262 | 同上，外加 `parseCommandArgs` / `substituteArgs`（`$1 $2 $ARGUMENTS` 替换） |
| `system-prompt.ts` | 34 | 把 skill 列表格式化进 system prompt。**全文件一个函数** |

### ⑤ `tools/` 四个内置工具（1190 行）

| 文件 | 行 | 职责 |
|---|---|---|
| `edit-diff.ts` | 500 | **模糊匹配替换**——行尾归一化、空白容错、保留未改动行的原始格式 |
| `bash.ts` | 161 | `createBashTool`，带 `BashPrepare` 钩子（权限检查挂这） |
| `read.ts` | 144 | `createReadTool`，可插 `ReadImageProcessor` |
| `edit.ts` | 127 | `createEditTool` |
| `image.ts` | 104 | 嗅探图片 MIME + base64 |
| `file-mutation-queue.ts` | 56 | 同文件写入串行化 |
| `write.ts` `path-utils.ts` `index.ts` `tool-context.ts` | 98 | |

全是 `createXxxTool()` 工厂，都泛型于 `ExecutionToolContext`——**工具不知道自己跑在什么环境里**。

> **只有 4 个工具，没有 grep / find / ls / web**——那些在 `coding-agent` 里。
> 这是「库」和「产品」的分界线。

### ⑥ 执行环境 + 横切（1240 行）

| 文件 | 行 | 职责 |
|---|---|---|
| `env/nodejs.ts` | 695 | `NodeExecutionEnv implements ExecutionEnv`。**整个 harness 里唯一 import `node:*` 的文件** |
| `telemetry.ts` | 615 | 两套 span schema：`AI_TELEMETRY_SCHEMA`（:42）+ `HARNESS_TELEMETRY_SCHEMA`（:232） |
| `utils/truncate.ts` | 350 | `truncateHead` / `truncateTail` / `truncateLine`，默认 2000 行 / 50KB |
| `utils/shell-output.ts` | 195 | shell 输出捕获 + 二进制字符清洗 |

### 依赖方向

```
              agent-harness.ts  ⚠️
                     │  编排
      ┌──────────────┼──────────────┬──────────────┐
      ▼              ▼              ▼              ▼
  reducer.ts     session/      compaction/      tools/
      │              │              │              │
      └──────────────┴──────┬───────┴──────────────┘
                            ▼
                        types.ts          ← ExecutionEnv / Result / 错误类
                            ▲
                            │ implements
                        env/nodejs.ts     ← 唯一碰 node:* 的地方
```

**严格单向。** 底下四个模块互不认识（`reducer` 不 import `compaction`，`tools` 不 import `session`），
全靠 `agent-harness.ts` 组装。

> **所以那 22 处 `unavailable` 卡住的正是「组装」这一步**——积木和接口都齐了，
> 缺的是把它们串起来的那 500 行。

### 读的顺序

```
1. types.ts (315)           先看契约，尤其 ExecutionEnv 那一行
2. session/types.ts (372)   数据模型 —— 本文前面几节已经拆过
3. session/context.ts (100) Entry → 消息的唯一投影点，最小最关键
4. reducer.ts (667)         恢复大脑
5. session/state.ts (344)   分支规则的实现
6. agent-harness.ts (508)   最后看，因为它是半成品，看接口不看实现
```

**跳过**：`testing/conformance.ts`（993，测试套件）、`edit-diff.ts`（500，纯算法）、
`env/nodejs.ts`（695，胶水）、`telemetry.ts`（615，schema 声明）——
**加起来 2803 行，占 29%，跟架构无关**。真正要读的架构代码只有约 2300 行。

---

## 零、三层结构

```
Session      一个 append-only 日志文件（一次会话的全部持久化）
  └─ Lane    日志里的一条「工作线」，本质是个具名指针
       └─ Operation   这条线上正在跑的一次操作（run / compaction / navigation）
```

一条 lane 同时最多跑一个 operation——所以才有 `LaneBusy`（`agent-harness.ts:28`）。

---

## 一、Session 里存了两种完全不同的东西

这是整个 harness 最关键的二分。看懂它后面全通。

`session/types.ts` 里有两个平行的基类：

```ts
export interface EntryBase {          // :14
	type: string;
	id: string;
	seq: number;
	parentId: string | null;   // ← 树
	timestamp: number;
}

export interface RecordBase {         // :80
	id: string;
	seq: number;
	lane: string;              // ← 属于哪条线
	timestamp: number;
}
```

| | **Entry** | **Record** |
|---|---|---|
| 定义 | 跟着**分支**走的状态 | 跟着**执行**走的过程 |
| 结构 | 树（`parentId`） | 线性（`seq`，归属某条 `lane`） |
| 跳分支后 | 变（重放新路径） | 不变（跟树无关） |
| 谁读 | LLM + `deriveEffectiveConfiguration` | 只有恢复流程 |
| 类比 | git commit 树 | WAL / git reflog |

> **Entry 是「分支状态」，Record 是「执行过程」。**

命名注释：这里的 `entry` 取 **log entry / ledger entry**（日志条目、账目条目）的意思，**不是 entrypoint（入口）**。
周边全是账本词汇：`appendEntry`、`seq`、`LogItem`、`getLog`、append-only。
`Entry` 和 `Record` 中文都是「记录」，纯粹是挑了两个近义词区分两套存储。记法：**Entry 挂在树上，Record 排在带子上。**

这也是 effect sandwich 落到存储上的样子：

```
appendRecord(tool_started)        ← 意图，Record
   真去执行工具（可能崩）
appendEntry(message: 工具结果)     ← 结果，Entry
appendRecord(operation_finished)  ← 结算，Record
```

---

## 二、Entry：7 种类型（上游已减到 4 种），两条消费通路

```ts
export type Entry =
	| MessageEntry            // type: "message"
	| ModelChangeEntry        // type: "model_change"
	| ThinkingLevelEntry      // type: "thinking_level_change"
	| ActiveToolsEntry        // type: "active_tools_change"
	| CompactionEntry         // type: "compaction"
	| BranchSummaryEntry      // type: "branch_summary"
	| CustomEntry;            // type: "custom"
```

**只有 2 种直接装 `AgentMessage`。** 划分的权威出处是 `session/context.ts:65`，
`sessionEntryToContextMessages` 是**唯一**把 Entry 翻成消息的地方：

```ts
if (entry.type === "message")        return [entry.message];
if (entry.type === "compaction")     return [摘要消息, ...entry.retainedTail];
if (entry.type === "branch_summary") return [分支摘要消息];
if (entry.type === "custom")         return [...projector?.(entry) ?? []];
return [];   // ← model_change / thinking_level_change / active_tools_change 走到这
```

| Entry 类型 | 产出消息？ | 装的是什么 |
|---|---|---|
| `message` | ✅ 1 条 | `AgentMessage` |
| `compaction` | ✅ 摘要 + `retainedTail` | 压缩后的 summary + 保留的尾部消息 |
| `branch_summary` | ✅ 1 条 | 跨分支跳转时的摘要，带 `fromId` |
| `custom` | ⚠️ 要注册 projector，否则 `[]` | 任意 `data` |
| `model_change` | ❌ | `{provider, modelId}` |
| `thinking_level_change` | ❌ | `thinkingLevel` |
| `active_tools_change` | ❌ | `activeToolNames[]` |

### 不产消息的三个去哪了

喂给另一条通路 `deriveEffectiveConfiguration`（`reducer.ts:400`）：

```ts
case "model_change":          configuration = { ...configuration, model: {...} };
case "thinking_level_change": configuration = { ...configuration, thinkingLevel: ... };
case "active_tools_change":   configuration = { ...configuration, activeToolNames: [...] };
case "message":
    if (entry.message.role === "assistant")   // ← assistant 消息也隐式改配置
        configuration = { ...configuration, model: { provider, modelId } };
```

产出的正是三个字段一一对应的：

```ts
export interface EffectiveLaneConfiguration {   // reducer.ts:54
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}
```

所以 Entry 树有**两个消费者**、两条独立通路：

```
Entry 树（沿 leafId → parentId 回溯）
   ├─ sessionEntryToContextMessages  context.ts:65   → AgentMessage[]        喂 LLM
   └─ deriveEffectiveConfiguration   reducer.ts:400  → EffectiveLaneConfig   决定拿什么去调
```

### 为什么配置非得进树，不能当个可变字段

因为有 `navigateTree(targetId)`——跳到树上另一个节点。跳过去之后，
**「当前用哪个模型」必须回到那个节点当时的值**，而不是保留你在别的分支上改过的。

配置若是可变字段，切分支就串味；放进树里它自动跟着分支走。
这是**事件溯源 vs 可变字段**那组对立在这里的落地——同一个 `AgentSession` 用可变字段，`harness` 用事件溯源。

### ⚠️ 但上游推翻了这个决定

**v0.84.1（本地）**——配置是树上的 entry，`Entry` 有 **7 种**。

**上游 v0.84.2（`packages/agent/docs/harness.md:621` §2.1）**——只剩 **4 种**：

```ts
type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;
```

三个配置 entry 全没了，搬到 lane 自己的寄存器上（§2.3）：

```
lane.leaf/{name}    = entry id or null
lane.config/{name}  = LaneConfiguration      // { model, thinkingLevel, activeToolNames }
lane.state/{name}   = LaneState
```

> `LaneConfiguration` is **total**. A setter overwrites the whole register;
> it is never a patch and **never a tree entry**.

语义整个掉了个个儿：

| | v0.84.1 | 上游 |
|---|---|---|
| 配置跟着谁走 | **分支** | **lane** |
| `navigateTree` 之后模型是 | 目标节点当时的值 | **不变** |
| 两条 lane 停在同一节点 | 配置必然相同 | **可以不同** |

上面那段「配置必须进树否则切分支串味」是对 v0.84.1 代码的正确解读，
但**pi 自己想清楚之后选了反面**——「这条车道用什么车」是车道的属性，不是路面的属性。

📌 改造自己的项目时这条直接可用：**配置放 lane 上更简单，也是 pi 最终的选择。**

---

## 三、怎么看出一个节点是哪种 Entry

靠 **`type` 字段**，它是每行 JSON 的第一个 key。真实 session（v3 格式，7 行）：

```
  1 HEADER v3
  2 model_change             id=eccbe42a  parent=None      dashscope/qwen3.7-plus
  3 thinking_level_change    id=33e5956f  parent=eccbe42a
  4 message                  id=1268af8e  parent=33e5956f  user      [text]
  5 message                  id=81760da7  parent=1268af8e  assistant [thinking,toolCall]
  6 message                  id=fc1a0f43  parent=81760da7  toolResult[text]
  7 message                  id=1ab88b5d  parent=fc1a0f43  assistant [thinking,text]
```

```json
{"type":"model_change","id":"eccbe42a","parentId":null,"timestamp":"...","provider":"dashscope","modelId":"qwen3.7-plus"}
{"type":"message","id":"1268af8e","parentId":"33e5956f","timestamp":"...","message":{"role":"user",...}}
```

> 真实数据里这条 session 的**头两个节点根本不是消息**——`model_change` + `thinking_level_change` 打头，
> 用户消息排第三。「配置也是节点」在自己的文件上看得见。

**判别联合**：7 个成员共享 `EntryBase`，各自把 `type` 收窄成字面量类型。判一下 `type`，TS 自动收窄字段：

```ts
if (entry.type === "compaction") {
	entry.summary        // ✅ 只有 CompactionEntry 有
	entry.provider       // ❌ 编译错误，那是 ModelChangeEntry 的
}
```

运行时白名单写死在 codec 里，读文件时校验：

```ts
const ENTRY_TYPES = new Set<Entry["type"]>([...]);      // jsonl/codec.ts:6
if (!ENTRY_TYPES.has(type)) throw invalidFile(...);     // jsonl/codec.ts:123
```

**同一个字符串既是 TS 的收窄依据，也是磁盘的校验依据。**

一眼分辨的口诀：**`type:"message"` 才有 `message` 字段，其余各带各的专属字段**
（`provider` / `thinkingLevel` / `activeToolNames` / `summary` / `fromId` / `customType`）。

### v4 的两级判别式

上面那份文件是 **v3**（coding-agent 老格式，只有 entry，没有 lane/record）。harness 的 **v4** 外面又套一层：

```ts
export function encodeMutation(mutation: SessionMutation): string {
	switch (mutation.kind) {
		case "entry":  return JSON.stringify({ kind: "entry", lane: mutation.lane, ...mutation.entry });
		case "record": return JSON.stringify({ kind: "record", ...mutation.record });
		case "lane":   return JSON.stringify(mutation);
		case "fact":   return JSON.stringify(mutation);
	}
}                                            // jsonl/codec.ts:182
```

```
kind   ── 这一行属于哪一类     entry / record / lane / fact
  ├ type ── entry 内部是哪种    message / model_change / ...
  └ type ── record 内部是哪种   operation_started / tool_started / ...
```

注意 `kind:"entry"` 把 `lane` 平铺进去了——**`lane` 只写在 mutation 上，不进 `Entry` 本身**。
因为 entry 属于树，树是所有 lane 共享的；「哪条 lane 写的」只是审计信息。

---

## 四、为什么每个 Entry 就是一个节点（粒度）

因为四件事都需要在时间线上指一个位置，而它们**必须指向同一种东西**，否则每加一个功能就得再发明一套坐标系。

| 谁需要定位 | 用什么指 | 出处 |
|---|---|---|
| 回退 / 开分支 | `navigateTree(targetId)`、`createLane(name, at)` | `agent-harness.ts:279` |
| Record 预约结果 | `resultEntryId`、`assistantEntryId`、`entryId` | `session/types.ts:136,153` |
| 压缩截断 | 找最近的 `compaction` entry，从它切 | `session/context.ts:45` |
| 配置生效点 | `model_change` / `thinking_level_change` / `active_tools_change` | `reducer.ts:407` |

第四行尤其关键：`model_change` **不是消息**，没有内容可喂 LLM，但它必须在分支上占位，
否则「这条分支上用哪个模型」无法定义。

> **只要一个东西需要「跟着分支走」，它就必须是分支上的一个节点。**

### 往粗了切会怎样（节点 = 一轮对话）

- `navigateTree` 只能回退到整轮边界，**回退到「assistant 说完但工具还没跑」就做不到**——
  而这恰恰是崩溃恢复最常落的位置
- 一轮没结束就没法落盘：要么攒内存（崩了全丢），要么反复重写同一行（append-only 前提废掉）
- `tool_started.resultEntryId` 没有东西可指

### 往细了切会怎样（节点 = content block）

> **Entry 的粒度 = 能独立喂给 LLM 的最小单位。**

`sessionEntryToContextMessages` 的返回类型是 `AgentMessage[]`。半条消息喂不进任何 API，
切到 block 层树上就会出现无法投影成消息的节点。

那 block 级的定位需求呢？——**不进树，进 record**：

```ts
export interface ToolStartedRecord extends RecordBase {
	assistantEntryId: string;   // 树坐标：哪个节点
	toolIndex: number;          // 块坐标：这个节点里的第几个 tool_call
	toolCallId: string;
	resultEntryId: string;
}                               // session/types.ts:150
```

**树管到 entry，再往下由 record 的 `toolIndex` 接手。两级坐标，各管各的。**

### 代价

节点细 → 树深 → `leafId → parentId` 回溯是 O(深度)。用 `BranchBounds` 兜：

```ts
export interface BranchBounds {
	start?: string;
	stopAtType?: Entry["type"];   // 比如 "compaction"，走到最近的压缩点就停
	stopAtId?: string;
}                                 // session/types.ts:231
```

`LaneReductionInput.configurationEntries` 的注释写的正是这件事——
"**Bounded** effective-state lookups at the operation anchor or idle leaf"（`reducer.ts:116`）。

---

## 五、Lane：一个具名指针

完整定义只有 4 行（`session/types.ts:262`）：

```ts
export interface LanePointer {
	lane: string;           // 名字，默认 "main"
	leafId: string | null;  // 指向 entry 树上的某个节点
}
```

**类比 git branch：**

| git | pi harness |
|---|---|
| branch 名 | `lane` |
| branch tip | `leafId` |
| `git branch foo <commit>` | `session.createLane(name, at)` `session.ts:190` |
| 提交后 tip 前移 | `session.moveLane(lane, to)` `session.ts:195` |
| `git checkout <commit>` | `navigateTree(targetId)` |
| commit 树 | Entry 树（`parentId`） |

### 磁盘上 lane 只存一个字段

v0.84.1 里 lane 持久化的东西**只有 `leafId`**。前面说的「lane 拥有配置、队列、operation」，
在 v0.84.1 里全是**算出来的**：

| lane 的东西 | 存哪 |
|---|---|
| `leafId` | ✅ 真存 |
| 配置（模型 / thinking / 工具） | ❌ 从 entry 树重放算出（`deriveEffectiveConfiguration`） |
| 三个队列 | ❌ 从 `queue_enqueued` record 算出 |
| 当前 operation | ❌ 从 `operation_started` record 算出 |

> **`LaneState` 是 reducer 的产物，不是磁盘上的东西。磁盘上只有一个指针。**

内存里就是一个 Map：

```ts
this.lanes: Map<string, string | null>      // lane 名 → leafId
lanes = { "main" → "e3" }
```

### 指针怎么动：追加时不写额外的行

```ts
case "entry": {
	if (mutation.entry.parentId !== leafId) invalid("does not chain to the lane leaf");  // :112
	...
	if (mutation.lane !== undefined) this.lanes.set(mutation.lane, mutation.entry.id);   // :121
}                                                                        // session/state.ts
```

- **`:112`** 新 entry 的 `parentId` **必须**等于当前 leafId，否则整个文件判无效。
  「追加永远是直线」是硬校验，不是约定。
- **`:121`** 追加完顺手挪指针，**不写额外日志行**——entry 那行自带 `lane` 和 `id`，重放能推出来。

所以独立的 lane 行 `{"kind":"lane","seq":5,"lane":"main","leafId":"e2"}`
**只在指针「不跟着追加走」时出现**——`createLane` / `moveLane`（`navigateTree` 的底层）。

> **正常往下长 → 指针隐式跟着走，不留痕。回退开分支 → 必须显式写一行。**

所有 Entry 共用**一棵树**，lane 只是树上的几个书签。
所以 `session.appendCustomEntry()` 默认写 `"main"`（`session.ts:183`）——单 lane 场景感觉不到它存在。

**多 lane 的意义**：一个 session 里并行跑多条互不干扰的工作线，共享同一棵历史树、同一个文件、同一份 writer claim。

取上下文 = 从 `leafId` 沿 `parentId` 往上走，再反转（跟 `git log` 一样）：

```ts
const start = query.start ?? (await this.getLeafIdForLane(lane));   // session.ts:243
return this.storage.findEntriesOnBranch({ ...storageQuery, start });
```

---

## 六、分支是怎么长出来的

### 追加时永远是直线

```ts
appendEntry(newEntry, lane) {
	const parentId = this.state.requireLane(lane);   // ← parentId = 该 lane 当前的 leafId
	const entry = { ...newEntry, parentId, seq: nextSequence, timestamp: Date.now() };
	await this.appendMutation(mutation);
	this.applyMutation(mutation);                    // ← 顺手把 leafId 挪到新 entry
}                                                    // jsonl/storage.ts:143
```

**新 entry 的父亲永远是「当前 leafId」，写完 leafId 前移。只要一直 append，树就是一根棍。**

### 分支只由「指针回退」产生

只有两个 API 能挪 leafId 而不追加 entry：

```ts
createLane(lane, at)  // jsonl/storage.ts:123   新开一条线，落在已有的 at 上
moveLane(lane, to)    // jsonl/storage.ts:133   把现有的线挪到 to
```

两个都产出同一种日志项 `{ kind: "lane", seq, lane, leafId }`（`session/types.ts:267`）——
**指针移动本身也是持久化的一条日志**，所以重放能重建。

上层入口是 `navigateTree(targetId, { summarize })` 和 `createLane(name, at)`。

### 按 seq 走一遍

```
seq 1   entry  e1  message user       parentId=null        main→e1
seq 2   entry  e2  message assistant  parentId=e1          main→e2
seq 3   entry  e3  message user       parentId=e2          main→e3
seq 4   entry  e4  message assistant  parentId=e3          main→e4

        此刻的树：  e1 → e2 → e3 → e4        一根棍，无分支
                                      ▲ main

seq 5   lane   main → e2        ← navigateTree("e2")：指针回退，一个 entry 都没写

        此刻的树：  e1 → e2 → e3 → e4        树完全没变！
                          ▲ main            只是 main 退回来了

seq 6   entry  e5  message user       parentId=e2          main→e5   ← ★ 分叉在这一刻发生
seq 7   entry  e6  message assistant  parentId=e5          main→e6
```

分叉后：

```
              e1
               ↑
              e2 ──────────┬───────────┐
               ↑           ↑
        (孩子1) e3   (孩子2) e5
               ↑           ↑
              e4          e6
               ✗           ▲
          没人指了       main
```

三条要点：

1. **`e2` 有了两个孩子，这就是分支的全部定义。**
2. `e5.parentId = e2` 但 `e5.seq = 6`——**`seq` 全局单调，`parentId` 才是树结构**。
   「seq 比我大却是我的兄弟」正是分叉的特征。
3. **`e3 → e4` 没被删**，还在 JSONL 里，只是没有 lane 指针能沿 `parentId` 走到它。
   跟 git `reset --hard` 后旧 commit 躺在 reflog 里一模一样。

`main` 现在取上下文 = `[e1, e2, e5, e6]`。**`e3`、`e4` 对 LLM 彻底消失。**

想保住被跳过那段，用 `navigateTree(target, { summarize: true })`——在新分支上写一个
`branch_summary` entry，带 `fromId` 记住「我从 e4 那边过来」，摘要经 `createBranchSummaryMessage`
变成一条真消息（`session/context.ts:82`）。

### 双 lane 版本

`createLane("experiment", "e2")` 不用回退 main，两条线并存：

```
              e1
               ↑
              e2 ──────────┬───────────┐
               ↑           ↑
              e3          e5
               ↑           ↑
              e4          e6
               ▲           ▲
        main→e4      experiment→e6

getLanes() → [ {lane:"main", leafId:"e4"}, {lane:"experiment", leafId:"e6"} ]
```

这才是「lane」这名字的由来——**同一条路上的两条车道**。

### 别混淆的第三种「分支」

`SessionRepo.fork(source, options)`（`session/types.ts:338`）拷到**新的 session 文件**：

```ts
export type ForkOptions =
	| { scope?: "branch"; entryId?: string; position?: "before" | "at" }  // 只拷这一条分支
	| { scope: "tree" };                                                  // 整棵树拷过去
```

| 层级 | 操作 | 结果 |
|---|---|---|
| Entry 树内 | `navigateTree` / `createLane` | 同一文件，多条路径 |
| Session 间 | `SessionRepo.fork` | **新文件**，`parentSessionId` 指回来 |

---

## 七、Record：对一个「还不存在的 Entry」的预约

9 个类型分三组（`session/types.ts:203`）：

```
① 操作生命周期    operation_started / abort_requested / operation_finished
② 操作内的步骤    step_attempt / tool_started
③ 旁路数据        queue_enqueued / queue_cancelled / write_deferred / usage
```

### 心智模型：record 不在树里，别拿树去套它

**entry 树是逻辑视图，不是存储形态。** 文件里 entry 也是平铺的，一行一条：

```jsonl
{"type":"message","id":"e1","parentId":null,...}
{"type":"message","id":"e2","parentId":"e1",...}
```

record 长得**一模一样**，也是一行一条：

```jsonl
{"kind":"record","type":"tool_started","id":"r4","seq":4,"lane":"main","resultEntryId":"e3",...}
```

> **唯一的区别：record 没有 `parentId`。没有那根线就拼不成树，只能按 `seq` 排成一条直线。**

record 彼此之间**没有指针**。`runId` 只是个**分组键**（「这几条属于同一次操作」），不是父子关系。
所有箭头都是单向的 **record → entry**；entry 完全不知道有 record 存在。

```
        树（空间：会分叉）                    带子（时间：只增长）
                                    │
              e1                    │   seq 1  operation_started {r1}
              ↑                     │   seq 2  step_attempt      ──→ e2
              e2  ←─────────────────┼───────────────────────────────┘
              ↑                     │   seq 3  usage             ──→ e2
            ┌─┴─┐                   │   seq 4  tool_started      ──→ e3  ✗还不存在
           e3   e5                  │   seq 5  operation_finished
                                    │
        parentId 连成树              │   （record 之间没有任何连线）
```

类比：**树 = 文件系统的目录树；lane = 当前工作目录；record = 文件系统的 journal。**
ext4 的 journal 就是「我打算写这几个块」→ 真写 → 「写完了」，平时没人看，只有崩溃后 fsck 才读一遍。
**你不会遍历 journal 去找文件。**

最土的说法：**record 就是你平时写的 log，只不过是结构化的、而且程序自己会读回去。**
pi 只多做一件事——**把结果的 id 提前写进 log 里**，于是 log 从「给人看的」变成「程序能对账的」。

### 指针有三个方向，不是每条 record 都有预约

| Record | 指向 entry 的字段 | 方向 |
|---|---|---|
| `operation_started` | `sourceLeafId` | ← 回指（起点，已存在） |
| | `intent.initialMessages` / `resultEntryId` / `summaryEntryId` | → **预约** |
| `step_attempt` | `resultEntryId` | → **预约** |
| `tool_started` | `assistantEntryId` | ← 回指（哪条消息发的调用） |
| | `resultEntryId` | → **预约** |
| `queue_enqueued` | `target: ProvisionedEntry` | → **预约**（连内容一起带） |
| `write_deferred` | `target: ProvisionedEntry` | → **预约** |
| `queue_cancelled` | `entryId` | ✗ 作废一个预约（这 entry 永远不会存在） |
| `usage` | `entryId` | ← 回指（给哪条消息记账） |
| `abort_requested` | — | **没有** |
| `operation_finished` | — | **没有** |

**9 种里只有 4 种带前向预约。** `abort_requested` 和 `operation_finished` 是纯管理动作，不产出 entry。

### 「record 是 entry 的载体」——方向反了

载体意味着 entry 依附在 record 上。实际是**交叉引用，谁也不包含谁**：

```
有 record 没 entry：  abort_requested、operation_finished、被 cancel 掉的队列项
有 entry 没 record：  session.appendMessage() 直接写、model_change、手工 appendCustomEntry
```

> **record = 工单，entry = 成品。工单上预先写好成品的编号。**
> 有些成品不走工单直接就做出来了；有些工单不产出成品。

两者唯一的关联就是那个 id 字符串。没有外键、没有嵌套、没有指针，就是两边写同一个字符串。

### ProvisionedEntry = 有内容、没位置

```ts
export type ProvisionedEntry<TEntry extends Entry = Entry> = TEntry extends Entry
	? Omit<TEntry, "parentId" | "seq" | "timestamp">
	: never;                                          // session/types.ts:76
```

砍掉的三个字段**全是「挂到树上那一刻才知道」的**。剩下的 `id` 和内容是提前定好的。

> **`ProvisionedEntry` = 稿子写好了、`id` 也发了，但还没贴到树上。**

于是恢复判定变成一次**存在性检查**：

```ts
function validateResultEntry(entriesById, resultEntryId, matches, description) {
	const entry = entriesById.get(resultEntryId);
	if (entry && !matches(entry)) { corrupt("provisioned_entry_mismatch", ...) }
}                                                     // reducer.ts:152
```

注意那个 `entry &&`——**entry 查不到是完全合法的**，只有「查到了但内容对不上」才算损坏。
这一行就是「半截 = 正常，反着来 = 损坏」的直接实现。

```
读到 tool_started { resultEntryId: "e7" }
   ├─ 树里有 e7？  ✅ 工具跑完、结果落盘了 → 跳过，往下走
   └─ 树里没 e7？  ❌ 崩在工具执行中 → 看 replay 字段决定重跑还是放弃
```

`tool_started.replay: "never" | "safe"` 就是给这一刻用的——`read` 可以重跑，`git push` 不能。

### 预约在什么阶段产生：**写 record 之前**

id 由 session 的生成器现场分配：

```ts
readonly idGenerator: IdGenerator;                                   // session.ts:104
this.idGenerator = options.idGenerator ?? { next: () => uuidv7() };  // session.ts:108
```

`readonly` 而且 **public**——就是给上层在写 record 之前先取 id 用的。

```
t0   const resultId = session.idGenerator.next()      ← 预约产生。纯内存，没落盘
t1   appendRecord({ type:"tool_started", resultEntryId: resultId, ... })   ← 预约落盘
        ─────────── 崩溃窗口 ───────────
t2   真去执行工具
        ─────────── 崩溃窗口 ───────────
t3   appendEntry({ id: resultId, type:"message", message: 结果 })          ← 兑现
```

崩在 t1 之前 → 什么都没有，当没发生过。崩在 t1~t3 之间 → **有单号没包裹 = 断点**。

用 `uuidv7` 不是随便挑的——它**时间有序**，提前分配的 id 天然带着分配时刻，不会和后来的 id 乱序。

### 两种预约体制（上游 §2.2）

区别在**内容什么时候有**：

**A. 只订号，内容还不知道**——assistant 回复、工具结果

```
resultEntryId: "e7"     ← record 里就一个字符串
```

内容要等 LLM / 工具返回才有。「订号不要钱」（*Reserving costs nothing*）。

**B. 内容先有，位置后定**——三个队列、延迟写

```
target: ProvisionedEntry { id: "e9", type: "message", message: {...} }
                            ↑ 号        ↑ 完整内容都在 record 里了
```

你 `steer("等一下")` 的那一刻内容就确定了，缺的只是「挂在树上哪儿」——那得等当前这轮跑完。

> **A 类：有位置没内容。B 类：有内容没位置。两类都靠同一个提前分配的 id 缝合。**

> **Record 对上层的意义一句话：它是「程序计数器」的持久化形式。**
> 恢复不需要重放整个日志，只需读最后几条 record，逐个问「你预约的 entry 到位了吗」，
> 第一个没到位的地方就是断点。

### 带子 vs 树

```
seq  lane        record                                     → 指向的 entry
──────────────────────────────────────────────────────────────────────────
 1   main        operation_started {id:r1, kind:"run"}       initialMessages:[e1]
 2   main        step_attempt      {runId:r1, attempt:1}     resultEntryId: e2
 3   main        usage             {cause:"assistant"}       entryId: e2
 4   main        tool_started      {runId:r1, replay:"safe"} assistantEntryId:e2 → resultEntryId:e3
 5   main        step_attempt      {runId:r1, attempt:1}     resultEntryId: e4
 6   main        operation_finished{runId:r1, completed}     —
 7   experiment  operation_started {id:r2, kind:"run"}       ...
```

**带子是线性的、按 `seq` 全局排、按 `lane` 分组；树是分叉的。**
带子上每一格都伸一根手指指向树上某个节点。

---

## 八、恢复流程完整走位

```
① session.findOpenOperations(lane)          有 operation_started 但没 finished 的
   session.findRecords({ lane })            这条 lane 的全部 record
   session.findEntries(...)                 相关 entry
        ↓  打包成
② RecordLogSlice { lane, openOperations, records, entries }   reducer.ts:46
        ↓
③ validateRecordLog(slice)      reducer.ts:312   ← ★ RecordLogCorruption 在这里 throw
        ↓  通过了才继续
④ reduceLaneState(input)        reducer.ts:506   第一行就是 validateRecordLog(input)
        ↓
⑤ LaneState                     reducer.ts:79
     operation.step      → 上次崩在「正在流式生成 assistant 回复」
     operation.toolBatch → 3 个工具调用，2 个有结果、1 个没有
     pendingSteer / pendingWrites / deferred
        ↓
⑥ peekAction() / executeAction()   照着 LaneState 决定下一个动作，接着跑
```

### 谁喊开始：`AgentHarness.create()`

即便是半成品，这段也把设计意图写清楚了（`agent-harness.ts:347`）：

```ts
static async create(options): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
	const [record] = await options.session.findRecords({ limit: 1 });
	if (record !== undefined) throw new HarnessNotImplemented("create.restore");
	return { harness: new AgentHarness(options), suspended: [] };
}
```

**打开会话时，先摸一条 record。**

```
findRecords({ limit: 1 })
   ├─ 一条都没有  → 全新会话，直接 new
   └─ 有          → 这个 session 之前跑过 operation → 走恢复路径
```

只需读一行，不用扫全文件。

#### 恢复是三步，而且刻意不自动

| 步骤 | 在哪 | v0.84.1 现状 |
|---|---|---|
| **检测** | `create()` 时摸 record | ✅ 骨架在 |
| **报告** | 返回 `suspended: SuspendedOperation[]` | ✅ 类型在 |
| **继续** | 调用方显式调 `lane.resume()` | ❌ `unavailable("resume")` (`:380`) |

> **`create()` 不会自己接着跑。** 它把「有这些操作挂在半路」交回给调用方，
> 由 UI 决定是恢复、丢弃、还是先问用户。
>
> 理由很实际——恢复可能重跑一个有副作用的工具，这不是框架能替你决定的。

#### `SuspendedOperation` 里最值得看的字段

```ts
export interface SuspendedOperation {
	lane: string;
	kind: "run" | "compaction" | "navigation";
	id: string;
	startedAt: number;
	reason: "crash" | "deferred";          // ← 区分「崩了」和「主动挂起等结果」
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };   // ★
}                                          // agent-harness.ts:140
```

- **`missing`** —— 恢复前先查：当时用的工具和模型现在还在不在。
  重启后改了配置、关掉某个工具、删了 provider → 这个 operation **恢复不了**，
  对应错误是 `MissingIdentities`（`:108` 的 `ResumeRejected`）
- **`reason`** —— 恢复不只服务崩溃。**主动挂起等异步结果**（`deferred`，比如 batch API）
  走的是同一套机制

### 完整走一遍

用户说「把 auth.ts 里的重复逻辑抽出来」，模型决定并行读两个文件。
读完第一个之后，进程被 kill。

#### 崩溃那一刻，磁盘上是这样

两边是**同一个文件**，`seq` 共用一个计数器，交替出现：

```
   树（entry，靠 parentId）              带子（record，靠 seq）
                                  │
        null                      │  seq1  operation_started {r1, initialMessages:[e1]}
         ↑                        │
   ┌──────────┐  seq2             │  seq3  step_attempt  {r1, resultEntryId:"e2"} ──┐
   │ e1  user │  "抽出重复逻辑"     │                                                 │
   └──────────┘                   │                                                 │
         ↑                        │                                                 │
   ┌────────────────────┐  seq4 ◄─┼─────────────────────────────────────────────────┘
   │ e2  assistant      │         │  seq5  usage         {r1, entryId:"e2"}
   │   toolCall A: read │         │
   │   toolCall B: read │         │  seq6  tool_started  {r1, toolIndex:0, toolCallId:"A",
   └────────────────────┘         │                       assistantEntryId:"e2",
         ↑                        │                       resultEntryId:"e3", replay:"safe"} ─┐
   ┌──────────────────┐  seq7 ◄───┼───────────────────────────────────────────────────────────┘
   │ e3  toolResult A │           │
   └──────────────────┘           │  seq8  tool_started  {r1, toolIndex:1, toolCallId:"B",
         ▲                        │                       resultEntryId:"e4", replay:"safe"} ──→ e4 ✗
   main.leafId = e3               │
                                  │        ✂ 进程死在这
```

`seq8` 那根箭头**指向一个不存在的节点**。这就是全部线索。

全程没有一行 `kind:"lane"`——因为一直是直线追加，指针隐式跟着走到 `e3`。

#### 第一步 · 把这条 lane 的东西捞出来

```
findOpenOperations("main")     →  [r1]        有 started，没 finished
findRecords({lane:"main"})     →  seq1,3,5,6,8
从 leafId=e3 沿 parentId 回溯   →  [e1, e2, e3]
```

打包成 `RecordLogSlice` 丢给 reducer。**到这儿为止一行业务逻辑都没有，纯查询。**

#### 第二步 · 建索引，然后对账

```ts
entriesById = { e1, e2, e3 }        // reducer.ts:511
```

| record | 预约 | 在吗 | 结论 |
|---|---|---|---|
| `operation_started.initialMessages` | `e1` | ✅ | 用户消息落盘了 → `missingInitialMessages: []` |
| `step_attempt` (seq3) | `e2` | ✅ | **模型回复完整落盘 → `step: null`，不重调 LLM** |
| `tool_started` (seq6) | `e3` | ✅ | 工具 A 干完了 |
| `tool_started` (seq8) | `e4` | ❌ | **断点。工具 B 没干完** |

#### 第三步 · 算出状态

```ts
LaneState.operation = {
	id: "r1", kind: "run", aborting: false,
	step: null,                        // ← LLM 那步是完成态
	toolBatch: {
		assistantEntryId: "e2",
		calls: [
			{ toolIndex: 0, toolCall: A, started: ✓, resultExists: true  },
			{ toolIndex: 1, toolCall: B, started: ✓, resultExists: false },  // ★
		],
		unresolved: true,
	},
	pendingSteer: [], pendingWrites: [], deferred: null,
}
```

上层照着 switch：`unresolved === true` → 下一个动作 `{ kind: "execute_tool", toolCallId: "B" }`。

`replay: "safe"` 说明 `read` 可以重跑。**如果这是 `git push`，标记会是 `"never"`，
恢复就直接报失败而不是重来。**

#### 恢复之后

```
   树                                     带子
        e2                          │  ... seq8 tool_started {B → e4}
        ↑                           │
       e3  toolResult A             │  seq9  entry e4                    ← 补上
        ↑                           │  seq10 step_attempt {r1, resultEntryId:"e5"}
   ┌──────────────────┐  seq9       │  seq11 entry e5
   │ e4  toolResult B │  ← 补上      │  seq12 operation_finished {r1, completed}
   └──────────────────┘             │
        ↑                           │
   ┌───────────────┐  seq11         │
   │ e5  assistant │  "抽好了"       │
   └───────────────┘                │
        ▲                           │
   main.leafId = e5                 │
```

**树上完全看不出这里崩过。带子上也只是正常往下写。**
没有回滚，没有补偿，没有重放——缺的那个节点补上去，接着往下长。

### 关键：谁说了算

| 问题 | 答案来自 |
|---|---|
| **这一轮该做几件事？** | **树** —— `e2` 的 content 里有几个 `toolCall` |
| **每件事做到哪一步了？** | **带子 + 树对账** —— record 的预约 id 在不在树里 |

```ts
const toolCalls = assistantEntry.message.content.filter(c => c.type === "toolCall"); // :462  ← 树
const started = starts.get(toolIndex);                                               // :477  ← 带子
const result = startedResult ?? blockedResult;                                       // :487  ← 对账
resultExists: result !== undefined,                                                  // :492
```

**所以哪怕 `seq8` 那条 record 也没写成**（崩得更早），结果一样：
`e2` 里明摆着有两个 toolCall，而 B 的结果 entry 找不到 → 照样是 `execute_tool B`。

> **真正的判据永远是「树上该有的节点在不在」。
> record 只是告诉你「这件事已经开工了、结果会叫什么名字」。**

### 上下文从哪来：树上重新取，不从 record

record 里**根本没有消息内容**（除了队列项那种 `ProvisionedEntry`）。恢复后要发给 LLM 的消息，
是沿树重新构建的：

```
leafId
   ↓  findEntriesOnBranch({ start: leafId })      沿 parentId 回溯
Entry[]
   ↓  buildSessionContext(pathEntries)            session/context.ts:90
{ messages, thinkingLevel, model, activeToolNames }
```

`SessionContext` 的形状正好是**发一次 LLM 请求需要的全部东西**：

```ts
export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	activeToolNames: string[] | null;
}                                          // session/context.ts:5
```

内部就是第二节那两条通路合起来：

```ts
const state = deriveSessionContextState(pathEntries);      // :94  → 三项配置
const contextEntries = buildContextEntries(pathEntries);   // :95  → 砍到最近的 compaction
const messages = contextEntries.flatMap(sessionEntryToContextMessages);  // :96  → 消息
return { ...state, messages };
```

#### 所以恢复是两半拼起来的

```
执行位置（程序计数器）  ← record 带子 → reduceLaneState     → LaneState
上下文内容（发什么）    ← entry 树    → buildSessionContext → messages
```

> **位置从带子来，内容从树来。**

#### 为什么「重新构建」是安全的

崩溃前那次请求的上下文**并没有被保存**，恢复时是从零重建的。这能成立靠三个条件：

1. **树是 append-only** —— 崩溃前的 entry 一条不少
2. **`leafId` 持久化了** —— 知道从哪儿开始回溯
3. **配置也在树上** —— `model_change` 等是 entry，重放路径就得到同样的配置

**同样的输入必然重建出同样的上下文。** 这就是第二节说「配置必须持久化」的实际后果——
否则重启后模型可能换了，恢复出来的请求和崩溃前那次不是同一个。

#### 配置：重推 vs 快照

上游把配置从树搬到了 lane 寄存器（**可变**），于是「重放得同样结果」这个保证没了。
所以它改成**快照**：

> The context snapshots configuration, stream options, and retry policy **inline**.（§4）
>
> **Reopen never rebuilds it from current settings**, so the provider sees the same
> summary input the hook approved.（§3.9）

| | v0.84.1 | 上游 |
|---|---|---|
| 配置存哪 | 树上的 entry（**不可变**） | lane 寄存器（**可变**） |
| 恢复时配置怎么来 | **重新推导**（`deriveEffectiveConfiguration`） | **快照在 `op.state` 里** |

> **两者是自洽的，不是谁改进了谁**——配置放在不可变的树上就能重推，
> 放在可变寄存器上就必须快照。选了后者，就得配套加快照。

### 那为什么还需要 record

只看树也能发现「e2 有两个 toolCall，只有一个 toolResult」。但有些事**树上留不下痕迹**：

| 情况 | 树上看得出来吗 |
|---|---|
| 工具 B 到底开工了没（有没有产生副作用） | ❌ 只有 `tool_started` 知道 |
| B 能不能重跑 | ❌ `replay` 标记只在 record 上 |
| 这次操作是 run / compaction / navigation | ❌ 只有 `operation_started.intent` |
| 用户 abort 过没有 | ❌ 只有 `abort_requested` |
| 有条 steer 消息排队等着，还没挂上树 | ❌ 内容整个在 `queue_enqueued.target` 里 |

> **树记「做成了什么」，带子记「打算做什么、以及做的过程中发生过什么」。
> 崩溃恢复要的是后者，但验证靠前者。**

### 和「重放日志」的区别

```
重放式（如 Redis AOF）：  从头把 N 条日志重新执行一遍  → O(N)，且要求操作幂等
pi 这套：                读最后几条 record 查一下 id   → O(1)，不重新执行任何东西
```

上游管这叫 **durable program counter**——恢复不是回放历史，是**读一个寄存器然后 switch**。

---

## 九、RecordLogCorruption

`validateRecordLog` 是第 ③ 步的守门员。注释（`reducer.ts:15`）整段都在说「什么**不**算 corruption」：

```ts
/**
 * Machine-readable category for a contradiction in a lane's durable recovery
 * slice. These indicate states the single-writer record protocol cannot
 * produce, not ordinary operation failures or incomplete-but-recoverable
 * intent/result prefixes. Restore must reject such states rather than repair or
 * continue it; the accompanying error message supplies human-readable detail.
 */
```

### 三个桶

| | 长什么样 | reducer 怎么办 |
|---|---|---|
| 普通失败 | `tool_started` 后跟一个 error 结果 entry | 照常 reduce，就是一个正常状态 |
| **不完整前缀** | `operation_started` 有、`operation_finished` 没有 | **照常 reduce**——恢复靠的就是它 |
| **corruption** | 违反单写者协议的矛盾 | **throw，拒绝启动** |

> **半截 = 正常，反着来 = 损坏。**

### 定义：单写者协议写不出来的状态

写入协议是「**单写者、按 `seq` 单调追加**」。12 个 reason 全是这前提下**物理上写不出来**的：

```ts
corrupt("multiple_open_operations", `Lane ${input.lane} has at least two open operations`);  // :314
corrupt("record_after_finish", `Record ${record.id} follows the finish of operation ...`);   // :340
corrupt("non_consecutive_attempt", `... attempt is ${record.attempt}; expected ...`);        // :194
```

看到这些只有一个解释：**日志被外力改过**——手工编辑、位翻转、两个进程抢同一文件、上游有 bug。

### 为什么是 reject 而不是 repair

日志已经自相矛盾，说明你对「发生过什么」的认知不可靠了。
此时「修复」出来的状态是**编造**的——工具可能真跑过、副作用已经落地，你却当它没发生。
**继续跑会把一次数据损坏放大成一串错误的副作用。**

所以 `corrupt()` 的返回类型是 `never`（`reducer.ts:131`）——签名上就宣告这条路走不通。

### reason 与 message 的分工

```ts
export class RecordLogCorruption extends Error {
	readonly reason: RecordLogCorruptionReason;   // 12 个字面量，给代码 switch / 打点 / 断言
	constructor(reason, message) { super(message) } // 自由文本带具体 id，给人看
}
```

**不要去 parse message。**

> 📌 全仓库唯一读 `.reason` 的地方是 `test/harness/reducer.test.ts:298` 的 `expectCorruption(input, reason)`。
> 又一例「**符号存在 ≠ 主路径在用**」——这次是**为未来的可观测性预留、还没接消费者**。
> 见 [agent-factcheck.md](./agent-factcheck.md)。

`validateRecordLog` 是独立函数、注释写着 "without reading or mutating session state"（`reducer.ts:311`）：
**纯函数、只看这一片切片、先验后归约。**

---

## 十、对照 LangGraph

方向上是同一类东西——都是「把执行状态持久化，好在崩溃后接着跑」。但有一处关键差异，
而且 **"reducer" 这个词两边意思正好相反**。

### 先纠一个直觉

LangGraph 里 **state 不是每个节点一份**——是全图共享**一个** state 对象，节点只返回增量，
checkpoint 落在 **super-step 之间**。pi 这边也一样：`LaneState` 是**每条 lane 一份**，
不是每个 entry 一份。Entry 是数据，不带执行状态。

```
LangGraph:  thread_id  →  一个 state     →  节点之间存 checkpoint
pi:         lane       →  一个 LaneState →  从日志算出来
```

`thread_id` ≈ `lane`。

### 两个 reducer 是反的

| | LangGraph 的 reducer | pi 的 `reduceLaneState` |
|---|---|---|
| 是什么 | channel 合并函数，`Annotated[list, add_messages]` | 从日志重建状态的函数 |
| 什么时候跑 | **写入时**——把节点返回的增量合进 state | **读取时**——重启时才跑 |
| 持久化的是 | **累加器**（fold 的结果） | **事件**（fold 的输入） |

```
LangGraph:  state_new = reducer(state_old, update)  → 存 state_new
pi:         存 record/entry，重启时才 reduce 出 LaneState
```

经典的 **snapshot vs event sourcing**。pi 那 667 行 reducer 在 LangGraph 里根本不存在——
因为 LangGraph 直接把 state 序列化存了。

### 真正重要的差异：恢复粒度

**LangGraph 的恢复点在节点之间，pi 的恢复点在节点内部。**

一个节点先调 LLM 再跑工具，崩在工具执行中：

```
LangGraph:  回到节点入口 checkpoint → 整个节点重跑 → LLM 被重新调一次（重新计费）
pi:         assistant entry 已落盘 → 不重调；只重跑没完成的那个工具
```

这就是为什么 LangGraph 的最佳实践是**把节点切小、做幂等**——粗粒度恢复的代价靠拆节点来摊。
pi 换了思路：不要求你拆细，而是在**每个不确定动作前后各写一笔**，断点天然细到单个工具调用。
还多了 LangGraph 没有的 `replay: "never" | "safe"`。

### 对照表

| | LangGraph | pi harness |
|---|---|---|
| 执行单元 | node（图） | operation → step → tool（线性） |
| 状态归属 | thread | lane |
| 持久化 | state 快照（checkpointer） | 意图 record + 结果 entry |
| 恢复粒度 | super-step 边界 | **动作内部** |
| 重跑安全性 | 你自己保证幂等 | `replay: never/safe` 标记 |
| 分支 | checkpoint 树 + `update_state` | entry 树 + lane 指针 |
| 时间旅行 | ✅ 指定 checkpoint_id | ✅ `navigateTree(entryId)` |
| 并发 | 图内并行分支 | 多 lane |
| 复杂度 | 存个 dict，简单 | 667 行 reducer + 12 种损坏类型 |

分支那行两边很像：都是「指针回退 + 继续追加」。

> **LangGraph 存的是「现在是什么状态」，pi 存的是「我打算做什么 / 做完了没」。**
> 前者简单、恢复粗；后者复杂、恢复能精确到一次工具调用中间。

📌 **改造自己的项目时的取舍**：每步都很贵（长 LLM 调用、有外部副作用的工具）→ pi 的细粒度值钱。
每步都便宜可重跑 → LangGraph 的快照法省事得多，**你不用写那 667 行**。
折中方案：**抄 pi 的「entry 树 + lane 指针」分支模型，恢复先做快照版。**

---

## 十一、Day 6 五问

schedule 里 harness 的定义是「会话存哪、上下文超了怎么办、工具从哪来、崩了怎么恢复、状态怎么给 UI 看」。
逐条答，**每条分两代看**——`harness/`（第二代，写完没接）和 `coding-agent/core/`（第一代，实际在跑）。

### ① 会话存哪

**一个 append-only 的 JSONL 文件，一行一条，永不修改已有行。**

```
~/.pi/agent/sessions/<cwd 编码>/<时间戳>_<uuid>.jsonl
```

- 目录：`join(resolvedAgentDir, "sessions", safePath)`（`session-manager.ts:480`）
- 文件名：`${fileTimestamp}_${this.sessionId}.jsonl`（`:953`）

`session-manager.ts:845` 的类注释直接点题：
*"Manages conversation sessions as **append-only trees** stored in JSONL files."*

| | 第一代 v3 | 第二代 v4 |
|---|---|---|
| 一行是什么 | 只有 **entry** | `kind` 四选一：`entry` / `record` / `lane` / `fact` |
| 树 | ✅ `parentId` | ✅ 同样 |
| 执行日志 | ❌ 没有 | ✅ record 带子 |
| 多游标 | ❌ | ✅ lane |
| 后端可换 | ❌ 写死 JSONL | ✅ `SessionStorage` 接口 + JSONL / InMemory 两实现 + 993 行 conformance |

#### v3 和 v4 是同一条版本线

```
v1  ─→  v2  ─→  v3          coding-agent/core/session-manager.ts
                  └──→  v4  agent/src/harness/session/jsonl/
```

```ts
export const CURRENT_SESSION_VERSION = 3;              // session-manager.ts:30
version?: number;  // v1 sessions don't have this      // :34
const version = header?.version ?? 1;                  // :283
if (version < 2) migrateV1ToV2(entries);               // :287
if (version < 3) migrateV2ToV3(entries);               // :288
```

harness 明确知道 v3 的存在——**不是两套并行格式，v4 要读 v3**：

```ts
sourceFormat: 3 | 4;                                                  // jsonl/types.ts:30
/** Present only when a v3 parent path could not be resolved to a session id. */
legacyParentSessionPath?: string;                                     // jsonl/types.ts:31
```

上游文档也提到 *"Fresh or **normalized-v3** `main` may temporarily lack `lane.config`"*（§2.3）。

头一行的三处变化，都能对上前面讲过的东西：

```jsonl
v3  {"type":"session","version":3,"id":"019ff716-...","timestamp":"2026-08-12T17:47:49.253Z","cwd":"..."}
v4  {"kind":"header","version":4,"id":"...","createdAt":...,"cwd":"...","parentSessionId"?:...}
```

| | v3 | v4 | 为什么 |
|---|---|---|---|
| 判别键 | `type` | **`kind`** | v4 要区分四种行，`type` 得让给「哪种 entry」 |
| 时间 | `timestamp` ISO 字符串 | `createdAt` 数字 | 统一成 epoch ms |
| 父会话 | 路径 | **`parentSessionId`** | fork 要能可靠指回去，路径会变 |

第一条最说明问题：**v3 只有一种行，`type` 够用；v4 有四种行，只好在外面套一层 `kind`。**
这就是前面「两级判别式」的由来。

### ② 上下文超了怎么办

**压缩：把前面全部历史换成一条摘要 entry。**

三个触发原因 `"manual" | "threshold" | "overflow"`：

| 原因 | 什么时候 | 出处 |
|---|---|---|
| `threshold` | **主动**——算出来快满了 | `shouldCompact()` |
| `overflow` | **被动**——LLM 真报了超限错，事后补救 | `agent-session.ts:1998` |
| `manual` | 用户敲 `/compact` | — |

阈值判定只有一行：

```ts
export function shouldCompact(contextTokens, contextWindow, settings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}                                                    // compaction/compaction.ts:247

export const DEFAULT_COMPACTION_SETTINGS = {
	enabled: true,
	reserveTokens: 16384,      // 给摘要 prompt 和输出留的
	keepRecentTokens: 20000,   // 压缩后保留的近期上下文
};                                                   // compaction/compaction.ts:158
```

产物是一条 entry：

```ts
interface CompactionEntry { summary: string; retainedTail: AgentMessage[]; tokensBefore: number }
```

然后读上下文时**不读过压缩点**：

```ts
return compaction === undefined ? [...pathEntries] : [compaction, ...pathEntries.slice(compactionIndex + 1)];
                                                     // session/context.ts:45
```

> 上游原话：*"Every compaction stores a complete `retainedTail`. **Context never reads past a compaction.**
> This is what makes a compaction a **self-contained checkpoint** rather than a pointer into history."*

**防死循环**（压完还是超 → 再压 → 无限）两代都做了：

```ts
private _overflowRecoveryAttempted = false;   // gen1  agent-session.ts:329   裸布尔
const overflowRecoveryUsed = ...              // gen2  reducer.ts:587         用「上次消费新输入」当水位线
```

### ③ 工具从哪来

**构造时注入的一个数组。框架本身不持有任何工具。**

```ts
export interface AgentHarnessOptions {
	tools?: HarnessTool[];
	toolContext?: object | (() => object | Promise<object>);
	activeToolNames?: string[];
	...
}                                                    // agent-harness.ts:243
```

三层来源：

```
① 内置        harness/tools/           4 个：bash / read / edit / write        1190 行
              coding-agent/core/tools/ 再加 grep / find / ls 等                4142 行
② 扩展        beforeToolCall / afterToolCall 拦截、包装、拦下
③ 开关        activeToolNames 决定这一轮哪些启用
```

三个要点：

- **工具是工厂，不是单例。** 全是 `createBashTool()` / `createReadTool()`，泛型于 `ExecutionToolContext`
  ——工具不知道自己跑在什么环境里
- **只有 4 个内置的，没有 grep/find/ls。** 那些在 coding-agent 里，这是「库」和「产品」的分界线
- **`activeToolNames` 是分支状态**（v0.84.1 是 `active_tools_change` entry，上游改成 lane 寄存器），
  所以「这条分支上开了哪些工具」可回溯

### ④ 崩了怎么恢复

**详见[第八节](#八恢复流程完整走位)。** 这里只记两代的差别：

| | 重启后能拿回来吗 |
|---|---|
| 对话历史 | 两代都 ✅ 从 JSONL 读回整棵树 |
| 正在跑的工具 | gen1 ❌ / gen2 ✅ |
| steer / followUp 队列 | gen1 ❌ / gen2 ✅ |
| 当前 operation | gen1 ❌（没这个概念）/ gen2 ✅ |

**第一代不是没写恢复，是数据格式里就没有这个东西**——v3 只有 entry，
没有任何 `tool_started` 的对应物，**结构上就无法知道有个工具跑到一半**。

`session-manager.ts:890` 那个 `resume` 的注释是
*"Switch to a different session file (used for resume and branching)"*
——**它的 resume 是「换个文件重新加载」，不是「接着上次跑」。**

> **第一代能恢复「说过什么」，恢复不了「干到哪了」。这就是第二代整个 record 带子存在的全部理由。**

### ⑤ 状态怎么给 UI 看

**第一代推事件，第二代快照 + 订阅。这是两代差别最大的一处。**

#### 第一代：纯事件流

```ts
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>              // agent 层原有的
	| { type: "agent_end"; messages; willRetry }
	| { type: "queue_update"; steering; followUp }
	| { type: "compaction_start" | "compaction_end"; reason; ... }
	| { type: "entry_appended"; entry }
	| { type: "auto_retry_start" | "auto_retry_end"; attempt; ... }
	| { type: "bash_execution_update"; id?; delta }
	| ... 共 20 来种                                          // agent-session.ts:141

private _emit(event: AgentSessionEvent): void { ... }        // :563  广播给 _eventListeners
```

**UI 必须自己跟着事件流从零攒状态。** 中途接进来、或者刷新一下，就什么都没有了。

#### 第二代：先给全量，再给增量

```ts
watch(): Promise<WatchHandle<LaneSnapshot>>;                  // agent-harness.ts:302

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;                                      // ← 立刻给一份完整的
	start(listener: (event: unknown) => void): void;          // ← 然后订阅增量
	unsubscribe(): void;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];                                      // 完整对话
	leafId: string | null;
	operation: { id; kind; status } | null;                   // 在跑什么
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: { id; entry }[];
	faulted: boolean;
}                                                             // agent-harness.ts:167
```

> **任何时候接进来都能先拿一份全量，不用重放历史事件。**

这对多端（CLI + Web + Slack 同时看一个 session）几乎是必需的。
第一代做不到，因为它没有一个「当前状态」的完整表示——状态散在 `AgentSession` 的实例字段里。

**第二代能做到，正是因为有 `reduceLaneState`**：状态是算出来的，随时能算一份完整的给你。

### 汇总

| 问题 | 第一代（在跑） | 第二代（写完没接） |
|---|---|---|
| **会话存哪** | JSONL v3，只有 entry | JSONL v4，四种行；后端可换 + 一致性套件 |
| **超了怎么办** | 压缩，三种触发 | **一样**（`compaction/` 两边几乎平行） |
| **工具从哪来** | 构造注入，8+ 个 | 构造注入，4 个 |
| **崩了怎么恢复** | ❌ 只恢复对话 | ✅ 精确到单个工具调用中间 |
| **状态给 UI** | 推事件，UI 自己攒 | 快照 + 订阅 |

> **两代真正的差异只有两处：崩溃恢复、UI 状态获取。而这两处是同一个根因**
> ——第二代把状态从「实例字段」改成了「从日志算出来」。
>
> 会话格式、压缩策略、工具注入方式，两代基本一样。

### 📌 对改造项目的直接结论

- **压缩逻辑照抄第一代**（`shouldCompact` 三行 + 一条 compaction entry + 不读过压缩点），够用，别自己发明
- **存储照抄第二代的接口**（`SessionStorage` + conformance），因为你迟早要换后端
- **UI 用 `watch()` 那个形状**（快照 + 订阅），比纯事件流省很多事
- **崩溃恢复先做简单版**：只恢复对话，工具跑一半就当没跑（第一代就是这么活的）。
  等你的工具真有外部副作用了，再上 record 那套

---

## 十二、速查

```
Session  ── 一个 JSONL 文件
  ├─ Entry   树  parentId   分支状态   → 喂 LLM / 算配置
  ├─ Record  带  seq+lane   执行过程   → 只给恢复
  ├─ lane    指针移动日志    {kind:"lane", lane, leafId}
  └─ fact    会话元数据      name / label

Lane      = LanePointer{ lane, leafId }        ≈ git branch
分支产生   = 指针回退 + 继续追加                ≈ git checkout HEAD~n && commit
Record    = 对未来某个 Entry 的预约
恢复      = 读 record → 查 entry 在不在 → 第一个不在的就是断点
           位置从带子来（LaneState），内容从树来（buildSessionContext）
           触发在 AgentHarness.create()，但不自动跑——交回 suspended[] 给调用方
corruption= 单写者协议写不出来的矛盾 → throw，绝不修复

判据口诀 = 「该做几件事」问树，「做到哪一步」拿 record 的预约 id 去树里查
预约时机 = 写 record 之前用 session.idGenerator.next() 分配，uuidv7 时间有序
lane 落盘 = 只有 leafId；配置/队列/operation 全是算出来的（上游改成了寄存器）
```

关键文件与行号：

| 文件 | 行 | 内容 |
|---|---|---|
| `session/types.ts` | 14 / 80 | `EntryBase` / `RecordBase` |
| `session/types.ts` | 76 | `ProvisionedEntry` |
| `session/types.ts` | 262 | `LanePointer` |
| `session/context.ts` | 5 / 65 / 90 | `SessionContext` / `sessionEntryToContextMessages` / `buildSessionContext` |
| `reducer.ts` | 15 | `RecordLogCorruptionReason` 注释 |
| `reducer.ts` | 79 | `LaneState` |
| `reducer.ts` | 312 / 506 | `validateRecordLog` / `reduceLaneState` |
| `reducer.ts` | 400 | `deriveEffectiveConfiguration` |
| `jsonl/storage.ts` | 123 / 133 / 143 | `createLane` / `moveLane` / `appendEntry` |
| `jsonl/codec.ts` | 6 / 182 | `ENTRY_TYPES` 白名单 / `encodeMutation` |
| `session/state.ts` | 112 / 121 | 「必须接在 leaf 上」硬校验 / 追加后隐式挪指针 |
| `session/session.ts` | 104 / 108 | `idGenerator` —— 预约 id 从这来 |
| `reducer.ts` | 445 / 492 | `deriveToolBatch` / `resultExists` 对账 |
| `agent-harness.ts` | 167 / 211 / 243 / 271 | `LaneSnapshot` / `Hooks` / `AgentHarnessOptions` / `AgentLane` |
| `agent-harness.ts` | 140 / 347 / 380 | `SuspendedOperation` / `create()` 恢复触发点 / `resume()` |
| `harness/types.ts` | 315 | `ExecutionEnv extends FileSystem, Shell` —— 对外部世界的唯一依赖 |
| `compaction/compaction.ts` | 158 / 247 | 默认设置 / `shouldCompact` |
| `coding-agent/core/session-manager.ts` | 30 / 480 / 890 | `CURRENT_SESSION_VERSION=3` / 存储路径 / resume 注释 |
| `coding-agent/core/agent-session.ts` | 141 / 563 | `AgentSessionEvent` 联合 / `_emit` |
