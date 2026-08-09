# Pi 架构 14 天学习日程

配套文档：[LEARNING-PLAN.md](LEARNING-PLAN.md)（环境、分支、阅读路线的总纲）

**前提**：每天 2–3 小时，目标偏理解（读懂为主，关键节点配小实验验证）。代码锚定在 `v0.84.1`，工作分支 `develop`。

**总量**：核心阅读面约 8,000–10,000 行，14 天摊下来每天 600–700 行。这个强度不轻，所以**周边模块（tui / protocol / server / client）全部推到最后一天做导览**，前 13 天只走 `ai → agent → coding-agent` 主线。

---

## 每天的固定节奏（约 2.5 小时）

| 时段 | 时长 | 做什么 |
|---|---|---|
| 热身 | 15 min | 回顾昨天笔记，写下今天要回答的 2–3 个具体问题 |
| 精读 | 90 min | 当天主线文件。**读不完不要硬撑到深夜，宁可次日补** |
| 验证 | 30 min | 当天的动手任务——这是把"看懂了"变成"真懂了"的环节 |
| 落笔 | 15 min | 更新笔记，记下没搞懂的点 |

**笔记放哪**：在 `develop` 分支建 `notes/` 目录，每天一个文件（`notes/day-01.md`）。这个目录是你自己的，不会和上游冲突。

**用 pi 读 pi**（贯穿全程的核心技巧）：

```bash
cd /Users/simonli/Downloads/MyProjects/PiAgent
./pi-test.sh --model dashscope/qwen3.7-plus
```

在仓库自己目录里开会话，直接问："解释 `agent-loop.ts` 里 X 的控制流"。README 明说支持这么用。**但有个纪律：先自己读 30 分钟再问它**，否则你学的是它的总结，不是代码本身。

**卡住怎么办**：任何一天卡住超过 40 分钟，就跳过、记进笔记、往下走。架构理解是螺旋上升的——Day 9 读会话持久化时，Day 6 没懂的 reducer 往往会自己通。

---

## 第一周：核心运行时（`ai` + `agent`）

### Day 1 — 建立坐标系（不读源码）

先看行为，再看代码。今天一行 `src/` 都不用读。

- **读**：`README.md`、`packages/coding-agent/docs/index.md`、`AGENTS.md`、`docs/packages.md`
- **画**：一张三层依赖图 `ai ← agent ← coding-agent`，标清每层职责
- **TS 最小铺垫**（Python 背景够用了，就这三个）：
  - `type` / `interface` 的区别
  - 泛型 `<T>`
  - **可辨识联合（discriminated union）**——最重要，pi 用它表达所有消息和事件类型，对应 Python 的 `Union` + `Literal` 标签字段
- **验证动作**：跑三个复杂度递增的 prompt，各导一份 session JSONL 对比：
  ```bash
  # 1 无工具  2 单轮工具  3 多轮工具
  ./pi-test.sh --model dashscope/qwen3.7-plus -p "1+1等于几"
  ./pi-test.sh --model dashscope/qwen3.7-plus -p "列出当前目录文件"
  ./pi-test.sh --model dashscope/qwen3.7-plus -p "读 package.json，把 version 写进 v.txt"
  ```
  会话在 `~/.pi/agent/sessions/<路径编码>/`。**三份事件流的差异就是这两周要解释的全部东西。**

### Day 2 — `ai` 层：项目的词汇表

- **主线**：`packages/ai/src/types.ts`（821 行，全读）
- **重点**：Message / Content block 的联合类型、Tool 定义、Stream 事件类型
- **验证**：把 Day 1 三份 JSONL 里出现的**每一个** block 类型（`text` / `thinking` / `toolCall` / `toolResult`），都在 `types.ts` 里找到对应定义。找不全说明没读透。

### Day 3 — `ai` 层：模型目录与 provider 注册

- **主线**：`src/models.ts`（944）、`src/providers/all.ts`（155）、`src/providers/anthropic.ts`（很小，看注册模式）
- **对照你已有的配置**：`~/.pi/agent/models.json` 里的 dashscope 是怎么被加载进这套目录的
- **验证**：给 `models.json` 再加一个模型（如 `qwen3.7-max`，参数抄 `providers/data/qwen-token-plan.json`），`./pi-test.sh --list-models` 能看到它

