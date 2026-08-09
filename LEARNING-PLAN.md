# Fork earendil-works/pi 作为企业级 Agent 学习与改造底座

## Context

你想通过 `earendil-works/pi` 学习企业级 agent 架构，最终把它改造成自己的项目（不是提 PR，也不是只读源码）。问题起点是"fork 哪个分支合适"。

调研结论：**这个问题没有选择余地——只能是 `main`。** 仓库有 40+ 分支，但除 `main` 外全是死掉或短命的 PR 分支：

| 分支 | 相对 main | 状态 |
|---|---|---|
| `main`（默认） | — | 唯一活跃，近 7 天 100+ commits |
| `earendil` | 落后 1616 | 死 |
| `bigrefactor` | 落后 1574 | 死 |
| `model-registry` | 落后 919 | 死 |
| `loadout` | +7 / −473 | 停在 2026-07-26 |
| `harness-v2/j4` | +9 / −16 | 维护者实验分支，不适合当基线 |

真正需要决策的不是分支，而是**锚点**：main 每天约 15 个 commit，直接跟 HEAD 学习会让你昨天读的文件今天就变了。所以方案是 fork main，但在本地用 release tag `v0.84.1`（2026-08-07）开一条 `study` 分支作为稳定阅读面，等读完一轮再整体 rebase 到新 tag。

仓库事实：85.9k star / MIT / TypeScript monorepo / 10 个 package / 最新 release `v0.84.1`。本地环境已就绪：Node v22.22.1、npm 10.9.4、Bun 1.3.14（正好匹配仓库当前 bun 版本），落脚目录 `/Users/simonli/Downloads/MyProjects/PiAgent` 已存在且为空。

---

## 一、Fork 与仓库配置 ✅ 已完成

Fork 地址：`git@github.com:Seaman-Li/my-pi-agent.git`（已确认只复制了 `main`，没拖进 40+ 个死分支）。
本地仓库：`/Users/simonli/Downloads/MyProjects/PiAgent`

**Remote 布局**：

| remote | 地址 | 用途 |
|---|---|---|
| `origin` | `git@github.com:Seaman-Li/my-pi-agent.git` | 你的 fork，推自己的改动 |
| `upstream` | `https://github.com/earendil-works/pi.git` | 官方仓库，只拉不推 |

**分支布局（三条，职责互不重叠）**：

| 分支 | 基于 | 用途 |
|---|---|---|
| `main` | 跟踪 `upstream/main` | 只用来同步上游，保持干净，不在上面写东西 |
| `study` | `v0.84.1` | 纯净只读的阅读锚点，不提交任何改动 |
| `develop` | `study`（即 `v0.84.1`） | **日常工作分支**，笔记、实验、改造都在这里 |

`develop` 基于 `study` 而非 `main`，是为了让日常改动坐在一个不动的版本上——否则每天 15 个上游 commit 会让你的实验基线一直漂。

**后续同步节奏**：不要天天 rebase。读完一个阶段后：

```bash
git fetch upstream --tags
git log --oneline v0.84.1..v0.<新版本> -- packages/agent packages/ai   # 先看核心包变了什么
git switch study && git reset --hard v0.<新版本>                       # 阅读锚点整体前移
git switch develop && git rebase v0.<新版本>                           # 再把你的改动搬上去
```

---

## 二、跑起来（先看行为，再读代码）✅ 环境已就绪

已执行完成：

```bash
npm install --ignore-scripts   # ✅ exit 0
npm run build                  # ✅ exit 0
./pi-test.sh --version         # ✅ 输出 0.84.1
```

日常还会用到：

```bash
npm run check    # lint + format + 类型检查，改完 core 代码必跑
./test.sh        # 跑测试（无 API key 时自动跳过依赖 LLM 的用例）
./pi-test.sh     # 从源码运行 pi，可在任意目录调用
```

### Provider 配置 ✅ 已完成

用的是 DashScope（阿里百炼）的 OpenAI 兼容端点，模型 `qwen3.7-plus`。配置在 `~/.pi/agent/models.json`：

