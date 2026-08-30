# 变量与概念速查

按**层**分,不按字母序 —— 这个项目的全部结构就是层与层之间不许互相认识,
所以「这个词属于哪一层」比「它叫什么」更重要。

每条三样:**是什么** / **在哪** / **最容易搞错的地方**。第三样才是这份文档存在的理由。

> 层的定义在 [`agent1-dev-workflow.md`](agent1-dev-workflow.md);
> 具体设计取舍在各自的 docstring 和 [`answers/`](answers/)。

---

## 〇、先记住三条分界线

这三条不是词,是**判断一个东西该放哪**的依据。看不懂某个设计时先回来看这里。

| 分界线 | 一边 | 另一边 |
|---|---|---|
| **协议 vs 域** | `core/` `session/` `memory/` 不认识「旅行」 | `tools/` `report.ts` `prompts/` 全是旅行 |
| **规则 vs 发言** | 规则进 `systemPrompt`(记忆、今天几号) | 发言进 `messages`(用户说的、模型答的、工具返回的) |
| **协议事实 vs 这次跑的档位** | 协议事实写死在代码(`compat`) | 档位走 `.env`(型号、地址、窗口) |

---

## 一、配置层(`.env` / `prompts/`)

`.env` 里的东西都是**「这次跑用什么」**,换个人跑就得改。不进 git。

### 三组前缀 = 三条 provider

`--model qwen` 读 `TRAVEL_*`,`--model deepseek` 读 `DEEPSEEK_*`,`--model local` 读 `LOCAL_*`。
每组五个,名字一一对应(`src/core/model.ts` 里三个 `*FromEnv()`)。

| 变量 | 是什么 | 最容易搞错 |
|---|---|---|
| `*_MODEL_ID` | 型号名,原样发给服务端 | 它也是 `DEEPSEEK_COST` 查价格的键。填表里没有的 id **不报错**,只是账上记 0 |
| `*_BASE_URL` | 服务端地址 | deepseek 那条**不带 `/v1`**,SDK 自己补;dashscope 和 ollama 要带 |
| `*_CONTEXT_WINDOW` | **我们声明的**「模型一次能看多少 token,输入+输出加起来」 | ⚠️ **从来不发给服务端**。它只是「我们以为服务端有多大」。填错了服务端不会纠正你 —— ollama 会**静默截断**,不报错 |
| `*_MAX_TOKENS` | 这一次回复最多让模型吐多少 token | ⚠️ **会**作为 `max_tokens` 发出去。吐满就被硬切,`stopReason = length`,我们判 `truncated` |
| `*_API_KEY_SOURCE` | key 的**取法**,不是 key 本身。`!<命令>` 执行取 stdout / `env:<名字>` 读环境变量 | 取出来的值绝不进日志、上下文、报告、错误消息 |

**`CONTEXT_WINDOW` 和 `MAX_TOKENS` 这两个数现在有三个用处**,分不清就会撞墙:

1. 压缩阈值 = `(CONTEXT_WINDOW − MAX_TOKENS) × 0.8`(`features/compaction.ts:93`)
2. 启动校验:`CONTEXT_WINDOW <= MAX_TOKENS` 直接抛(`core/model.ts:286`)
3. **pi-ai 每次请求拿它俩夹一次 `max_tokens`**(`packages/ai/src/api/simple-options.ts:15`):

```
available  = CONTEXT_WINDOW − 估算的 prompt 大小 − 4096   ← 4096 是 pi-ai 写死的保险
max_tokens = min(MAX_TOKENS, max(1, available))
```

实测(本地捕捉真实请求体,估算值 1475):

| `LOCAL_CONTEXT_WINDOW` | 实际发出的 `max_tokens` |
|---|---|
| 8192 / 16384 | 2048 |
| **4096** | **1** ← 保险把整个窗口吃光了 |

### 其它

