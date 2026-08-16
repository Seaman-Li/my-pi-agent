# Agent 生成文档的纠错记录

> 一份小样本案例：让 pi 总结自己的架构（[infra_learning.md](infra_learning.md)），再逐条人工核对，看它哪里对、哪里错、错在什么模式上。

## 为什么留这份记录

`pi-suggested-reading.md` 和 `infra_learning.md` 本身作为架构笔记的价值有限——它们能提供的信息，你两周读完源码后都会有，而且更准。

**真正的价值在于：它们是"agent 在陌生代码库上做架构理解"的一份留痕。** 你要做自己的 agent，迟早要面对"我的 agent 输出的东西可信吗、哪里不可信、怎么让它更可信"。这份记录是一个可复现的样本。

所以 `infra_learning.md` 的错误**没有被直接改掉**，而是就地标注为 `⚠️ 实测修正`。抹掉错误就抹掉了样本。

---

## 核对结果

样本：1 份文档、约 150 行、含 20 余条可验证断言。

### ✅ 全部正确的部分

| 断言 | 核对方式 |
|---|---|
| 9 个包 lockstep 版本 `0.84.1` | 逐个读 `package.json` 的 `version` |
| `evals` 是私有包 | `private: true` |
| `agent` 依赖 `ai` + `telemetry` | 读 `dependencies` |
| `coding-agent` 依赖 `agent-core, ai, client, protocol, tui` | 五个全中 |
| 构建顺序 `tui → telemetry → ai → agent → sqlite-node → protocol → client → server → coding-agent` | **与根 `package.json` 的 build 脚本逐字对应** |
| 分层结构、数据流方向 | 与实际依赖图一致 |

### ⚠️ 三处错误

| # | 错误断言 | 实际情况 |
|---|---|---|
| 1 | `server` 属于「暴露代理会话」层 | 依赖 `ai` + `protocol`，**不依赖 `agent`** |
| 2 | 「`coding-agent` 提供 read/bash/edit/write 工具」 | **两层各有一套独立实现**，同名文件行数差 2–7 倍 |
| 3 | 「模型元数据通过代码生成 `models.generated.ts`」 | 真实数据源 `providers/data/` **被 gitignore，构建时联网现拉** |

---

## 错误的共同模式

把对与错分开看，界线相当清晰：

> **它读过的 → 准确。它推断的 → 出错。**

- **全对的那些**，都能在单个文件里**逐字读到**：`package.json` 的 `version`、`dependencies`、`scripts.build`。构建顺序那条尤其能说明问题——九个包的顺序一字不差，这不可能靠猜，只能是打开了根 `package.json`。
- **三处错误**，都是**没有打开对应文件、靠命名和常识推断**的结果：
  - 「工具在 coding-agent 层」——从包的职责推断，合理但错。只要 `ls` 一下 `packages/agent/src/harness/tools/` 就会发现两层都有。
  - 「`server` 暴露代理会话」——从包名推断。读 `dependencies` 就会发现它根本不依赖 `agent`。
  - 「元数据通过代码生成」——从 `models.generated.ts` 这个**文件名**推断。少查了一步 `.gitignore`。

三处错误全部落在「**看起来理所当然、因此没去验证**」的位置。这不是随机出错，是**验证成本与置信度错配**：越是符合直觉的结论，越不会被去查证，也就越容易带着错误通过。

## 对做 agent 的启示

从这个样本能提出几条待验证的假设（样本量为 1，是假设不是结论）：

1. **区分"读到的"和"推断的"**。如果让 agent 在输出里标注每条断言的来源（哪个文件哪一行 vs 推断），可信度会立刻分层。pi 本身没这么做。
2. **对"理所当然"的断言反而要强制验证**。反直觉的结论人会自然去查，符合直觉的不会——而错误恰恰藏在后者。
3. **命名是最不可靠的证据**。三处错误里有两处直接源于从名字推断内容（`server` 包名、`models.generated.ts` 文件名）。
4. **结构性事实比语义性事实可靠**。依赖关系、版本号、构建顺序这类能机械提取的，agent 做得很好；「这个包负责什么」这类需要理解和归纳的，才是出错区。

第 4 条对你设计自己的 agent 有直接用处：**能用工具确定性获取的，就不要让模型去总结**。

---

# 案例 2：同一模式，这次是 Claude 犯的

