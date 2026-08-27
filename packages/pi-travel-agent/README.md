# pi-travel-agent

用 pi 的架构从零手写的旅行助手。计划和笔记在 [`docs/`](docs/)：
[实施计划](docs/agent1-travel-plan.md) ·
[文件结构与开发流程](docs/agent1-dev-workflow.md) ·
[八个问题的答案](docs/answers/)。

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
node src/cli.ts [--model <名字>] [--thinking] [--trace] [--chat] ["你的问题"]
```

三种形态，由「给没给话」和 `--chat` 决定：

| 命令 | 跑什么 |
|---|---|
| `node src/cli.ts "你的问题"` | 跑一轮就退。脚本、CI、验收表全走这条 |
| `node src/cli.ts` | 进多轮会话（REPL），新开一个会话 |
| `node src/cli.ts --chat "你的问题"` | 用这句话开头，答完接着聊 |
| `node src/cli.ts --resume` | 接着**最近一个**会话聊 |
| `node src/cli.ts --resume=<id>` | 接着指定会话聊 |
| `node src/cli.ts --sessions` | 列出最近的会话 |

| 开关 | 作用 | 备注 |
|---|---|---|
| `--model` | 选 provider，默认 `qwen`（云端 dashscope） | 可用值 = `src/core/model.ts` 的 `PROVIDERS` 的键；写错会报「未知模型」并列出可用的 |
| `--thinking` | 开思考，正文前出灰色 `[思考]` 段 | 本地小模型**别开**，见下 |
| `--trace` | 往 stderr 打四个挂载点的进出 | 不影响 stdout，可以 `2>/dev/null` 只看正文 |
| `--chat` | 给了话也进多轮 | 不给话时本来就是多轮，这个开关是给「第一句写在命令行里」用的 |
| `--resume[=<id>]` | 恢复会话，隐含进多轮 | 写成 `--resume=<id>` 而不是 `--resume <id>`——后者没法和 prompt 区分开 |
| `--sessions` | 列会话后退出 | id 是时间戳，认会话靠列表里那句「第一句用户说的话」 |
| `--help` | 打用法 | |

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
[qwen3.7-plus] turn 2 / 6 step / in 7158 / cache 15232 / out 2502 / ctx 17 / end completed
      ↑模型      ↑第几轮  ↑loop 转了几圈  ↑本轮所有 step 之和，不是单步   ↑历史多少条  ↑TurnEndReason
```

`turn` 只在多轮里出现。`cache` 只在 provider 报了缓存命中时出现——**多轮下 `in` 会莫名其妙地
变小就是因为它**：第二轮前缀和第一轮高度重合，dashscope 把命中的部分从 `input` 里扣掉单独记
（实测 `in` 从 2677 掉到 507，少掉的 2176 全在 `cache` 里）。`ctx` 是当前历史的消息条数，
单轮时代没有信息量，多轮下它是唯一能一眼看见「历史在涨」的数字。

`end` 的五种取值在 `src/core/types.ts:90`。`truncated` = 撞上 `*_MAX_TOKENS`；
`max_steps` = 转了 20 圈没收敛；单轮模式下 `completed` 之外退出码都是 1。

### 多轮会话

不给话就进 REPL，历史一路累积在同一个 `Context` 里：

```sh
node src/cli.ts
› 帮我规划成都2天行程，8月28号出发，2个人，预算3000
…
› 第二天太满了，把下午那个换成室内的
```

**第二句为什么不用重说一遍城市和日期**——因为 `context.messages` 没清空，
上一轮的 user / assistant / toolResult 原样又发了一遍。代价也在那行摘要里：`ctx` 和 `in` 一起涨。
压缩是 Step 7 的事。

| 命令 | |
|---|---|
| `/exit`（或 `/quit`） | 退出。Ctrl-D、连按两次 Ctrl-C 一样 |
| `/new` | 清空历史重开，system prompt 不变 |
| `/ctx` | 看现在的历史有多少条、都是些什么 |
| `/help` | 命令表 |

不认识的 `/xxx` 不会被当成聊天发出去——打错一个命令白花一次请求太亏。真要发 `/` 开头的话，前面加个空格。