- **密钥不落第二份**：`apiKey` 用了 pi 支持的 `"!command"` 形式，在每次请求时从 `helloagents-ch10/.env` 的 `LLM_API_KEY` 现读。改 .env 即生效，不存在两处密钥不同步的问题。
- **compat 参数不是猜的**：直接抄自 pi 内置的 `qwen-token-plan` provider（`packages/ai/src/providers/data/qwen-token-plan.json`），它用的是同为阿里 `compatible-mode/v1` 的端点：`thinkingFormat: "qwen"`、`supportsDeveloperRole: false`、`supportsStore: false`、`supportsReasoningEffort: false`。
- **模型参数同样抄自内置目录**：ctx 1M / maxTokens 65536 / reasoning / text+image。

验证：`./pi-test.sh --list-models | grep dashscope` 能看到该模型且状态可用。

> 顺带一提：这套 `models.json` 的解析逻辑（`$ENV_VAR` 插值、`!command` 执行、provider 级与 model 级 compat 覆盖）本身就是阶段 1 的好材料——它是 `packages/ai` provider 抽象层暴露给用户的那一面。

其他可选路径：

- 设 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 环境变量，或在 pi 里 `/login`；
- 你目录里已有 `new-api`（LLM 网关），可以按 `packages/coding-agent/docs/custom-provider.md` 和 `docs/models.md` 把它配成自定义 provider——这本身就是理解 `packages/ai` provider 抽象层的最好练习。

**强烈建议的学习技巧**：在 `PiAgent/` 仓库自己目录里跑 `./pi-test.sh`，然后直接问它"解释 agent-loop.ts 的控制流"。README 明说了 "you can also ask the agent to explain itself"，仓库里还带着 `AGENTS.md` 和 `.pi/` 配置。用 agent 读 agent 的源码，比干读快得多，也顺带让你看到它的 tool calling 实际长什么样。

---

## 三、阅读路线（按依赖顺序，四个阶段）

> **每天具体读什么，见 [STUDY-SCHEDULE.md](STUDY-SCHEDULE.md)** —— 按 2–3 小时/天排的 14 天日程，本节的四个阶段在那里被拆成了带验证动作的每日任务。本节保留的是分层地图和各文件的定位。

依赖关系是 `ai` ← `agent` ← `coding-agent`，三层职责清晰，这也是这个项目值得学的核心原因。

### 阶段 1：`packages/ai` — 统一 LLM 抽象层

回答的问题：怎么把 N 家 provider 的 API 差异吃进一套类型里。

- `packages/ai/src/types.ts`（34KB）— 统一的 message / tool / stream 类型定义。**先读这个**，它是整个项目的词汇表。
- `packages/ai/src/api/anthropic-messages.ts`、`api/openai-completions.ts` — 两个具体适配器，对照读能看清抽象边界划在哪。
- `packages/ai/src/api/transform-messages.ts` — 跨 provider 的消息转换。
- `packages/ai/src/models.ts` + `providers/all.ts` — 模型目录与 provider 注册机制。
- `packages/ai/src/api/*.lazy.ts` — 懒加载模式，避免启动时拉起所有 provider 代码。

> 这一层的概念完全可迁移到 Python，你在 hello-agents 里见过的 provider 封装就是它的简化版。

### 阶段 2：`packages/agent` — Agent 运行时（本项目精华）

- `src/agent-loop.ts`（22KB）— **最核心的文件**。agent 主循环：调模型 → 解析 tool call → 执行 → 回灌结果 → 判停。
- `src/harness/agent-harness.ts`（19KB）— harness 层，loop 之上的编排与生命周期。
- `src/harness/reducer.ts`（22KB）— 事件流归约成状态。这是"企业级"和玩具 agent 的分水岭：状态不是攒在变量里，而是从事件流 reduce 出来的，因此可回放、可分支、可持久化。
- `src/harness/compaction/compaction.ts`（26KB）+ `branch-summarization.ts` — 上下文压缩与分支摘要。生产级 agent 必须解决的问题，配合 `docs/compaction.md` 读。
- `src/harness/session/state.ts` + `session/session.ts` + `session/jsonl/` — 会话持久化格式，配合 `docs/session-format.md`、`docs/sessions.md`。
- `src/harness/tools/`（`read.ts` / `write.ts` / `edit.ts` / `bash.ts` / `edit-diff.ts` / `file-mutation-queue.ts`）— 内置工具实现。注意 `file-mutation-queue.ts`：并发写冲突的处理，小文件但很有信息量。
- `src/harness/skills.ts` + `prompt-templates.ts` + `system-prompt.ts` — 能力与提示词的组织方式。
- `src/harness/telemetry.ts`（18KB）— 可观测性怎么织进 agent 循环。企业级的另一个分水岭。