Day 2 读 `types.ts` 时，围绕 `UserMessage.content: string | (TextContent | ImageContent)[]` 这一行，连续出了两次错。**错因和案例 1 完全一样**，所以一并记下。

## 错误经过

**错误 A**：断言「你跑 `-p "1+1等于几"` 走的就是 `string` 分支」。

用户直接翻自己的 JSONL 反驳：

```json
{"role":"user","content":[{"type":"text","text":"1+1等于几"}]}
```

存的是数组。三份会话全查了，无一例外。

**错误 B**：改口说「`string` 是给**程序化调用方**留的口子」。仍然错。实际数一遍调用点：

| 场景 | 裸字符串 | 数组 |
|---|---|---|
| `packages/ai/test/` | **181 处** | 6 处 |
| `packages/*/src/` 生产代码 | **1 处** | 全部 |

真实主力用户是**测试代码**。连 SDK 也用不到——`session.prompt("...")` 的字符串是**方法参数**，`agent-session.ts:1399` 进去就包成数组：

```ts
const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
```

## 错因

两次都是**从"类型允许"推断"实际会这么用"**，没去数调用点。

> **类型描述的是可能性空间，数据才是事实。**

这和案例 1 里 pi 从包名推断职责、从文件名推断生成方式，是同一个动作——**用符号的存在替代对事实的查证**。

对读 `packages/ai` 尤其要警惕：这一层为兼容 N 家 provider 故意留了大量宽松分支，**实际走到的往往只是其中一条**。看到一个联合类型的分支，先问"谁在用"，再问"用了多少次"。

## 顺带得到的一个设计观察

`string` 分支的账目很清楚：

- **收益**：181 处测试代码书写变短
- **成本**：8 处 `typeof content === "string"` 分散在各 adapter，每个生产实现都要背

更干净的做法是提供测试辅助函数而非把宽容度做进核心类型——`packages/ai/src/providers/faux.ts:52` 的 `fauxText()` 就是这个思路。

**做自己的 agent 时记这一笔**：类型里每多一个可选形态，下游每个消费点就多一个分支。宽容的 API 不免费，成本被推给所有实现者。`coding-agent` 层的做法反而值得学——**上层自己收窄，只用一种形态**，把宽容度留在下层不去碰。

---

# 案例 3：`grep -c` 也不够 —— 符号存在 ≠ 主路径在用

案例 2 给出的防御是「先 `grep -c` 数调用点」。Day 3–5 连着撞上六次同类问题后，发现**这条防御本身有漏洞**。

## 六个实例

| # | 符号 | src 引用 | test 引用 | 真实地位 |
|---|---|---|---|---|
| 1 | `getModelsPath()` | **0**（只有自身定义） | 37 | 死代码，路径逻辑在别处 |
| 2 | `UserMessage.content` 的 `string` 分支 | 1 | 181 | 测试便利，非 SDK 口子 |
| 3 | `agent/harness/tools/`（bash/read/edit/write） | pi CLI 不用 | — | 给 SDK 的最小实现 |
| 4 | `createCodingAgentHarness` | **0** | 6 | 对外入口 |
| 5 | `agentLoop` / `agentLoopContinue` | **0**（唯一一处是注释） | 24 | 公开 API，pi 走 `Agent` 类 |
| 6 | `getDefaultStreamFn()` | 3 处 `??` 兜底，**全是死分支** | 0 | 老扩展的兜底门 |

复核命令：

```bash
for s in getModelsPath createCodingAgentHarness agentLoop getDefaultStreamFn; do
  src=$(grep -rn "\b$s\b" packages/*/src | grep -v "export function" | wc -l)
  tst=$(grep -rn "\b$s\b" packages/*/test | wc -l)
  printf "%-26s src=%-4s test=%s\n" "$s" "$src" "$tst"
done
```

## 漏洞在哪

`getModelsPath` 有 **37 处**引用。光看 `grep -c` 的数字，它像是个核心函数——**但 37 处全在 `test/`，`src/` 里一处都没有。**

> **数量回答不了「谁在用」，只回答了「有多少人提到」。**

案例 1、2 的错因是「符号存在 ≠ 事实」；案例 3 是它更隐蔽的一个特化：**符号确实被用了，只是用它的不是主路径。**

## 修正后的防御