**Ctrl-C 分两种**：turn 正在跑时中断这一轮，回到提示符（不退出）；提示符上按则提示一次、连按两次才退。

**一轮结束就把历史收拾干净**（`src/core/context.ts`，两条不变量）：

- 被中断/截断的那轮会留下没人回答的 toolCall → `repairDanglingToolCalls` 补一条「被中断了」。
  **补不是删**，因为终端上那行 `[tool] weather(...)` 用户是真看见了。
- 请求根本没发成功的那轮会留下一条空 assistant 消息 → `dropEmptyAssistantMessages` 扔掉。
  **这条是删**，因为用户什么都没看见，留着等于在历史里编造一次沉默。

模型侧失败会打 `[模型侧失败] <原因>` 到 stderr。**这行必须有**——没有它，turn 以
`end error` 收场时终端上一个字都没有，看着完全像卡死了。

### 会话记录

每个会话一个 JSONL：`data/sessions/<id>.jsonl`（gitignore）。**一行一个 Entry，只往尾巴上加，
从不改已经写下去的行。**

```
id=1 parent=null  session   model=qwen3.7-plus promptHash=b0f1527f054c
id=2 parent=1     message   user: "我叫李四，下周想去成都。"
id=3 parent=2     message   assistant: "你好李四！为了给你规划…"
id=4 parent=3     turn      1 step / in 2789 / completed
id=5 parent=4     message   user: "我刚才说我叫什么？"
```

**为什么是树（`parentId`）而不是一串数组**——因为会话里天然有「回到之前某个点重新开始」。
现在是 `/new`，将来是「把刚才那句改一下重问」。用数组就得回头改文件；用树只要换个父节点：

```
/new 之后 ↓                        resume 从最后一行往回走：7→6→5→1
id=4 parent=3   turn                旧的那串（2、3、4）一条没删，只是走不到
id=5 parent=1   user: "我是王五…"   ← 挂回了会话头，不是挂在 4 后面
```

`turn` 那种 Entry 记的是这轮几步、花了多少、怎么结束的。不存它也能恢复对话，但恢复不了**账**——
`--resume` 之后 `turn`/`in`/`out` 是接着上一个会话累加的。

`--resume` 开场会**把历史回放出来**——只放用户说的话和模型的正文，中间的工具步折成一行：

```
── 接着聊,历史 44 条 / 4 轮 ──
› 你好，未来3天深圳天气如何
  ⋯ 2 步工具调用
  深圳未来3天的天气预报如下：…
› 那桂林呢
  ⋯ 2 步工具调用
  桂林未来3天的天气预报如下：…
── 以上是历史 ──
```

不回放的话，屏幕上和新开一个会话长得一模一样，用户只能试探性地问一句去撞——
而「模型记得刚才的事」恰恰是多轮唯一的卖点，看不见就等于没有。
工具步不显示但**要报数**：那 N 步是真花了钱、真进了上下文的。

**读回来时四层校验，一层都不「跳过接着走」**（`src/session/store.ts`）：

| 手改成什么样 | 报什么 |
|---|---|
| 某行不是合法 JSON | `x.jsonl:3 不是合法 JSON：Unexpected non-whitespace character…` |
| id 重复 | `x.jsonl:6 id "5" 和前面某条重复了` |
| `parentId` 指向不存在的 id | `断链：Entry "5" 的 parentId 是 "99"，但文件里没有这个 id` |
| 删掉一条 toolResult 并把链重新接好 | `断链：工具调用 "weather"(id call_…)没有对应的结果` |

静默跳过的后果是模型收到一段少了几句的历史，而人完全看不出来。所以宁可拒绝恢复。

落盘写不下去（权限、磁盘满）**不会打断对话**：打一句 `[会话记录写不下去了] <原因>`，
之后不再重试，聊天照常。聊天比记账重要，但也绝不能静默。

**单轮模式（`node src/cli.ts "一句话"`）不记会话**——见 BACKLOG，Step 9 做 `--replay` 时一起补。

管道也能跑多轮，一行一轮，这也是验收表里多轮那几条的跑法：

```sh
printf '我叫李四\n我刚才说我叫什么？\n/exit\n' | node src/cli.ts
```