### 阶段 3：`packages/coding-agent` — 产品层与你的改造入口

- `src/core/sdk.ts` + `docs/sdk.md` — **改造项目最重要的入口**。`createAgentSession()` 是嵌入式使用的门面。
- `src/core/agent-session.ts`（112KB）— 最大的文件，产品级会话编排。**放到最后读**，而且按需读，不要从头啃。
- `src/core/resource-loader.ts`(40KB) / `session-manager.ts`(53KB) / `model-runtime.ts`(29KB) / `provider-composer.ts` — 资源发现、会话管理、模型运行时装配。
- `src/extensions/` + `docs/extensions.md`、`docs/skills.md`、`docs/packages.md` — **扩展机制，你改造项目的正确姿势**（见下节）。
- `src/modes/` + `docs/rpc.md`、`docs/json.md` — 非交互式接入方式（RPC / JSON 事件流），把 pi 接进你自己系统时会用到。

### 阶段 4：按需外围

- `packages/tui` — 差分渲染终端 UI，独立性强，只在你要改交互界面时读。
- `packages/protocol` / `client` / `server` — 实验性的 client-server 协议（CBOR + 长度前缀帧），标注了 unstable，学习价值有但不稳定。
- `packages/evals` — agent 行为评测，`npm run eval`。做自己项目时值得抄的一套方法论。
- `packages/telemetry` — vendor-neutral 遥测契约。

---

## 四、改造策略（这条决定你以后痛不痛苦）

你的目标是"改造成自己的项目"，但 upstream 每天 15 个 commit。**优先级顺序**：

1. **首选：写 extension / skill / prompt template**（`docs/extensions.md`、`docs/skills.md`、`docs/packages.md`）。这些是官方设计的扩展缝，放在仓库外或 `.pi/` 下，rebase 完全不受影响。
2. **次选：用 SDK 嵌入**（`docs/sdk.md`）。把 pi 当依赖库，在 `PiAgent/` 外面另建你自己的项目引用它。这是接你 HelloAgents 系列最干净的路。
3. **最后才改 core**。真要改，把改动集中在少数文件、每个改动单独 commit、写清楚原因——rebase 时你会感谢自己。

### 官方示例阶梯（比干读源码更快的上手路径）

仓库自带两组编号示例，建议**和阶段 1–2 的源码阅读并行推进**：

`packages/coding-agent/examples/sdk/` — 从最小可运行到完全控制，13 步：

```
01-minimal.ts          02-custom-model.ts     03-custom-prompt.ts
04-skills.ts           05-tools.ts            06-extensions.ts
07-context-files.ts    08-prompt-templates.ts 09-api-keys-and-oauth.ts
10-settings.ts         11-sessions.ts         12-full-control.ts
13-session-runtime.ts
```

读源码卡住时，回来跑对应编号的示例，用运行时行为反推设计意图。`05-tools.ts` 对应阶段 2 的 tools 目录，`11-sessions.ts` 对应 session 持久化，`12-full-control.ts` 基本就是 `agent-session.ts` 的使用面。

`packages/coding-agent/examples/extensions/` — 30+ 个可直接抄的扩展样例（`dynamic-tools.ts`、`custom-compaction.ts`、`confirm-destructive.ts`、`custom-provider-anthropic/` 等）。第五节的"改造能力验证"直接照着 `dynamic-tools.ts` 改最省事。

先读完阶段 1–2 再决定改哪里。现在就动 `packages/agent` 是过早优化。

