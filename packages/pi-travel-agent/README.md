# pi-travel-agent

用 pi 的架构从零手写的旅行助手。计划和笔记在
[`notes/travel-agent-notes/`](../../notes/travel-agent-notes/)：
[实施计划](../../notes/travel-agent-notes/agent1-travel-plan.md) ·
[文件结构与开发流程](../../notes/travel-agent-notes/agent1-dev-workflow.md)。

## 跑

```sh
cd packages/pi-travel-agent
node src/cli.ts "成都三天怎么玩"
```

零构建：Node 22.18+ 直接跑 `.ts`。`@earendil-works/pi-ai` 走 workspace 里的
`packages/ai`，不需要额外 `npm install`。

配置在 `.env`（`cp .env.example .env`，不进 git）：模型 id、baseUrl、上下文窗口、
以及**取 key 的方式**（`!<cmd>` 执行命令 / `env:<NAME>` 读环境变量）——存的是取法，不是 key 本身。
provider 的 OpenAI 兼容差异不在 .env 里：那是协议事实，写死在 `src/core/model.ts`。

## 命令行

```
node src/cli.ts [--model <名字>] [--thinking] [--trace] "你的问题"
```

| 开关 | 作用 | 备注 |
|---|---|---|
| `--model` | 选 provider，默认 `qwen`（云端 dashscope） | 可用值 = `src/core/model.ts` 的 `PROVIDERS` 的键；写错会报「未知模型」并列出可用的 |
| `--thinking` | 开思考，正文前出灰色 `[思考]` 段 | 本地小模型**别开**，见下 |
| `--trace` | 往 stderr 打四个挂载点的进出 | 不影响 stdout，可以 `2>/dev/null` 只看正文 |

不认识的 `--xxx` 不报错，会被当成 prompt 的一部分吞掉（开关多到会打错字了再收紧）。

一句话进 loop 之后从简到繁：

```sh
node src/cli.ts "你好"                                    # 1 step，不调工具
node src/cli.ts "成都明天天气怎么样"                       # 2 step：调工具 + 总结
node src/cli.ts "成都和重庆明天天气怎么样，对比一下"        # 同一 step 并行两个工具
node src/cli.ts "帮我规划成都2天行程，8月28号出发，2个人，预算3000，最后存成报告"
open out/*.html
```

末行怎么读：

```
[qwen3.7-plus] 6 step / in 10142 / out 2814 / end completed
      ↑模型      ↑loop 转了几圈   ↑所有 step 之和，不是单步   ↑TurnEndReason
```

`end` 的五种取值在 `src/core/types.ts:90`。`truncated` = 撞上 `*_MAX_TOKENS`；
`max_steps` = 转了 20 圈没收敛；`completed` 之外退出码都是 1。

### 本地模型：`--model local`

`.env` 里配好 `LOCAL_*` 之后（见 `.env.example`），所有命令加一个 `--model local` 即可，
**loop、工具、hook、校验一行都不变**：

```sh
node src/cli.ts --model local --trace "成都和重庆明天天气怎么样，对比一下"
```

同一句话跑两遍只差一个开关，就是一次现成的对照实验。实测 9B Q4 本地模型能跑通全链路
（4 step、一次并行发 6 个工具、`save_plan` 出完整报告），代价是单步输入更重。

## 接一个新模型

`src/core/model.ts` 的 `PROVIDERS` 是唯一要改的地方。但**别直接写代码再跑 agent** ——
那样一旦不工作，你分不清是模型不认工具、还是 compat 配错、还是 agent 有 bug。
按下面的顺序探，每一步只验一件事。

**① 查能力——用 `/api/show`，不是 `/api/tags`**

```sh
curl -s http://<host>:11434/api/show -d '{"model":"<id>"}'   | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j["parameters"]); print(j["capabilities"])'
```

`/api/tags` 报的 `capabilities` 会漏（实测同一个模型 tags 里只有 `completion`，
show 里是 `tools,thinking,completion`）。`parameters` 里的 `num_ctx` 才是服务端实际值。

**② 验工具调用——这是「能不能用」的唯一标准**

```sh
curl -s http://<host>:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"<id>","stream":false,
  "messages":[{"role":"user","content":"成都明天天气怎么样"}],
  "tools":[{"type":"function","function":{"name":"weather",
    "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]
}' | python3 -m json.tool
```

看 `finish_reason` 是不是 `tool_calls`。**这条 curl 只覆盖一个 step 的前半截** ——
它不执行工具、不回写结果、不发第二次请求。正因为只验一件事，它才能把
「模型不肯调工具」和「agent 执行工具出错」切开（Q7 的第一刀）。

想用真 schema 测，把 agent 实际发的那份 dump 出来贴进 `tools`：

```sh
node --input-type=module -e '
process.loadEnvFile("./.env");
const { compose } = await import("./src/compose.ts");
console.log(JSON.stringify(compose({ outDir: "./out" }).tools.schemas(), null, 1));
'
```

**③ 试关思考——挨个发，看哪个被认**

思考格式是 compat 里唯一**只能测不能推**的字段。同一个 prompt 发五次：