| | 是什么 |
|---|---|
| `AMAP_KEY` | 高德 Web 服务 key,明文。**只有 `tools/amap.ts` 碰它** |
| `prompts/system.md` | 助手的静态规则。**只有它进 `promptHash`** |
| `prompts/extract.md` | 从转录里抽长期记忆的规则 |
| `prompts/compact.md` | 摘要要留下什么 |

---

## 二、core —— 只认识协议,不认识 UI 也不认识旅行

`grep -rn "旅行\|酒店\|高德" src/core` 只会命中注释里的举例,命中不了代码。

### 工具

| | 是什么 | 最容易搞错 |
|---|---|---|
| `Tool` | pi-ai 的 `Tool`(name/description/parameters)+ 一个 `execute` | 前三个字段**原样进请求体** —— schema 里那些 `description` 是 prompt 的一部分,不是给人看的注释 |
| `ToolResult` | `{ content, details }` | ⚠️（还没看） **这个二分是全项目最重要的一条**:`content` 进上下文给模型看,要精简;`details` 不进上下文,给 HTML 报告用(经纬度、图片 URL、原始响应) |
| `Registry` | 工具表。`register` / `get` / `schemas()` | 重名在**装配期**抛,不是运行期选错 |
| `Asker` | 「向人提问」的**定义**,core 只声明不实现 | ⚠️（宿主是什么）唯一必须由宿主注入的能力。没有 asker 就**根本不注册** `ask_user` |

### 一次 turn

| | 是什么 | 最容易搞错 |
|---|---|---|
| **step** | 一次模型请求 + 它要的那批工具 | 单位是「请求」 |
| **turn** | 若干 step,直到模型不再要工具 | `runTurn` 的范围。**loop 不知道有「上一轮」** |
| `TurnEndReason` | ⚠️（truncated和aborted不太熟）turn 为什么结束,五种:`completed` / `truncated` / `aborted` / `error` / `max_steps` | **默认是停,继续才需要理由** |
| `TurnResult` | `{ reason, steps, usage }` | `usage` 是这一 turn **所有 step 的和** |
| `DEFAULT_MAX_STEPS` | 20(`core/loop.ts:32`) | 防死循环的闸,也是「一个 turn 能堆多大上下文」的上限之一 |
| `Context` | pi-ai 的类型:`{ systemPrompt, tools, messages }` | **每一步全量重发**,不是增量 |
| `Message` | 三种角色:`user` / `assistant` / `toolResult` | 只有三种,**加不了第四种** —— 压缩摘要只好做成 user 消息 |

### 四个挂载点

⚠️hook是不是视为一个有条件的触发器，满足条件一定触发？这里如果要加新hook是不是还是要改loop？
⚠️runBeforeToolCall中的短路是指：有override就退出for循环吗，这里的目的没看懂

`core/hooks.ts`。加一块积木 = 往数组里 push,**`loop.ts` 一个字不改**。

| 挂载点 | 什么时候叫 | 现在谁挂在上面 |
|---|---|---|
| `beforeStep` | 每步**发请求之前** | 记忆注入 |
| `beforeToolCall` | 每个工具执行之前,**第一个返回值的赢** | 危险操作确认 |
| `afterToolCall` | 每个工具执行之后,可原地改结果 | (空) |
| `afterStep` | 一步的请求**和它的工具**都跑完了 | 压缩判定、trace |

⚠️StepContext AfterStepContext等这几个hook的入参为什么不直接在loop中import，而是在loop中拼好，这么做的设计目的是什么
⚠️需要举一个`beforeToolCall` 想拦下这次调用时的例子方便理解
| | 是什么 | 最容易搞错 |
|---|---|---|
| `StepContext` | `{ step, context }` | `context` 可以原地改 —— 「注入上下文」就是改它 |
| `AfterStepContext` | 多两样:`message`(模型这步说了什么)、`results`(这步的工具结果) | ⚠️ `results` 就是为压缩留的:只看 `message` 会严重低估这一步吃掉多少上下文 |
| `ToolCallOverride` | `beforeToolCall` 想拦下调用时返回的东西 | 包一层是因为拦截既可能是「拒绝」也可能是「命中缓存」 |