### Day 4 — `ai` 层：适配器精读

今天量大（~1,800 行），**精读 openai-completions，anthropic 只做对比扫读**。

- **精读**：`src/api/openai-completions.ts`（1575）——你的 dashscope 走的就是它
- **精读**：`src/api/transform-messages.ts`（223）
- **扫读**：`src/api/anthropic-messages.ts`（1351）——只看它和 openai 版**差在哪**，这个差异就是抽象层存在的理由
- **验证**：在 `openai-completions.ts` 里找到请求体组装的位置，对照 `models.json` 里你配的 `compat` 四个字段（`thinkingFormat` / `supportsDeveloperRole` / `supportsStore` / `supportsReasoningEffort`），确认每个字段各自影响 payload 的哪一部分

### Day 5 — `agent` 层：主循环 ⭐ 全程最重要的一天

- **主线**：`packages/agent/src/agent-loop.ts`（796）、`src/agent.ts`（592）
- **要回答的问题**：循环在什么条件下继续？什么条件下终止？工具结果怎么回灌？出错怎么处理？中断怎么处理？
- **验证**：打开 Day 1 第三份（多轮工具）JSONL，**逐行对照代码走一遍**。你应该能指出每一行事件由 `agent-loop.ts` 的哪段代码产生。参考已知结构：
  ```
  user → assistant(thinking,toolCall) → toolResult → assistant(thinking,text,toolCall) → toolResult → assistant(text)
  ```
  终止条件就一条：**assistant 消息里不再带 toolCall**。

### Day 6 — `agent` 层：harness 与状态归约

- **主线**：`src/harness/agent-harness.ts`（508）、`src/harness/reducer.ts`（667）、`src/harness/types.ts`（315）
- **核心概念**：状态不是攒在变量里，而是从事件流 **reduce** 出来的。这是 pi 和玩具 agent 的分水岭——可回放、可分支、可持久化都源于此。Python 类比：类似 Redux/事件溯源，不是 ORM 式的可变对象。
- **验证**：写个小脚本（Python 也行）读一份 session JSONL，自己 reduce 出"最终有几条消息、调了几次工具、总 token"，再和 pi 显示的对上

### Day 7 — `agent` 层：工具实现 + 第一周复盘

- **主线**：`src/harness/tools/`（1,190 行全读，单个文件都不大）
  - `edit-diff.ts`（500）——最复杂，diff 应用逻辑
  - `bash.ts`（161）/ `read.ts`（144）/ `edit.ts`（127）/ `write.ts`（39）
  - `file-mutation-queue.ts`（56）——**小而精，并发写冲突怎么处理**，值得细看
- **验证（周复盘）**：合上代码，默写出：① agent loop 的完整控制流 ② 一次工具调用从模型输出到结果回灌经过哪些模块。写不出来的部分就是下周要补的。

---

## 第二周：产品层与扩展机制

### Day 8 — `agent` 层：上下文压缩

生产级 agent 绕不开的问题。Day 1 你已经看到 input token 逐轮增长（1550 → 1621 → 1788），这就是它存在的理由。

- **主线**：`src/harness/compaction/compaction.ts`（848）、`branch-summarization.ts`
- **配套**：`packages/coding-agent/docs/compaction.md`
- **验证**：造一个长会话触发压缩（连续追问十几轮，或读几个大文件），在 JSONL 里找到压缩事件，看压缩前后上下文的变化

### Day 9 — `agent` 层：会话持久化与分支

- **主线**：`src/harness/session/state.ts`（344）、`session.ts`（294）、`session/jsonl/`（717）
- **配套**：`docs/session-format.md`、`docs/sessions.md`
- **验证**：手工改一份 session JSONL（比如删掉最后两条消息），用 pi 恢复它，看行为是否符合预期。这是检验 Day 6 事件溯源理解的最好方式。

### Day 10 — `agent` 层：能力组织与可观测性