| 发过去的 | 对应的 compat |
|---|---|
| 什么都不发 | 基线 |
| `"reasoning_effort":"none"` | `supportsReasoningEffort: true` + `thinkingLevelMap.off = "none"` |
| `"chat_template_kwargs":{"enable_thinking":false}` | `thinkingFormat: "qwen-chat-template"` |
| `"think":false` | Ollama 原生字段，`/v1` 端点不认 |
| `"enable_thinking":false` | `thinkingFormat: "qwen"`（dashscope 走这个） |

比 `reasoning` 字段的长度。实测 qwen3.5-9b 只认 `reasoning_effort:"none"`（思考 0 字），
其余四种都是 6000~9000 字——**单步就吃掉 8192 窗口的三分之一**，而且这个模型
经常把最终回答也留在思考里、`content` 发空，终端上看着像「只有思考没有回答」。

pi-ai 在不带 `--thinking` 时走 `packages/ai/src/api/openai-completions.ts:839` 那一支，
发 `model.thinkingLevelMap.off` —— 所以 `off` 必须是字符串，写 `null` 的语义是
「这个模型关不掉思考，别发」，会退回默认行为。

**④ 量基线大小，再定 `*_CONTEXT_WINDOW`**

```sh
node src/cli.ts --model <新模型> "你好"     # 看末行的 in
```

那个数就是 system prompt + 全部工具 schema 的开销（实测 qwen3.5-9b 是 2662）。
`*_CONTEXT_WINDOW` 填的必须是**服务端实际开的 `num_ctx`**，不是模型标称的
`context_length`——填大了不会报错，Ollama 会从头静默丢消息，表现是模型突然「忘了」
你说过预算多少，看起来像幻觉，其实是 Q7 第①类（信息压根没进上下文）。

经验值：8192 够 2 天行程（峰值单步 in 5500~6500，余量不到 2000），3 天建议 16384。

**⑤ 最后才跑 agent**

```sh
node src/cli.ts --model <新模型> "成都明天天气怎么样"                    # 单工具
node src/cli.ts --model <新模型> "成都和重庆明天天气怎么样，对比一下"      # 并行
node src/cli.ts --model <新模型> "帮我规划成都2天行程，预算3000，最后存成报告"  # 全链路
```

**看不到 agent 真正发出去的完整请求体** —— `--trace` 只打 hook 和工具的进出，不打 body。
那是 Step 9 `--replay` 的事。在那之前想看，临时在 `src/core/model.ts:144` 前面加一句
`console.error(JSON.stringify(request.context, null, 1))`。

## 验收表

每次对话收尾从上往下跑一遍，防回归。

| Step | 命令 | 期望 |
|---|---|---|
| 1 | `node src/cli.ts "你好，用一句话介绍你自己"` | 逐字输出回复，末行打印 in/out token 和 stopReason |
| 1 | `node src/cli.ts --thinking "北京到成都坐高铁大概多久"` | 先出灰色 `[思考]` 段，再出正文 |
| 1 | `node src/cli.ts --model nope "x"` | 报「未知模型」，退出码 1 |
| 1 | `mv .env .env.bak && node src/cli.ts hi; mv .env.bak .env` | 报「缺少环境变量 TRAVEL_MODEL_ID」 |
| 2a | `node src/cli.ts "成都和重庆明天天气怎么样，对比一下"` | 两次 `[tool] weather(...)`，末行 `2 step / end completed` |
| 2b | `node src/cli.ts --trace "成都明天天气怎么样"` | stderr 出现 `beforeStep`/`beforeToolCall`/`afterToolCall`/`afterStep` 四种 hook 行 |
| 2b | `node src/cli.ts "成都明天天气怎么样"` | 不带 `--trace` 时输出和 2a 一致，没有 hook 行 |
| 3a | `node src/cli.ts "成都有哪些值得去的历史景点，明天天气怎么样"` | 真数据：POI 带评分/地址，天气带日期，`[假数据]` 前缀消失 |
| 3a | `node --input-type=module -e 'process.loadEnvFile("./.env"); import { fetchForecast } from "./src/tools/amap.ts"; try { await fetchForecast("火星") } catch (e) { console.log(e.message) }'` | 报「查不到城市」，**消息里没有 key** |
| 3b-1 | `node src/cli.ts "帮我规划成都2天行程，预算3000，喜欢历史文化，住武侯区附近"` | 四个工具协同出行程 + 预算，`end completed` |
| 3b-1 | `node --input-type=module -e 'process.loadEnvFile("./.env"); import { validateArguments } from "./src/core/validate.ts"; import { weather } from "./src/tools/weather.ts"; console.log(JSON.stringify(validateArguments(weather, { city: "成都", days: "3" })))'` | 输出 `{"city":"成都","days":3}` —— 字符串数字被 Convert 救回 |
| 3b-2 | `node src/cli.ts "帮我规划一下成都的行程"` | 触发 `[tool] ask_user(...)`，终端出现 `? 您打算去几天？` 并等输入 |
| 3b-2 | `node src/cli.ts "告诉我transformer的原理"` | 一句话拒答并把话题拉回旅行，不解释原理 |
| 3b-2 | `echo | node src/cli.ts "帮我规划成都行程"` | 非交互环境下 ask_user 报「问不了用户」，模型改为带假设继续 |
| 4 | `node src/cli.ts "帮我规划成都2天行程，8月28号出发，2个人，预算3000，喜欢历史文化，住武侯区附近，最后存成报告"` | 末尾 `[tool] save_plan(...)`，`out/*.html` 双击可读：地图带编号图钉，行程条目前的编号和图钉对得上 |
| 4 | `node -e '…createSavePlan({outDir}).execute("t", {title:"../../.ssh/config", …})'`（见下） | 落盘名为 `sshconfig.html`，仍在 `out/` 内 |
| 4 | 同一个 title 连存两次 | 第二份是 `xxx-2.html`，**不覆盖** |
| 4 | `grep -o 'src="http\|href="http\|<script' out/*.html` | 无输出 —— 报告零外链、零脚本，key 不在文件里 |
| local | `node src/cli.ts --model local "成都和重庆明天天气怎么样，对比一下"` | 同一 step 并行两个 `weather`，**没有 `[思考]` 段**（有就是 `reasoning_effort` 没生效） |
| local | `node src/cli.ts --model local "帮我规划成都2天行程，8月28号出发，2个人，预算3000，最后存成报告"` | 4 step 跑完，`out/*.html` 七个区块齐全 |