管道模式下**不注册 `ask_user`**：那些行是一轮一轮的提问，注册了它会把下一行当成答复吃掉，
静默少跑一轮——比「不会追问」难查得多。

### 写文件之前先问一句

`save_plan` 会落一个文件下来，这是整套工具里唯一不可逆的动作。所以它**执行前会问**：

```
[tool] save_plan({"title":"成都2日历史文化之旅", …})

? 要把「成都2日历史文化之旅」存成 HTML 报告吗?(y = 好,回车或 n = 先不)
> n
  → 用户这次不需要保存报告。不要再调 save_plan,除非他后面明确又提出来。 (5360ms)
```

三个设计点：

- **这是硬闸，不是 prompt 规矩。** 挂在 `beforeToolCall` 上（`src/features/confirm.ts`），
  模型连「有人在替用户把关」都不知道，也就无从绕过。写进 system prompt 的「存之前先问」是软的——
  这个功能就是因为模型没照做才加的。
- **拦下来不是错误**（`isError: false`）。用户的决定不是故障；标成错误的话模型会当成出了问题，
  很可能换个 title 再试一次，闸就被绕过去了。
- **读不到答复一律当「不要」。** 直接回车、终端被关、Ctrl-C——都算没同意。
  确认闸的默认必须落在安全那一侧。

