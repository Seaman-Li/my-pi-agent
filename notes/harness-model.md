# harness 数据模型 —— Session / Lane / Entry / Record

> Day 6 产出。`packages/agent/src/harness/`，基于 `v0.84.1`。
> 读 `reducer.ts`（667 行）和 `agent-session.ts`（3342 行）之前先建这张地图，否则一定晕。
>
> ⚠️ 前置事实：整个 `harness/` 树目前**没有任何生产调用方**，pi 自己的 coding-agent 走的是 `AgentSession`
> 这条老路。但除 `agent-harness.ts` 外全部模块零未实现标记、全部有测试——**积木都做好了，缺的是指挥**。
> 详见 [architecture-map.md](./architecture-map.md)。

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

## 二、Entry：7 种类型，两条消费通路

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

**它们身上都挂着一个指向 Entry 的字段**——这就是 Record 对上层的全部意义：

| Record | 指向 Entry 的字段 |
|---|---|
| `step_attempt` | `resultEntryId` |
| `tool_started` | `assistantEntryId` + `resultEntryId` |
| `queue_enqueued` | `target: ProvisionedEntry` |
| `write_deferred` | `target: ProvisionedEntry` |
| `usage` | `entryId` |
| `operation_started` | `intent.initialMessages: ProvisionedEntry[]` |

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

崩溃走位示例——日志停在 `seq 4`，树里查不到 `e3`：

```
findOpenOperations("main") → [r1]  还开着
validateRecordLog(slice)          → 过（有 started 没 finished 是正常前缀）
reduceLaneState(...)              → LaneState.operation.toolBatch = {
                                        assistantEntryId: "e2",
                                        calls: [{ started: ✓, resultExists: false }],
                                        unresolved: true }
peekAction()                      → { kind: "execute_tool", toolCallId, toolName }
```

**一个 register 就定位到断点，没有重放。**

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

## 十、速查

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
corruption= 单写者协议写不出来的矛盾 → throw，绝不修复
```

关键文件与行号：

| 文件 | 行 | 内容 |
|---|---|---|
| `session/types.ts` | 14 / 80 | `EntryBase` / `RecordBase` |
| `session/types.ts` | 76 | `ProvisionedEntry` |
| `session/types.ts` | 262 | `LanePointer` |
| `session/context.ts` | 65 | `sessionEntryToContextMessages` —— 唯一 Entry→消息 |
| `reducer.ts` | 15 | `RecordLogCorruptionReason` 注释 |
| `reducer.ts` | 79 | `LaneState` |
| `reducer.ts` | 312 / 506 | `validateRecordLog` / `reduceLaneState` |
| `reducer.ts` | 400 | `deriveEffectiveConfiguration` |
| `jsonl/storage.ts` | 123 / 133 / 143 | `createLane` / `moveLane` / `appendEntry` |
| `jsonl/codec.ts` | 6 / 182 | `ENTRY_TYPES` 白名单 / `encodeMutation` |
| `agent-harness.ts` | 271 | `AgentLane` 接口 |