- **主线**：`src/harness/skills.ts`（375）、`prompt-templates.ts`（262）、`system-prompt.ts`、`telemetry.ts`（615）
- **`telemetry.ts` 值得认真读**：可观测性怎么织进 agent 循环而不污染主逻辑，是"企业级"的另一个分水岭
- **配套**：`docs/skills.md`、`docs/prompt-templates.md`
- **验证**：按 `docs/skills.md` 写一个自己的 skill，在会话里触发它

### Day 11 — `coding-agent`：SDK 入口 ⭐ 你改造项目的门户

- **主线**：`src/core/sdk.ts`（398，很短但关键）
- **配套**：`docs/sdk.md`
- **验证**：依次跑通官方示例 `packages/coding-agent/examples/sdk/` 的 `01-minimal` → `05-tools`。这五个跑通，你就具备把 pi 嵌进自己项目的能力了。

### Day 12 — `coding-agent`：资源加载与扩展机制 ⭐

- **主线**：`src/core/resource-loader.ts`（1096）、`src/extensions/`（1414）
- **配套**：`docs/extensions.md`、`docs/packages.md`
- **参考**：`examples/extensions/` 有 30+ 个现成样例，重点看 `dynamic-tools.ts`、`custom-compaction.ts`、`confirm-destructive.ts`
- **验证**：**写一个自己的 extension**（注册一个自定义 tool），在 pi 会话里调用成功。这是 LEARNING-PLAN 验证清单的第 6 项，也是"不动 core 就能改造"这条路的毕业证。

### Day 13 — `coding-agent`：产品层编排（选读，不求全）

`agent-session.ts` 有 3,342 行，**不要从头读**。用前 12 天建立的地图定向查找。

- **带着问题读**：一个 `session.prompt()` 调用，如何最终走到 Day 5 读的 `agent-loop.ts`？中间经过哪些装配步骤？
- **辅助**：`model-runtime.ts`（787）、`session-manager.ts`（1714）按需跳读
- **验证**：跑 `examples/sdk/12-full-control.ts`，对照它用到的 API 反查 `agent-session.ts` 里的实现

### Day 14 — 综合产出与周边导览

- **周边快扫**（各 20 分钟，只求知道"它在那儿、干什么用"）：
  - `packages/tui` — 差分渲染终端 UI
  - `packages/evals` — agent 行为评测方法论（做自己项目时值得抄）
  - `packages/protocol` / `client` / `server` — 实验性 client-server 协议
  - `packages/telemetry` — 遥测契约
- **最终产出（这才是两周的交付物）**：
  1. 一张完整架构图，标出三层职责、数据流向、关键文件
  2. 一份 `notes/architecture.md`：用自己的话解释 agent loop、事件归约、上下文压缩、provider 抽象四件事
  3. 一份 `notes/my-project.md`：**如果我要做自己的 agent，抄什么 / 改什么 / 不要什么**——这份直接对接你"改造成自己的项目"的下一阶段

---

## 进度自查

每周末问自己这几个问题，答不上就说明该回头补：

**第一周结束**
- [ ] agent loop 的终止条件是什么？
- [ ] 工具调用的结果以什么形式回到模型？
- [ ] 为什么状态要从事件 reduce 出来，而不是直接维护一个可变对象？
- [ ] `packages/ai` 的抽象边界划在哪？为什么 anthropic 和 openai 两个 adapter 能共存？

**第二周结束**
- [ ] 上下文超限时具体发生了什么？
- [ ] 一个 extension 能挂载到哪些扩展点？
- [ ] `createAgentSession()` 到 `agent-loop.ts` 之间隔了几层？各层在装配什么？
- [ ] 如果要换掉 pi 的工具集用自己的，最小改动面是什么？

---

## 时间不够时的取舍顺序

真跟不上进度时，按这个顺序砍（从最先砍起）：

1. Day 14 的周边导览 —— 砍掉不影响核心理解
2. Day 10 的 telemetry —— 概念独立，可后补
3. Day 13 的 `agent-session.ts` —— 用到时再定向读
4. Day 4 的 anthropic adapter 扫读 —— 只读 openai 那个也够

**绝对不能砍**：Day 5（主循环）、Day 6（状态归约）、Day 12（扩展机制）。这三天是骨架，砍了两周就白过。