**没人可问的环境（管道、CI）根本不挂这块积木**，`save_plan` 照常执行——
和 `ask_user` 同一条判断：拦截是为了尊重用户的意愿，没有用户就没有意愿要尊重。
所以验收表里那些 `node src/cli.ts "…存成报告"` 照样能跑。

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
| 3b-2 | `echo | node src/cli.ts "帮我规划成都行程"` | 非交互环境下**根本不注册** `ask_user`，模型看不到它，改成在正文里追问 |
| 4 | `node src/cli.ts "帮我规划成都2天行程，8月28号出发，2个人，预算3000，喜欢历史文化，住武侯区附近，最后存成报告"` | 末尾 `[tool] save_plan(...)`，`out/*.html` 双击可读：地图带编号图钉，行程条目前的编号和图钉对得上 |
| 4 | `node -e '…createSavePlan({outDir}).execute("t", {title:"../../.ssh/config", …})'`（见下） | 落盘名为 `sshconfig.html`，仍在 `out/` 内 |
| 4 | 同一个 title 连存两次 | 第二份是 `xxx-2.html`，**不覆盖** |
| 4 | `grep -o 'src="http\|href="http\|<script' out/*.html` | 无输出 —— 报告零外链、零脚本，key 不在文件里 |
| 5a | `printf '我叫李四\n我刚才说我叫什么？只回名字。\n/exit\n' \| node src/cli.ts` | 第二轮答「李四」；`ctx` 从 2 涨到 4 |
| 5a | `printf '记住暗号：紫色犀牛。\n/new\n暗号是什么？不知道就说不知道。\n' \| node src/cli.ts` | `/new` 之后答不知道；管道喂完自动退出，退出码 0（不挂死） |
| 5a | `node src/cli.ts --chat "成都八月底热不热？"`，再问「我刚才问的城市是哪个？」 | 答「成都」 |
| 5a | REPL 里 turn 跑到一半按 Ctrl-C | 打 `(已中断)` 并回到提示符（**不退出**）；下一轮开头打「上一轮有 N 个工具调用没跑完」，模型自己说「之前的查询都被中断了」 |
| 5a | 提示符上连按两次 Ctrl-C | 第一次提示「再按一次」，第二次退出，退出码 0 |
| 5a | TTY 下 `node src/cli.ts`，说「帮我规划一下行程」，答复四行一口气敲完 | `ask_user` 照常一问一取，不丢行、不串行——行缓冲在 `src/terminal.ts` |
| 修 | `node src/cli.ts "2026年10月1日出发去杭州玩3天，2个人，预算8000"` | **不调 `weather`**，明说离出发还早、超出「今天起 4 天」查不到预报；不拿最近几天的天气冒充 |
| 修 | 一批 8 个并行 `search_poi`（`Promise.allSettled`） | 8/8 成功，不出现 `CUQPS_HAS_EXCEEDED_THE_LIMIT(10021)`；耗时 5~7s（退避重试的代价） |
| 修 | `printf '第一句\n/ctx\n/exit\n' \| LOCAL_BASE_URL=http://127.0.0.1:9/v1 node src/cli.ts --model local` | 打 `[模型侧失败] Connection error.`，`ctx` 只涨 1（失败那轮不往历史里塞空消息） |
| 5b | `printf '我叫李四，下周想去成都。\n/exit\n' \| node src/cli.ts`，再 `printf '我刚才说我叫什么、要去哪？\n/exit\n' \| node src/cli.ts --resume` | 新进程答「李四、成都」；末行是 `turn 2 / ctx 4`，总账接着上一个会话累加 |
| 5b | `node src/cli.ts --sessions` | 列出会话 id、turn 数、第一句用户说的话 |
| 5b | 拿 `data/sessions/*.jsonl` 改一个 `parentId` 指向不存在的 id，再 `--resume` | 报 `断链：Entry "5" 的 parentId 是 "99"，但文件里没有这个 id`，**不静默跳过** |
| 5b | 删掉一条 `toolResult` 行、把后面那条的 `parentId` 接到它父节点上，再 `--resume` | 报 `断链：工具调用 "weather"(id …)没有对应的结果` |
| 5b | 会话里 `/new` 再说几句，然后 `--resume` | 只恢复 `/new` 之后那段；`jsonl` 里 `/new` 前的行**一条没删**，新消息 `parent` 指回会话头 |
| 5b | `chmod 444` 会话文件后继续聊 | 打 `[会话记录写不下去了] EACCES…`，对话照常进行，不抛异常 |
| 5b | `node src/cli.ts --resume=不存在的会话` | 报「没有这个会话」并打出找的是哪个路径 |
| 5b | 改掉会话头里的 `promptHash` 再 `--resume` | 打 `[提示] 这个会话存的时候 system prompt 和现在不一样` |
| 确认 | TTY 下让它规划并存报告，在 `? 要把「…」存成 HTML 报告吗?` 处答 `n` | `out/` 文件数**不变**；模型说「好的」并把行程打在正文里，**不重试 save_plan** |
| 确认 | 同上，答 `y` / `好的` / 任意以 y 开头的 | 正常落盘 |
| 确认 | `node src/cli.ts "…最后存成报告"`（管道，无 TTY） | **不问**，直接落盘——没 asker 就不挂这块积木 |
| 确认 | TTY 下问天气 | `weather` 不受影响，不弹确认 |
| 修 | `node src/cli.ts --resume=<有历史的会话>` | 开场回放出用户说过的话和模型正文，中间工具步折成 `⋯ N 步工具调用` |
| 修 | 规划一次行程并存报告，然后 `grep -c 'data:image/png' out/最新.html` | **1**（`save_plan` 自己按名字查坐标，不再依赖模型填 `location`） |
| local | `node src/cli.ts --model local "成都和重庆明天天气怎么样，对比一下"` | 同一 step 并行两个 `weather`，**没有 `[思考]` 段**（有就是 `reasoning_effort` 没生效） |
| local | `node src/cli.ts --model local "帮我规划成都2天行程，8月28号出发，2个人，预算3000，最后存成报告"` | 4 step 跑完，`out/*.html` 七个区块齐全 |

## 八个问题的答案

`docs/answers/` —— 项目真正的验收不是「代码跑起来了」，是这八个问题能当面答出来。
**答案必须引用自己代码的行号**，做不到就说明那个 Step 没真做完。

| # | 问题 | 落在 | 文档 |
|---|---|---|---|
| 5 | session 怎么持久化和恢复 | Step 5 | [`q5-session.md`](docs/answers/q5-session.md) |

行号会随着代码漂，所以有一条机械校验（打出每条引用指向的那一行，扫一眼对不对）：

