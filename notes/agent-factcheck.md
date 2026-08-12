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

## 两个案例的共同结论

| | 案例 1（pi 生成架构笔记） | 案例 2（Claude 解释类型） |
|---|---|---|
| 对的部分 | 逐字读自 `package.json` 的事实 | 逐行读自 `types.ts` 的语法拆解 |
| 错的部分 | 从包名/文件名推断的职责 | 从类型分支推断的实际用法 |
| 共同错因 | **符号的存在 ≠ 事实** | 同左 |

**可操作的防御**：任何关于"X 是干什么用的"的断言，先跑一次 `grep -c` 数调用点。成本几秒钟，能拦住这一整类错误。

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