---

## 五、验证（每一步都要能确认成功）

1. ✅ **环境验证**：`npm run check` 全绿（exit 0，仓库要求 errors/warnings/infos 全部为零）。
2. ✅ **构建验证**：`npm run build` 成功（exit 0），`./pi-test.sh --version` 输出 `0.84.1`。
3. ✅ **测试验证**：`./test.sh` 除 1 个已知的模型数据漂移外全部通过（详见下方"测试基线"）。**不要**直接跑 `npx vitest`——AGENTS.md 明确警告它会带上 e2e 测试。
   注意：`./test.sh` 的输出**不要用管道接 `tail`**，否则退出码会变成 `tail` 的 0，掩盖真实失败。用 `./test.sh > log 2>&1; echo $?`。
4. ✅ **端到端行为验证**：在临时目录跑 `./pi-test.sh --model dashscope/qwen3.7-plus -p "列出当前目录下的所有文件"`，模型正确返回了文件名和字节数（与实际一致，确认是真执行工具而非幻觉）。
5. ✅ **架构理解验证**（最有价值的一步）：会话记录在 `~/.pi/agent/sessions/<项目路径编码>/<时间戳>_<uuid>.jsonl`。上面那次调用的完整事件流：

   ```
   0  session                 会话元数据
   1  model_change            模型选定
   2  thinking_level_change   思考档位
   3  message  role=user      blocks=text
   4  message  role=assistant  blocks=thinking,toolCall   ← 模型决定调工具
   5  message  role=toolResult blocks=text                ← 工具执行结果回灌
   6  message  role=assistant  blocks=thinking,text       ← 拿到结果后作答
   ```

   **这七行就是 `agent-loop.ts` 的骨架**。读源码时把这个文件开在旁边逐条对照：第 4→5→6 行就是"调模型 → 解析 tool call → 执行 → 回灌 → 判停"的一轮循环。再看 `reducer.ts` 如何把这串事件归约成 UI 看到的状态，"事件溯源"这件事就具体了。多轮工具调用时，4-5 会重复多次直到模型不再发 toolCall。
6. **改造能力验证**：按 `docs/extensions.md` 写一个最小 extension（注册一个自定义 tool），在 pi 里调用成功。这证明你已经掌握了不动 core 的扩展路径。

---

## 测试基线：1 个已知失败

**这就是你的基线。以后跑 `./test.sh` 只应看到这 1 个失败——多出任何一个，都是你自己改出来的。**

`./test.sh` 退出码 **1**（注意：**不要用 `./test.sh | tail` 之类的管道**，退出码会变成 `tail` 的 0，把失败掩盖掉。用 `./test.sh > log 2>&1; echo $?`）。

各包结果：

| 包 | 结果 |
|---|---|
| `pi-agent-core` | 20/20 ✅ |
| `pi-coding-agent` | 215 passed, 6 skipped ✅ |
| `pi-client` / `pi-evals` / `pi-protocol` / `pi-server` / `pi-telemetry` | 全绿 ✅ |
| `pi-session-backend-sqlite-node` | 11/11 ✅ |
| `pi-ai` | 102 passed, 25 skipped, **1 failed** ⚠️ |

下面记录搭建过程中解决掉的问题（A 已修复）和唯一剩下的（B）：

**A. 10 个失败源于 `fd` 二进制从未被下载过** —— ✅ 已修复

涉及 `test/tools.test.ts`（4）、`test/suite/regressions/3302-find-path-glob.test.ts`（4）、`3303-find-nested-gitignore.test.ts`（2）。报错都是 `fd is not available and could not be downloaded`。

机制（这段值得读，是理解 pi 外部工具依赖的好入口）：

- `src/core/tools/find.ts:223` 调 `ensureTool("fd", true)`——注意第二个参数是 `silent`，**为 true 时所有诊断信息被吞掉**，这就是为什么只看到一句干巴巴的报错。
- `src/utils/tools-manager.ts:328` 的 `ensureTool` 逻辑：先查系统 PATH 和 pi 自己的 bin 目录 → 检查 `PI_OFFLINE` → 否则从 `https://github.com/sharkdp/fd/releases/` 按需下载到 `~/.pi/agent/bin/`。
- 首次运行时 fd 尚不存在，而测试环境里的下载尝试会立即失败（`test.sh` 用 `env -i` 起隔离环境，`HOME` 指向临时目录）。**下载机制本身没问题**——在正常 shell 下手动触发一次即可成功。

