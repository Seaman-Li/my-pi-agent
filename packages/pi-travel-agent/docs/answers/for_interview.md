# 面试向:工具这一层的五个问题

> 2026-08-31 一次问答的整理。和 `docs/answers/q*.md` 一样,**每条结论要么指到自己代码的行号,
> 要么是当天跑出来的数**。另外单列了「pi 上游怎么做的」—— 有两个问题这个项目没解决,
> 但上游有成型的答案,值得知道它选了哪条路、为什么。
>
> 上游行号指仓库根的 `packages/`,自己的行号指 `packages/pi-travel-agent/`。

---

## 一、「loop 的失败路径没法确定性验收」指什么

**不是**「工具报错怎么处理」—— 那件事早就写完了,而且是有意这么设计的。
`core/loop.ts` 里有三条并列的失败路径,**全部变成一条结果,不变成异常**:

| 路径 | 位置 | 回灌给模型的内容 |
|---|---|---|
| `execute` 抛异常 | `loop.ts:206` | `error.message` 原文 |
| 模型编了个不存在的工具名 | `loop.ts:180` | `没有名为 "X" 的工具` |
| 参数校验没过 | `loop.ts:190` | `days 必须是整数` 这类 |

```
工具抛「查不到城市「成都市」的天气,换个写法试试」
   → 包成 isError: true 的 toolResult 进上下文
   → 模型下一步自己改成「成都」再调一次
```

**这本身就是一层重试**,而且不用写代码,见第二节。

BACKLOG 第一条说的是**这三条路径没有验收手段**。Step 2a 试过让模型故意用非法参数触发,
**三种问法它都拒绝** —— 它会读 schema 里的 description 自己先拦住。也就是说:

> 想测「模型犯错时 loop 怎么办」,得先让模型犯错,而模型不配合。

`max_steps`(`loop.ts:32`,上限 20)那条更极端 —— 要真烧掉 20 步才碰得到。

Step 9 的 `--replay` 买的就是这个:**喂一段固定的 assistant 消息进 loop,不发真请求**,
三条路径立刻变成确定的、免费的断言,和 `cases/adversarial.jsonl` 一个性质。

**一个现在就能摘的果子**:参数校验那条不用等 Step 9。`validateArguments` 是纯函数,
`{"days": "三天"}` → 抛什么消息,今天就能写进 `adversarial.jsonl`。
只有「execute 抛异常」和「工具名不存在」需要 replay。

---

## 二、工具报错要不要加重试

### 已经有了,而且刻意做得很窄

`tools/amap.ts:96`:

```ts
const RETRY_DELAYS = [350, 900];              // 退避两次
function isRateLimited(info: string) {         // :121
	return info.toUpperCase().includes("QPS");  // 只认 QPS,不认 DAILY_QUERY_OVER_LIMIT
}
```

那个 `"QPS"` 而不是 `"LIMIT"` 是整段的重点:**并发超限等 350ms 就好,日配额用完等到明天也是白等。**
对后者重试是把一次失败拖成三次。

为什么非重试不可:system prompt 要求「互相独立的查询一次性发出」,loop 的执行阶段又是并行的
(`loop.ts:220` 的 `Promise.all`),于是一批 6 个 `search_poi` 同时打到高德,
个人 key 稳定有一两个吃到 `CUQPS_HAS_EXCEEDED_THE_LIMIT`。
**「并行发」和「不重试」这两条同时成立就是个 bug,而并行不该退。**

### 重试为什么必须在工具里,不能在 loop 里

loop 不知道哪种错该重试,更不知道**哪个工具能重试**:

| 工具 | 重试安全吗 | 为什么 |
|---|---|---|
| `weather` / `search_poi` | ✅ | 只读 |
| `save_plan` | ❌ | 写文件,重试落两份 |
| `ask_user` | ❌ | 同一个问题问人两遍 |

给 loop 加通用重试 = 给非幂等操作加重试。

### 三层重试,层层不同