```bash
# ❌ 不够
grep -rc "symbol" packages/

# ✅ 分目录数，看比例
grep -rn "symbol" packages/*/src  | grep -v "export function\|export \*" | wc -l
grep -rn "symbol" packages/*/test | wc -l
```

三条判据，按可靠性排序：

1. **`src` 计数为 0** → 一定不是主路径（可能是公开 API 或死代码，看它有没有从 `index.ts` 导出）
2. **`src` 计数远小于 `test`** → 大概率是测试便利设施
3. **`src` 里的引用全是 `??` / `if` 兜底分支** → 是降级路径，不是主路径 ← **最隐蔽的一种，计数看不出来，必须读上下文**

第 3 条是 `getDefaultStreamFn` 那次踩到的：它在 `src` 里有 3 处调用，数字上完全正常，但 `agent-loop.ts:116/141` 的调用方永远传非空值，`agent.ts:222` 也被 `sdk.ts:302` 的显式 `streamFn` 短路。**三处全部不可达。**

## 根因：这个仓库同时是产品和 SDK

```
packages/agent   ─┬─→ pi 自己用（走 Agent 类 + coding-agent 的厚包装）
                  └─→ 对外暴露（index.ts 全量 export *）
```

`packages/agent/src/index.ts:45` 一句 `export * from "./agent-loop.ts"` 就把四个入口全部公开了。**公开 API 面比自用面大得多**，所以：

> **凡是看起来"基础"「默认」「最小实现"的东西，往往是给外部用的；pi 自己走的是更厚的那条路。**

- 基础工具集（`agent/harness/tools/`）↔ pi 用的是带权限和渲染的完整版
- 默认 streamFn ↔ pi 用的是带重试、超时、header 注入的包装器
- `agentLoop`（EventStream 风格）↔ pi 用的是 `Agent` 类的事件分发

## 对做 agent 的启示

案例 1 得出的第 4 条是「能用工具确定性获取的，就不要让模型去总结」。案例 3 把它推进一步：

**工具本身也可能给出误导性的确定性数字。** `grep -c` 返回 37 是一个精确、可复现、完全正确的数字——但用它回答"这个函数重要吗"就是错的。

设计 agent 的检索工具时，这意味着：

- 返回**分组后的**计数（按目录/按用途），而不是一个总数
- 对"是否被使用"这类问题，把**调用点上下文**一起返回，让模型能看出是不是死分支
- 一个数字加一句结论，比十行原始输出更容易骗过自己

---

## 三个案例的共同结论

| | 案例 1（pi 生成架构笔记） | 案例 2（Claude 解释类型） | 案例 3（Claude 判断地位） |
|---|---|---|---|
| 对的部分 | 逐字读自 `package.json` | 逐行读自 `types.ts` 的语法 | 符号确实存在、确实被引用 |
| 错的部分 | 从包名/文件名推断职责 | 从类型分支推断实际用法 | 从引用计数推断重要性 |
| 错因 | 符号存在 ≠ 事实 | 类型允许 ≠ 实际这么用 | **被引用 ≠ 主路径在用** |
| 防御 | 打开文件读 | `grep -c` 数调用点 | **分 src/test 数，并读调用点上下文** |

三条是层层递进的：每一条防御都能挡住上一层的错误，然后在下一层失效。

**当前最强的可操作防御**：任何关于"X 是干什么用的 / 重不重要"的断言，跑一次分目录计数，并**打开 `src` 里的调用点确认它不是兜底分支**。成本十几秒，能拦住这三整类错误。

---

## 复现方法

想再采一个样本（比如换个模型、换个仓库）：

```bash
cd /Users/simonli/Downloads/MyProjects/PiAgent
./pi-test.sh --model dashscope/qwen3.7-plus -p "总结这个 monorepo 的架构：包依赖层次、各包职责、构建顺序"
```

然后用同样的方式逐条核对——依赖看 `package.json`，文件归属用 `ls`，生成物看 `.gitignore`。对比两次的错误是否落在同类位置，就能判断上面那个模式是普遍的还是偶然的。

---

## 相关

- [infra_learning.md](infra_learning.md) — 被核对的原文（含就地标注）
- [pi-suggested-reading.md](pi-suggested-reading.md) — pi 自荐的阅读顺序，与实际日程的分歧也有信息量
- [../STUDY-SCHEDULE.md](../STUDY-SCHEDULE.md) — 实际执行的 14 天日程