**已修复**：`brew install fd`（装的是 fd 10.4.2，在 `/opt/homebrew/bin/fd`）。修复后 `pi-coding-agent` 从 3 个失败文件变为 **215 passed / 0 failed**。

为什么必须装到**系统 PATH**、而不能只靠 pi 自己下载到 `~/.pi/agent/bin/`——看 `getToolPath`（`tools-manager.ts:86`）的两级查找顺序：

1. 先查 `TOOLS_DIR`（由 `HOME` 推导）—— `test.sh` 用 `env -i` 把 `HOME` 换成临时目录，所以这条路在测试里永远查不到；
2. 再查系统 `PATH` —— `test.sh` 显式保留了 `PATH=$PATH`，这条路通。

所以 pi 的自动下载能让**交互式会话**正常工作，但让 `./test.sh` 通过必须装系统 PATH。两者现在都已满足。

> 同一机制还管着 `rg`（ripgrep，见 `src/core/tools/grep.ts`）。以后 grep 工具报类似的错，把上面命令里的 `'fd'` 换成 `'rg'`。

**B. 1 个模型数据漂移（无法从 git clone 修复，属预期行为）**

`packages/ai` → `test/openai-completions-tool-choice.test.ts`：`sends max_tokens for OpenCode completions models`，`expected undefined to be 'max_tokens'`。

**这是 pin 版本学习时最值得记住的一个坑：代码能钉住，数据钉不住。**

- `packages/ai/src/providers/data/` **被 `.gitignore` 忽略**（见 `.gitignore:11`）。各家 provider 的模型目录根本不在仓库里。
- `npm run build` 每次都**联网重新拉取**这份数据（README 原话："Refresh model data, then build all packages"）。
- 于是你得到的是「v0.84.1 的代码 + 今天的模型数据」。测试第 1406 行断言 `getModel("opencode", "grok-build-0.1").compat.maxTokensField === "max_tokens"`，而该模型现在的 compat 只剩 `{sessionAffinityFormat, supportsReasoningEffort}`——上游把这个字段拿掉了，旧测试自然失败。

`npm run build:offline` **修不了**：它复用本地已有数据，而本地数据就是漂移后的那份。tag 时刻的数据快照只存在于 GitHub release 的源码 tarball（`pi-0.84.1-source.tar.gz`，README 说明它 bundles 了发布所用的模型数据），git clone 拿不到。

**结论：接受这 1 个失败，它就是你的绿色基线。** 真要完全干净，去 release 页面下源码 tarball 另开一份——但为了 1 个测试不值得。

> 这件事本身是阶段 1 的好教材：模型元数据是**外部易变输入**，pi 选择不把它锁进版本控制，而是每次构建刷新。代价就是旧代码配新数据可能对不上。你以后设计自己的 agent 时会面对同样的取舍。

**另：一个 flaky 测试**

`packages/coding-agent` → `test/startup-session-name.test.ts` 的 `rejects empty --name values` 第一次跑失败（`expected null to be 1`），第二次跑通过。判定为 flaky，非真实缺陷。以后看到它偶尔红，重跑一次即可。

以上都不影响读代码和跑 agent。

---

## 备注

- 仓库 README 明示：新贡献者的 issue/PR **默认自动关闭**，维护者每天人工复审。你不打算提 PR，所以无影响，但别指望上游快速接受改动。
- 该项目**不含内置权限系统**，默认以启动用户的权限运行。做实验时注意，需要隔离见 `docs/containerization.md`。
- AGENTS.md 里有一批硬性开发约定（禁 `any`、禁 inline import、只用 erasable TS 语法、不准直接改 `models.generated.ts`）。改 core 前先读一遍，否则 `npm run check` 会拦你。