```
① 模型级   错误回灌 → 模型改参数重调        loop.ts:206     管语义错(城市名不对)
② 工具级   amap 的 QPS 退避                 amap.ts:151     管这个 API 的瞬时故障
③ provider 级  上游的 isRetryableProviderError                管 HTTP 传输层
```

第三层这个项目没自己写 —— `core/model.ts` 调的是 pi-ai 的 `stream()`,重试在它里面。

### pi 上游怎么做的

**全部在 provider 层,`core/tools/*.ts` 里一条 retry 都没有** ——
因为它的工具是本地的(bash/read/edit/write),没得重试。

`packages/ai/src/utils/provider-retry.ts:23`:

```ts
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");   // 服务端说了算,优先
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;
	if (error.status === undefined) return true;                 // ← 网络层抛的,重试
	return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
}
```

外加:认 `retry-after` / `retry-after-ms` 头(`:51`),指数退避 + jitter(`:66`),
服务端要求的延迟超过 60s 就**放弃而不是傻等**(`:43`)。

### 我们缺的三个口子(已记 BACKLOG)

对着上面那段一比就出来了 —— `amap.ts:146` 的 `!response.ok` 直接抛:

1. **5xx / 502 / 504** 一次都不重试(上游: `>= 500` 重试)
2. **`fetch` 自己抛的错**(DNS 抖动、ECONNRESET)根本没进循环(上游: `status === undefined` 重试)
3. **没有 per-request 超时** —— 有 `signal` 但没有 timeout

第 3 条最要紧,而且是唯一一个**会让 agent 完全无响应**的:`max_steps`(`loop.ts:32`)数的是步数不是时间,
连接挂住就只能 Ctrl-C。

---

## 三、工具 schema 全进上下文吗?占多少?

**是,全部进,每一步都进。** `compose.ts:89-97` 一次性注册,`registry.ts:49` 的 `schemas()`
把「发给模型的那一半」摘进 `Context.tools`,loop 每一步原样发。

### 实测(2026-08-31,默认 dashscope 模型,同一句「在吗」)

```
不带工具            1064 token
带 6 个工具         3228 token
────────────────────────────
工具 schema 占      2164 token   ← 占整个 prompt 的 67%
```

逐个单测再扣掉约 164 token 的固定框架费:

| 工具 | token | 占比 |
|---|---|---|
| weather | 151 | 7% |
| search_poi | 194 | 9% |
| search_hotel | 245 | 11% |
| estimate_budget | 285 | 13% |
| **save_plan** | **1035** | **48%** |
| ask_user | 255 | 12% |

**一个工具吃掉一半。** 原因在 `save-plan.ts:182`:`parameters: tripPlanSchema` ——
整份行程结构内联进 schema,光 `itinerary` 一个字段就 966 字符。

### 怎么省,按性价比排

**① 先瘦最贵的那个。** save_plan 占一半,动它一个顶动其余五个。零架构改动。

**② 「不注册」已经是一种按需加载。** `compose.ts:96-97`:没有 `asker` 就不注册 `ask_user`
(省 255),没有 memory 就不注册 `remember`。管道 / CI 里自动省下。粗粒度,但零成本。

**③ 描述的字数就是钱 —— 但这条有反作用力。** 砍 description 会直接换来第五节的准确率下降。
**这两个问题是同一根杠杆的两头,不能分开优化。**

**④ 真·渐进式加载** —— 见下一节,它不是「更好的 ①②③」,它有自己的代价。

---

## 四、什么情况才必须上渐进式加载

### 先看清楚:工具块是缓存前缀

工具 schema 在 prompt 的**最前面**。会话 `20260830-223410-ade9` 的真实 usage:

```json
{"input": 94, "cacheRead": 2944, "cacheWrite": 0}
```

```
input     94    ← 只有这一步新增的用户消息,按 0.22/M 计费
cacheRead 2944  ← system + 全部工具 schema,走 0.007/M —— 便宜 31 倍
```

也就是说:**工具集只要不变,从第二步起 schema 几乎是免费的。**

一旦改成「这一步给三个工具、下一步给五个」,前缀每次都变,缓存全废 ——
**而且是连它后面的整段历史一起废**,那部分本来是命中的。前缀失效是往后传染的。