### 模型
⚠️AgentEvent EventSink还没搞透彻
| | 是什么 | 最容易搞错 |
|---|---|---|
| `ModelSpec` | `{ model, apiKeySource }`,一条 provider 的全部配置 | `model.cost` 是**静态价格表**,装不下 DeepSeek 的按时段计价 |
| `stream()` | 唯一一处调 pi-ai 的地方 | **没有 try/catch**:pi-ai 的契约是失败也编码进流,读 `stopReason` 而不是捕异常 |
| `AgentEvent` / `EventSink` | 对外事件,UI 只认这一层 | **单向广播**,sink 不能改数据、不能拦截 —— 那是 hook 干的事 |

---

## 三、session —— 一次会话由什么组成,和终端无关

### Entry:这一层的核心概念

**一行 JSON = 一个 Entry**,Entry 之间用 `parentId` 串成一棵**树**。
`data/sessions/<会话id>.jsonl`,append-only,**从不改已经写下去的行**。

为什么是树不是数组:会话里天然有「回到之前某个点重新开始」(现在是 `/new`)。
数组要回头改文件,树只要**换个父节点** —— 旧分支原样留着,读的时候从叶子往回走自然绕开。


⚠️每个entry在哪里完成记录的可以看看
| Entry 种类 | 存什么 | 每个文件几条 |
|---|---|---|
| `SessionEntry` | 会话头:`model` + `promptHash` | 恰好 1 条,永远是根 |
| `MessageEntry` | 一条消息,原样存 pi-ai 的 `Message` | 很多 |
| `TurnEntry` | 一轮的结算:`reason` / `steps` / `usage` | 每轮 1 条 |
| `CompactionEntry` | 一次压缩:`summary` / `retainedTail` / `tokensBefore` / `reason` | 每次压缩 1 条 |

**共有的三个字段**(`EntryBase`):`id`(递增整数,给人手改用的)、`parentId`(只有会话头是 null)、`timestamp`。

⚠️promptHash有什么用，没这个会怎么样
| 字段 | 是什么 | 最容易搞错 |
|---|---|---|
| `promptHash` | **当时那份规则文件的指纹** | ⚠️ 只算 `prompts/system.md`,**不算**「今天几号」和记忆块 —— 算进去的话每天都报警,等于没报 |
| `retainedTail` | 压缩当时保留的那几条消息的**副本** | 和文件里的 MessageEntry 内容重复,是**有意的**:这一条 Entry 自己就够拼出压缩后的上下文 |
| `tokensBefore` | 压缩前那次请求的 prompt 有多大(provider 报的) | ⚠️ `number \| null`。**`null` 是「不知道」,不是 0** —— `--resume` 后立刻 `/compact` 就是那种情况 |
| `reason` | `manual`(人敲 `/compact`)或 `threshold`(判定出来的) | 查问题时这两种必须分得开 |

### Session:写入方
⚠️sync在哪里使用的
| 方法 | 干什么 | 最容易搞错 |
|---|---|---|
| `sync(messages)` | 把还没落盘的那部分追加进去 | ⚠️ **历史比已落盘的短就抛** —— append-only 表达不了「删掉中间某条」 |
| `recordTurn(result)` | 记一轮的账 | |
| `compact(...)` | 记一次压缩,**返回压缩后该用的那份历史** | ⚠️ 上面那条规则**唯一的合法例外**。必须拿返回值替换 `context.messages`,绕过去下次 `sync` 就抛 |
| `reset()` | `/new`:游标回到会话头 | **文件里一条都不删** |
| `broken` | 落盘失败过没有 | 失败**不中断对话**,但也绝不静默 |

内部状态(`WriterState`,不导出但决定行为):

