# 每次发给模型的 prompt 里有什么

拿两个真实 session 拆开看。数字都是量出来的,session 文件还在 `data/sessions/` 下,
自己能复现(方法见最后一节)。

- `20260828-022729-d3d7` —— **1 个 turn / 3 个 step**,规划黄山两天(`--no-memory`)
- `20260828-022809-8cf2` —— 同一句话,带记忆。用来做对照
- `20260828-022950-6ce9` —— **3 个 turn / 每个 1 step**,闲聊,而且第 3 轮是 `--resume` 起的另一个进程

---

## 一、一次请求由三块拼成

pi-ai 发给 dashscope 的 body 里,**每一步都是完整重发**,没有增量这回事:

```
┌─ systemPrompt ──────────────── 1830 字符 ─┐
│  prompts/system.md              1776       │  ← 静态规则,7 个小节
│  「## 今天」2026年8月28日星期五    54       │  ← cli.ts 的 withToday()，每天不同
│  （开了记忆的话再 +147 的记忆块）           │  ← features/memory.ts 每步重拼
└────────────────────────────────────────────┘
┌─ tools（JSON Schema 数组）──── 4119 字符 ─┐
│  weather 262 · search_poi 354              │
│  search_hotel 448 · estimate_budget 613    │
│  save_plan 2436                            │
└────────────────────────────────────────────┘
┌─ messages ───────────────── 一路累积 ─────┐
│  只有这块在长                              │
└────────────────────────────────────────────┘
```

**工具集是按这次运行的装配算的,不是固定 8 个:**

| 环境 | 注册了哪些 | 合计 |
|---|---|---|
| 管道 + `--no-memory` | weather / search_poi / search_hotel / estimate_budget / save_plan | 5 个,4119 |
| 管道 + 记忆 | 上面 5 个 + `remember` | 6 个,4812 |
| TTY + 记忆 | 再 + `ask_user` | 7 个 |

没有 asker 就不注册 `ask_user`,没开记忆就不注册 `remember` —— **这些判断发生在 `compose.ts`,
在发请求之前**。模型看不到没注册的工具,也就不会白花一次调用去试。

---

## 二、turn 和 step 不是一回事

```
repl.ts       while (从终端读到一行) {        ← turn 循环
                                                 「轮次」只存在于这个文件
loop.ts         while (模型还要调工具) {      ← step 循环
                  beforeStep → 发请求 → 跑工具
                }
              }
```

`core/loop.ts` **不知道「上一轮」这回事**,它只认识一个 turn 里的 step。

| 命令 | turn 数 |
|---|---|
| `node src/cli.ts "问题"` | 永远 1 个 —— 走 `runOnce`,不进 repl |
| `node src/cli.ts` / `--chat` | 说几句就几个 |
| `--resume` | 接着上次的数往下加 |

一次请求 = 一个 step。所以「LLM 收到几次 prompt」= 所有 turn 的 step 数之和。

---

## 三、例一:1 个 turn / 3 个 step

`20260828-022729-d3d7`,固定部分 5949 字符(1830 + 4119),**一步不少地发了 3 遍**。

```
step 1   5949 + 131（1 条）= 6080
         └ user: 「帮我安排黄山 2 天的行程。后天出发,2 个人,从杭州出发,
                   预算 2000 不含大交通,住舒适型。信息已经齐了,不要再问…」
         → 吐出 4 个并行 toolCall
             weather      {"city":"黄山","days":4}
             search_poi   {"city":"黄山","keyword":"黄山风景区","limit":5}
             search_poi   {"city":"黄山","keyword":"宏村","limit":3}
             search_hotel {"city":"黄山","area":"屯溪区",…}

step 2   5949 + 9158（6 条）= 15107        ← messages 涨了 70 倍
         └ 上面那条 user
           assistant（那 4 个 toolCall,925）
           toolResult ×4（1346 + 2402 + 1730 + 2624）
         → 吐出 1 个 toolCall:estimate_budget

step 3   5949 + 11340（8 条）= 17289
         └ 上面 6 条 + assistant(estimate_budget, 1077) + toolResult(1105)
         → 吐出 [text]，2580 字符的行程正文，turn 结束
```

`turn` 记账:`in 11243 / out 1896 / cacheRead 0`。三次请求字符合计 38476,对 11243 token
—— **这批中文 + JSON 的实际比例是 3.4 字符/token**。这是观察值不是规律,换语料就不一样。