> 渐进式加载省的是**窗口**,代价是**钱和延迟**。这两样东西不能互相换算,
> 所以「工具有点多」不是理由,得先说清楚紧张的是哪一样。

### 两个触发条件,满足其一才做

1. **schema 本身开始吃窗口** —— 几十上百个工具,静态全带已经挤掉了历史该占的位置。
   这时省的是窗口,而窗口是钱换不来的。
2. **工具集在一次会话内天然分段** —— 比如「规划阶段一套 / 落盘阶段一套」。
   一次会话最多失效一两次缓存,而不是每步一次,代价被摊掉了。

6 个工具、2164 token、压缩阈值还是 `usable × 0.8`(`features/compaction.ts`)—— 两条都不满足。

### pi 上游怎么做的:两条路,都不是「动态改工具集」

**路子一:工具本来就少,而且默认更少。**

- 一共 **7 个**:`packages/coding-agent/src/core/tools/index.ts:83`
  (`read | bash | edit | write | grep | find | ls`)
- 默认只开 **4 个**:`core/sdk.ts:245` 的 `defaultActiveToolNames = ["read","bash","edit","write"]`
- grep / find / ls **不在默认集里,因为 bash 覆盖了它们** —— 一个通吃工具顶四个 schema

再往上是**静态预设集合**,不是动态计算:

```ts
createCodingToolDefinitions(cwd)     // index.ts:138  read / bash / edit / write
createReadOnlyToolDefinitions(cwd)   // index.ts:147  read / grep / find / ls
createAllToolDefinitions(cwd)        // index.ts:156  全部七个
```

启动期还能减:`--exclude-tools`(`core/sdk.ts:246-251`)。
运行期确实能改(`agent-session.ts:928` 的 `setActiveToolsByName`,扩展也能调,
`core/extensions/types.ts:1342`),但那是**扩展显式换模式**,不是每步自动伸缩。

**路子二(更值得抄):要「按需展开」的东西,根本不做成工具。**

pi 的 skills 走的是另一条路 —— prompt 里只放索引,正文让模型自己去读:

```
core/skills.ts:335  formatSkillsForPrompt()
  <available_skills>
    <skill><name>…</name><description>…</description><location>/abs/path/SKILL.md</location></skill>
  </available_skills>
```

`:344` 那句是全部关键:**"Use the read tool to load a skill's file when the task matches its description."**
description 上限 1024 字符(`:14`),而且**整段只在 `read` 工具存在时才拼进去**
(`core/system-prompt.ts:65` / `:155`)—— 没有 read 就没法展开,索引也就没有意义。

这条路子的账算得比动态工具集漂亮:

| | 动态工具集 | skills 式索引 |
|---|---|---|
| 前缀 | **每步都变,缓存全废** | 不变,索引进缓存前缀 |
| 正文 | —— | 按需以 toolResult 进上下文 |
| 模型要多做的事 | 无 | 多一次 `read` 调用 |

**结论:先问「这块东西能不能不做成工具」,再问「工具能不能动态加载」。**
MCP 的 `list_tools` 是第三条路(把工具目录本身变成一次工具调用),那是 Q8 / Step 10 的题。

---

## 五、工具变多之后怎么保证选对

现在 6 个,这个问题还没出现。但**已经踩过一次,而且是最典型的那种**
(BACKLOG「地图坐标曾经全是编的」):

> system prompt 和 schema 都要求模型「原样抄 `search_poi` 返回的经纬度」,
> 可 content 里**从来没有经纬度**。模型不报错,**它编**。
> 实测宽窄巷子编成 `104.0576,30.6698`,高德真值 `104.053307,30.663869` —— **差 750 米**。
> 而这还是全国最有名的地标。

修法不是把坐标塞进 content 让它抄得更准,是 `save-plan.ts` 的 `resolveLocations()`
自己按 name 去查 —— **把模型从这件事里拿掉**。

### 手上已有的四件事,按有效性排(都不是 prompt 技巧)