```sh
grep -ohE '[a-z/-]+\.ts:[0-9]+' docs/answers/*.md | sort -u | while IFS=: read f n; do
  for p in "$f" "src/$f" "src/core/$f" "src/session/$f"; do
    [ -f "$p" ] && { printf '%-26s %4s  %s\n' "$f" "$n" "$(sed -n "${n}p" "$p")"; break; }
  done
done
```

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
│   ├── trace.ts   --trace，Step 9 扩成完整版
│   └── confirm.ts 不可逆的工具执行前先问人 ★ 硬闸，挂 beforeToolCall
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
├── session/       会话记录（harness，不认识终端）
│   ├── types.ts   Entry 定义 —— 一行 JSON = 一个 Entry，parentId 串成树
│   └── store.ts   JSONL append-only 写 + 四层校验的读 ★ 只往尾巴加，从不改已写的行
├── terminal.ts    ★ 唯一 import readline / 碰 process.stdin 的文件（行缓冲 + 锁 + Ctrl-C）
├── terminal-asker.ts  Asker 的终端实现，只管「问题排版成什么样」
├── render.ts      事件 → 终端文字；单轮和多轮共用同一份格式
├── repl.ts        多轮驱动 ★ 「轮次」这个概念只存在于这里
└── cli.ts         入口：参数、资源、路由（单轮 or 多轮）
```

`core/` 下 Step 5 新增 `context.ts`：`messages` 形状的不变量（toolCall 必须有 toolResult 配对）。
loop 只活在一轮之内，收拾被打断的历史是「两轮之间」的事，所以它不在 loop.ts 里。

三层依赖只许往下：`cli/repl/compose` → `features/tools` → `report` → `trip-plan` / `core` / `session`。
`session/` 和 `core/` 同层：都不认识终端、不认识旅行。repl.ts 里那块「一次会话是什么」
在 Step 5b 沉到了这里，留在 repl.ts 的只剩终端上那个 while。
`terminal.ts` / `render.ts` 和 cli 平级（都是宿主设施），`terminal-asker.ts` 只依赖 `terminal.ts`。
Step 4 起 `tools/` 和 `report.ts` 不再是平级：`save-plan.ts` 必须 import `report.ts`
（它的工作就是渲染报告），所以 `report.ts` 沉到 `tools/` 下面，`trip-plan.ts` 再沉一层，
被两边共用。反向 import（report → tools）仍然禁止。
自查（应无输出）：

```sh
grep -rn "城市\|景点\|旅行\|trip\|amap" src/core src/session | grep -vE ':[0-9]+:\s*(\*|//|/\*)'  # 域污染（跳过注释）
grep -rn 'from "\.\./features\|from "\.\./tools' src/core src/session                              # 依赖倒挂
grep -rn '^import ' src | grep '@earendil-works/pi-ai' | grep -v 'import type' | grep -v core/model.ts  # 绕过 provider 边界
grep -rn 'AMAP_KEY\|restapi.amap.com' src | grep -v 'tools/amap.ts'                     # key 和 URL 只许待在 amap.ts
find src -name '*.ts' -exec sh -c 'head -1 "$1" | grep -q "^/\*\*" || echo "缺文件头: $1"' _ {} \;
find src -name '*.ts' -exec awk '/^(export )?(async )?function /{ if (prev !~ /\*\//) print FILENAME":"FNR": 缺注释 "$0 } { prev=$0 }' {} \;
grep -rn "from \"./report.ts\"\|from \"../report.ts\"" src/core src/features src/report.ts        # report 被反向依赖
grep -o '\${[^}]*}' src/report.ts | grep -vE 'esc\(|Html|toLocaleString'                       # 有插值没转义
grep -rn "node:readline\|process\.stdin" src | grep -v src/terminal.ts | grep -vE ':[0-9]+:\s*\*'  # 终端被第二个文件碰了
```

最后一条是 XSS 的机械检查：report.ts 里每处模板插值要么是 `esc(...)`，要么是名字以
`Html` 结尾（已转义好）的片段变量。唯一的例外是 `money()`——它拼的是纯文本不是 HTML。

- **文件头**：第一行写职责（一句话 + 层 + 边界，上限 8 行）。写不出一句话职责，就是该拆的信号。
- **函数注释**：每个函数都要有，会抛就写 `@throws`。判据是「说代码没说的东西」——
  复述函数名的注释算负资产。