| | 是什么 | 为什么要知道 |
|---|---|---|
| `written` | **已经落盘的消息条数**,`sync` 靠它算差量 | 压缩后要重新对齐到「压缩后这份历史有几条」。对不齐就会重复写或者抛 |
| `leafId` | 当前叶子。**只有 `advance()` 能动它**,树的形状全靠这一处 | |
| `nextId` | 下一个 id。`--resume` 时取**整个文件**的最大值+1,不是这条链的 | 取链上的话新 Entry 会和旧分支撞 id |

### 读出来
 ⚠️rebuild没注意过
| | 是什么 | 最容易搞错 |
|---|---|---|
| `Resumed` | `{ session, messages, ledger, promptChanged, compactions, full }` | |
| `Ledger` | 会话总账:`{ turns, input, output, cost }` | ⚠️ **只算 `runTurn` 的 usage**。压缩的摘要请求和散场抽记忆**不进账** |
| `compactions` | 这条链上压缩过几次 | 非 0 一定要告诉用户 —— 恢复出来比他上次看见的短 |
| `full` | 恢复的是压缩前的完整历史(`--resume-full`) | 默认 `false` = 摘要 + 尾巴 |
| `rebuild()` | 把链拼成要发给模型的历史 | 默认**不读过最后一个压缩点** |

---

## 四、memory —— 用户是个什么样的人,和旅行无关

`data/memory.json`,整体读整体写(`.tmp` + rename)。
 ⚠️ 长期记忆怎么触发
| | 是什么 | 最容易搞错 |
|---|---|---|
| `MemoryItem` | `{ id, kind, text, session?, createdAt? }` | `session` 是「**哪次会话之后抽的**」,不是「哪句话来的」 |
| `MemoryKind` | 三种:`constraint`(硬约束,不能被盖)/ `preference`(偏好)/ `visited`(去过) | `kind` 不认识就**整条丢掉**,不默认成 preference |
| `MAX_ITEMS` | 20 条上限 | 满了**拒绝并提示 forget**,不是 FIFO 顶掉 |
| `MAX_TEXT` | 单条 40 字 | ⚠️ 它**拦不住**「这次行程的细节」—— 实测 27 个字的行程细节照样通过。**长度和「长期还是这次」无关**,那件事归 prompt 管 |

两条写入路径,差别很大:

| | 什么时候 | 立刻生效吗 |
|---|---|---|
| `remember` 工具 | turn 中间,模型主动调 | ✅ 下一步就看得见 |
| `extractMemories` | `runRepl` 返回**之后**,额外一次模型请求 | 下次启动才生效。**只读 user/assistant 正文,绝不读工具输出** |

---

## 五、features —— 一块积木 = 一个文件

只通过 hooks 挂进去。`compose.ts` 里一个 `if` 决定装不装。

| 文件 | 挂哪 | 干什么 | 不给依赖会怎样 |
|---|---|---|---|
| `memory.ts` | `beforeStep` | 记忆 → `systemPrompt` | 不给 store:既不注册 `remember` 也不注入 |
| `compaction.ts` | `afterStep` | 上下文太长 → 前面一段换摘要 | **不给 session 就不装** —— 历史被换掉却没人记下来,不能接受 |
| `confirm.ts` | `beforeToolCall` | 不可逆的工具先问人 | 不给 asker 就不装 —— 没有用户就没有意愿要尊重 |
| `trace.ts` | 四个点全挂 | 把进出打到 stderr | |

### 压缩专用的词

| | 是什么 | 最容易搞错 |
|---|---|---|
| `RATIO` | 0.8,阈值取「可用输入」的百分之多少 | 这个数可以调,**分母的选法不能** |
| `usableTokens` | `contextWindow − maxTokens`,真正能留给输入的 | ⚠️ 阈值分母是它,**不是 `contextWindow`** |
| `KEEP_TURNS` | 2,最近几轮不压 | 2 不是 1:压缩发生在 turn 中间,最近一轮是用户正在等答复的那轮 |
| `cut` | **消息数组的下标** —— 第一条保留的消息在哪 | ⚠️ **不是轮数**。`cut < 2` 是**不压**;user 消息 ≤ 2 条时直接返回 0 |
| `lastPromptTokens` | 最近一次请求的 prompt 有多大,`afterStep` 每步更新 | ⚠️ 初值 `null`(不知道)。判定用的是**上一次**请求的大小,而会撞窗口的是**下一次** |
| `Compactor` | 手动触发入口,`/compact` 用 | 和自动那条是**同一段逻辑**,不是两份 |
| `warnedStuck` | 「压不动」只说一次的标记 | ⚠️ **不是开关**。第一版写成「压不动就永久关掉」,实测第 2 轮就撞阈值、那时压不动,于是后面一次都不压 |