### 四个能从这组数字里读出来的东西

**1. `save_plan` 一个人占了工具预算的 59%,而这次根本没调它。**

2436 / 4119。它的 schema 大是因为 `TripPlan` 是嵌套结构(每天每项的名称、时间、花费、出处)。
**工具 schema 的成本是「注册了没有」,不是「用没用上」** —— 注册了就每步发一遍,
这次发了 3 遍 = 7308 字符。以后加工具时要记着这条。

**2. `toolResult` 进上下文的只有 `content` 那一半。**

weather 那条 1346 字符,内容是:

```
黄山区 2026-08-28 小雨转阴 25~31°C；2026-08-29 …（数据时间 2026-08-28 02:01:32）。
本次预报只覆盖 2026-08-28 到 2026-08-31 —— 高德最多给今天起 4 天,出行日期不在这个
区间里就是查不到,不要拿这几天的天气代替。
```

高德原始响应里的经纬度、城市编码、`details` **全都没进**这 1346 字符 —— 它们留给 HTML 报告。
这个二分就是 `ToolResult` 从第一天分开 `content` / `details` 的理由。

**3. messages 在一个 turn 之内就只增不减。**

131 → 9158 → 11340。四个并行工具的结果一次性全进来,step 2 的输入直接是 step 1 的 2.5 倍。
**并行省的是墙钟时间,不省 token** —— 该进上下文的一样进,只是一次进完。

**4. 带记忆那次差在哪(`20260828-022809-8cf2`)**

```
                      --no-memory        带记忆       差
systemPrompt            1830             1977        +147   ← 记忆块
tools                   4119(5 个)       4812(6 个)  +693   ← remember 的 schema
固定部分                5949             6789        +840   ← 每步都多这些
in（3 步合计）          11243            12377      +1134
```

两边的 `messages` **条数、顺序、角色完全一样**,差的只有那块固定部分 ——
因为记忆拼在 `systemPrompt` 末尾,不在 `messages` 里。

行为上:对照组给了光明顶 + 9 次索道;带记忆那次「建议放弃登顶黄山风景区」,
改宏村加屯溪老街平地游。**`in` 只差 9%,路线差了一整条。**

> `out` 从 1896 掉到 1486,别读成「记忆让它更简洁」—— 两次写的是不同的行程,
> 一个上山一个不上山,长度本来就不可比。这种数只能对账,不能下结论。

---

## 四、例二:3 个 turn / 每个 1 step

`20260828-022950-6ce9`。固定部分 6789(带记忆)。

```
turn 1   6789 +   58（1 条）= 6847      in 3419 / out 84
         user"我叫老李"

turn 2   6789 +  696（3 条）= 7485      in 3518 / out 26
         user"我叫老李" → assistant → user"我刚才说我叫什么"
                                          ↑ 上一轮的问和答原样留着，这就是「它记得」

──────── 进程退出，重开 `--resume=20260828-022950-6ce9` ────────

turn 3   6789 + 1227（5 条）= 8016      in 3558 / out 26
         user"我叫老李" → assistant → user"我刚才说我叫什么" → assistant → user"我叫什么来着"
```

turn 3 的 5 条 messages 是**从 JSONL 一行行读回来重建的**,不是留在内存里的。
`in` 3518 → 3558 只差 40,说明重建出来的上下文和原来那份没有区别 —— 这就是 `--resume` 的验收。

### turn 之间发生了什么(step 之间不会发生的)

`repl.ts` 在每个 turn 收尾时做四件事:

| 做什么 | 为什么必须在 turn 边界 |
|---|---|
| `repairDanglingToolCalls` | Ctrl-C 打断会留下没人回答的 `toolCall`,**带着这种历史发下一轮会被 API 拒**。补一条「这次调用没有执行」进去 |
| `dropEmptyAssistantMessages` | 请求失败那轮会留一条空 assistant,留着下轮就是白花 token |
| `session.sync` + `recordTurn` | 落盘。`TurnEntry` 记 reason/steps/usage —— 这些**事后补不上** |
| 新的 `AbortController` | 它是一次性的。共用的话,按过一次 Ctrl-C 之后再也问不出东西 |

**不重置的**:`messages`(就是历史本身)、`ledger`(总账)、`systemPrompt` 的 base、记忆。