1. **能不给模型的决定权就别给。** `slugify`(`save-plan.ts:36`)—— 落盘名不由模型给,
   于是路径穿越**没有入口**,不是被挡住了。这条比任何 prompt 写法都硬。
2. **不给它填不准的参数。** `search-hotel.ts:6`:「给个 `priceLevel` 参数等于在 schema 里对模型撒谎 ——
   它会照着传,然后拿到一批和价格无关的结果,还以为筛过了。」
   **schema 里每多一个它填不准的字段,就多一条编造路径。**
3. **校验 + 错误回灌**(`loop.ts:189`)—— 参数选错能自我修正。
4. **重名装配期就炸**(`registry.ts:26`)—— 「调了 A 却执行了 B」在源头排除。

### 缺的是一个数

现在两批用例都测不到工具选择:

| | 测什么 | 发请求 | 确定 |
|---|---|---|---|
| `cases/adversarial.jsonl` | 纯函数(`classify` / `slugify`) | ❌ | ✅ |
| `cases/injection.jsonl` | 模型**拒绝**的行为 | ✅ | ❌ |
| **缺的第三批** | 一句话 → **该调哪个工具、什么参数** | ✅ | ❌ |

没有它,加第 15 个工具时只能凭感觉说「好像还行」。
分组 / 子 agent 那些手段得等有了这个数再谈 —— 否则不知道在优化什么。
**触发条件写死:工具数过 12,或出现第一次实测的「选错工具」。**

### pi 上游怎么做的:evals,而且刻意不用 pass/fail

`packages/evals/` 是一套 model-backed 的行为 eval:用 `vitest-evals` 跑真的 `AgentSession`,
在隔离的临时目录里,**断言直接落在 `toolCalls` 上**。
`src/extensions.eval.ts:79`:

```ts
if (!toolCalls.some((call) =>
	call.name === "hello" && call.status === "ok" &&
	call.arguments?.name === "Bob" && call.result === "Hello, Bob!"))
	failures.push('no successful hello({ name: "Bob" }) call returned "Hello, Bob!"');
```

**最值得抄的是它的记分方式,不是它的断言。** `evalHarnessTable`(README「Writing comparative eval sets」):

- `repetitions: 6` —— 同一条跑六遍
- `judgeThreshold: null` —— **低分是一次观察,不是一次失败**
- 比的是 baseline 和 candidate 的 **pass-rate lift**(百分点差),外加 token / 延迟 / 成本的配对差值
- README 明写:「Use hard assertions only for suite invariants and infrastructure contracts.」

这正好是 `cases/injection.jsonl` 一直缺的框架 —— 那批现在是硬断言,所以「这次绿不代表下次绿」
只能写在注释里(BACKLOG「注入用例会抖,而且只跑过 5 轮」)。
**同一套东西也正好是「工具选对没有」的载体**:选工具和挡注入都是模型行为,
都会抖,都不能进 CI,都只能用重复次数和 lift 来说话。

---

## 六、一页速查

| 问题 | 这个项目 | pi 上游 |
|---|---|---|
| 工具报错 | 包成 toolResult 回灌(`loop.ts:206`) | 同 |
| 工具级重试 | 只覆盖高德 QPS(`amap.ts:121`) | **没有** —— 工具是本地的 |
| 传输级重试 | 靠 pi-ai | `provider-retry.ts:23`,408/409/429/5xx + `retry-after` |
| loop 级重试 | **没有,而且不该有**(非幂等) | 同 |
| 工具数 | 6(其中 save_plan 占 schema 的 48%) | 7,默认开 4 |
| 减 schema | 按开关不注册(`compose.ts:96`) | 静态预设集合 + `--exclude-tools` |
| 动态加载 | 没做,理由见第四节 | 没做(运行期可换,但由扩展显式触发) |
| 「按需展开」 | 无 | **skills:索引进 prompt,正文用 `read` 取**(`skills.ts:335`) |
| 选对工具 | 靠「把决定权拿走」+ 4 条硬约束 | `packages/evals/`,断言落在 `toolCalls` |
| 会抖的验收 | 硬断言(已知缺陷) | `repetitions` + `judgeThreshold: null` + pass-rate lift |