## 目录

```
src/
├── core/          通用层，不出现「旅行」字样，Agent 2 直接搬
│   ├── types.ts   Tool / ToolResult / AgentEvent / EventSink / TurnEndReason / textOf
│   ├── model.ts   ★ 唯一 import pi-ai 函数的文件
│   ├── registry.ts 工具注册表
│   ├── hooks.ts   四个挂载点 + 串接规则
│   ├── validate.ts 参数 Convert → Check
│   └── loop.ts    ★ agent loop —— 只读，想改它说明缺 hook
├── features/      一个文件 = 一块积木，只通过 hooks 挂进去
│   └── trace.ts   --trace，Step 9 扩成完整版
├── tools/         旅行域
│   ├── amap.ts    高德 REST 客户端（不是 tool）★ key 只在这里出现
│   ├── truncate.ts 双限制截断，永不返回半行
│   ├── weather.ts
│   ├── search-poi.ts
│   ├── search-hotel.ts
│   ├── estimate-budget.ts  唯一不联网的工具
│   ├── ask-user.ts         唯一会阻塞等人的工具
│   └── save-plan.ts        唯一会写磁盘的工具（文件名不由模型决定）
├── trip-plan.ts   TripPlan 形状 —— 同时就是 save_plan 的参数 schema
├── report.ts      TripPlan → 自包含 HTML ★ 每处插值都要 esc()
├── compose.ts     ★ 唯一装配处，加一块积木 = 加一行
└── cli.ts         入口
```

三层依赖只许往下：`cli/compose` → `features/tools` → `report` → `trip-plan` / `core`。
Step 4 起 `tools/` 和 `report.ts` 不再是平级：`save-plan.ts` 必须 import `report.ts`
（它的工作就是渲染报告），所以 `report.ts` 沉到 `tools/` 下面，`trip-plan.ts` 再沉一层，
被两边共用。反向 import（report → tools）仍然禁止。
自查（应无输出）：

```sh
grep -rn "城市\|景点\|旅行\|trip\|amap" src/core | grep -vE ':[0-9]+:\s*(\*|//|/\*)'   # 域污染（跳过注释）
grep -rn '^import ' src | grep '@earendil-works/pi-ai' | grep -v 'import type' | grep -v core/model.ts  # 绕过 provider 边界
grep -rn 'AMAP_KEY\|restapi.amap.com' src | grep -v 'tools/amap.ts'                     # key 和 URL 只许待在 amap.ts
find src -name '*.ts' -exec sh -c 'head -1 "$1" | grep -q "^/\*\*" || echo "缺文件头: $1"' _ {} \;
find src -name '*.ts' -exec awk '/^(export )?(async )?function /{ if (prev !~ /\*\//) print FILENAME":"FNR": 缺注释 "$0 } { prev=$0 }' {} \;
grep -rn "from \"./report.ts\"\|from \"../report.ts\"" src/core src/features src/report.ts        # report 被反向依赖
grep -o '\${[^}]*}' src/report.ts | grep -vE 'esc\(|Html|toLocaleString'                       # 有插值没转义
```

最后一条是 XSS 的机械检查：report.ts 里每处模板插值要么是 `esc(...)`，要么是名字以
`Html` 结尾（已转义好）的片段变量。唯一的例外是 `money()`——它拼的是纯文本不是 HTML。

- **文件头**：第一行写职责（一句话 + 层 + 边界，上限 8 行）。写不出一句话职责，就是该拆的信号。
- **函数注释**：每个函数都要有，会抛就写 `@throws`。判据是「说代码没说的东西」——
  复述函数名的注释算负资产。