顺序要紧:**先补链、先丢空消息,再落盘**。反过来的话文件里会留下我们自己制造的断链,
下次 `--resume` 当场报错。

---

## 五、两个例子放一起

| | 黄山(1 turn / 3 step) | 老李(3 turn / 各 1 step) |
|---|---|---|
| 固定部分占比 | step 1 时 98% → step 3 时 34% | 全程 85%~99% |
| messages 增速 | 131 → 9158 → 11340 | 58 → 696 → 1227 |

**涨得快的不是「轮数」,是工具输出。** 四个并行工具一次性灌进 8102 字符,
比闲聊三轮多出来的 1169 字符大了一个数量级。

所以 Step 7 压缩的主要目标从一开始就清楚:**是 `toolResult`,不是对话**。

---

## 六、记忆在这里面的位置

```
turn 1  step 1  beforeStep → systemPrompt = base + 记忆块
turn 1  step 2  beforeStep → systemPrompt = base + 记忆块     ← 重拼，不是追加
turn 2  step 1  beforeStep → systemPrompt = base + 记忆块（turn 1 里调过 remember 的话，这里已经变了）
```

三个后果:

1. 模型在 turn 1 里 `remember` 了一条,**turn 1 的 step 2 就能看见** —— 不用等下一轮,更不用等重启
2. **`/new` 清不掉记忆**。它清的是 `messages`,systemPrompt 一个字没动 ——
   这正好是「新会话不推荐爬山」在同一个进程内的版本
3. Step 7 的压缩也压不掉它。压缩动 `messages`,记忆不在里面

细节见 [`docs/memory.md`](memory.md)。

---

## 七、`cacheRead` 为什么全是 0

上面三个 session 的 `cacheRead` **全是 0**,包括黄山那个 turn 内前缀完全重合的 step 2 和 step 3。
但 Step 5 实测过命中:第二轮 `in` 从 2677 掉到 507,2000 多进了 `cacheRead`。

**不是缓存时好时坏,是换模型了。** `qwen3.7-plus` 会返回 `cached_tokens`,
`qwen3.6-plus` 连这个字段都不返回(键不存在,不是值为 0)—— 08-28 换模型是因为 3.7
免费额度用完了,缓存数从那一刻起全归零。

换成 DeepSeek 就回来了,而且很高:同一句话 `in 270 / cache 6656`,96% 走缓存价。

排查过程(九步,含方法)记在 [`prompt-cache.md`](prompt-cache.md)。
那篇也解释了为什么这件事直接决定 Step 7 的压缩阈值不能写死。

### 顺带一条:`in` 是减出来的

`in` 不是原始字段,是 `prompt_tokens − cached_tokens − cache_write_tokens`
(`packages/ai/src/api/openai-completions.ts:1385`)。所以「`in` 变小」永远有两种解释:
上下文真变短了,或者一部分进了缓存。这就是摘要行里必须同时打 `cache` 的原因。

---

## 八、怎么自己量一遍

三个来源凑齐就能还原任何一次请求:

| 要的东西 | 从哪拿 |
|---|---|
| `systemPrompt` 的长度 | `--trace` 里 `afterStep` 行的 `sys=`。**挂在 afterStep 不是 beforeStep** —— 注入记忆的 handler 也在 beforeStep 上而且排在 trace 后面,那儿打出来的是注入之前的 |
| `systemPrompt` 的内容 | `prompts/system.md` + `withToday()` 那段 + `renderMemory(store.items())` |
| 工具 schema | `compose({...}).tools.list()`,取 `name` / `description` / `parameters` 三个字段 —— 只有这三个原样进请求体 |
| `messages` | `data/sessions/<id>.jsonl` 里 `type: "message"` 的行,按 `parentId` 从头串到尾 |
| 每一步带到第几条 | 每条 `assistant` 消息之前的那些,就是那一步的输入 |

`--trace` 里的 `sys=` 还是 Q7 的分诊线:

```
[trace] afterStep #2 ... sys=1977    ← 带记忆
[trace] afterStep #2 ... sys=1830    ← --no-memory
```

模型没照做某条规则时先看这个数:没变大是注入 bug(改 `features/memory.ts` / `compose.ts`),
变大了还不照做是模型没听话(改 `prompts/system.md` 的措辞)。两者修法完全不同。