---

## 六、token 词汇(跨层,最容易混)

一行 turn 摘要:`turn 3 / 2 step / in 266 / cache 14336 / out 173 / ctx 21 / $0.0003`

| | 是什么 | 谁给的 |
|---|---|---|
| `usage.output` | 模型吐了多少 | provider 返回 |
| `usage.cacheRead` | prompt 里**命中缓存**的部分,便宜 31 倍 | provider 返回。**字段不出现 = 没命中** |
| `usage.cacheWrite` | prompt 里**新写进缓存**的部分 | provider 返回。DeepSeek 报 0 |
| `usage.input` | 剩下的、全价那部分 | ⚠️ **算出来的**:`prompt_tokens − cacheRead − cacheWrite` |
| `promptTokens` | **模型这次实际看到的整个 prompt** = `input + cacheRead + cacheWrite` | ⚠️ 判断上下文多大**必须三项相加**。只看 `input` 在 DeepSeek 上会把 9616 当成 16 |
| `ctx` | 当前历史**多少条消息**,不是 token | 唯一能一眼看见「历史在涨」的数 |

**估算 vs 实测**,两个不同的东西:

| | 是什么 | 精度 |
|---|---|---|
| `usage.*` | provider 事后返回 | 准,但**永远晚一步** |
| `estimateContextTokens` | pi-ai 的字符数估算,`CHARS_PER_TOKEN = 4` | ⚠️ 中文**低估 3.5 倍**(1160 字符估成 290,实际约 1018) |
| `CONTEXT_SAFETY_TOKENS` | 4096,pi-ai 给估算误差留的保险 | 小窗口上占比过大 —— 4096 的窗口会被它整个吃光 |

---

## 七、入口层 —— 唯一允许「知道一切」的地方

| | 是什么 | 最容易搞错 |
|---|---|---|
| `compose()` | **唯一接线处**。加一块积木 = 这里加一行 | 真正的自由组合发生在这儿的 `if` 里,**不发生在 git 分支上** |
| `Composed` | `{ tools, hooks, compact? }` | `compact` 没开压缩时不存在,`/compact` 命令也跟着不存在 |
| `runRepl` | 多轮驱动 | ⚠️ **「轮次」这个概念只存在于这个文件**。core 只认识 turn |
| `Terminal` | 唯一碰 `stdin` / readline 的文件 | 开着它 Node 就不肯退 —— 所以**开终端放在启动流程的最后** |
| `isInteractive()` | 有没有真人在敲 | 管道喂进来的**不算**:那些行是提问,`ask_user` 会把下一行当答复吃掉 |
| `withToday()` | 给 systemPrompt 补一句「今天几号」 | 不写进 `system.md` —— 那是静态规则,日期每次运行都不同 |

---

## 八、旅行域

| | 是什么 |
|---|---|
| `tools/amap.ts` | 高德 REST 客户端(**不是** tool)。唯一碰 `AMAP_KEY` 的文件 |
| `truncateLines` | 双限制截断:`{ maxLines: 12, maxBytes: 1200 }`,谁先撞上谁生效,**永不返回半行** |
| `TripPlan` | 结构化行程的 schema。`save_plan` 的参数 |
| `report.ts` | `TripPlan` → 自包含 HTML。每处插值要么 `esc(...)`,要么变量名以 `Html` 结尾 |
