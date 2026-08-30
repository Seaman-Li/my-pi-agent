# Q4:长上下文怎么压缩

> 八个问题之四。落在 Step 7。
> 行号都指本仓库 `packages/pi-travel-agent/`,截至 Step 7 收尾。
> pi 的行号指 `packages/agent/`、`packages/ai/`。

## 一、压缩是三件事,不是一件

写之前以为压缩就是「历史太长了,叫模型总结一下」。真做下来是三件互相咬住的事:

| | 问题 | 落在 |
|---|---|---|
| **什么时候压** | 阈值取在哪个数上 | `features/compaction.ts:93` |
| **从哪儿切** | 切错地方会让上下文不合法 | `features/compaction.ts:112` |
| **怎么记下来** | append-only 的文件表达不了「历史变短了」 | `session/store.ts:163` |

第三件是最容易漏的,而它决定了前两件能不能落地 —— **只要历史会变短,记录侧就必须先有位置放它**,
否则第一次压缩当场抛在 `sync` 上(`session/store.ts:139`,「历史从 N 条变成了 M 条」)。
所以这一批的下刀顺序是 session → model → features,不是反过来。

## 二、什么时候压:阈值取在「可用输入」上

计划里抄的是 pi 的三行:

```ts
// packages/agent/src/harness/compaction/compaction.ts:247
return contextTokens > contextWindow - settings.reserveTokens;   // reserveTokens 默认 16384
```

**`reserve` 是个常数,而 `maxTokens` 在三条 provider 上差 23 倍。** 这是查 DeepSeek 窗口时撞出来的:

| | contextWindow | maxTokens | 常数 16384 够吗 |
|---|---|---|---|
| `qwen3.6-plus` | 1M(输入上限 991.8K) | 65,536 | 差 4 倍 |
| `deepseek-v4-flash` | 1M | 384,000 | **差 23 倍** |
| local ollama | 8,192 | 2,048 | 勉强 |

现在没出事纯属巧合:`1000000 − 16384 = 983,616`,正好落在 qwen 的真实输入上限里面。
换到 deepseek、模型真吐满 384K 的话,`983K + 384K = 1.37M > 1M`,provider 甩 400。

最后的写法是**把 `reserve` 换成 `maxTokens` 本身**,再取百分比(`features/compaction.ts:88`):

```ts
usable = contextWindow - maxTokens          // 真正能留给输入的
shouldCompact = promptTokens > usable * 0.8
```

一个常数 `RATIO`,没有 per-provider 表,23 倍的差异自动被吸收。

**不能取在整个窗口上。** `promptTokens > contextWindow * 0.8` 看着更简单,但留下的 20% = 200K
对 deepseek 的 384K 输出根本不够;要让它成立,`RATIO` 得满足 `RATIO ≤ 1 − maxTokens/contextWindow`——
deepseek 上是 61.6%,**而这个上限本身就是 provider 相关的**,等于把刚赶走的表又请回来。
同一个「百分比」,分母选错就不自洽。

配套加了一道启动校验(`core/model.ts:286`):`contextWindow <= maxTokens` 直接抛。
理由是验收时要把窗口调到 12k 触发压缩,只改一个数的话 `usable` 会变成负数,
阈值跟着变负 → **每一步都判定该压**,看着完全像压缩逻辑写坏了。在配错的那一刻报便宜得多。

### 这个数从哪来:三项相加,不是 `usage.input`

`features/compaction.ts:83`:

```ts
promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
```

**只看 `input` 会漏掉大头。** `input` 是减出来的
(`prompt_tokens − cached_tokens − cache_write_tokens`,见 [prompt-cache.md](../prompt-cache.md))。
实测这次验收里的一步:`in 16 / cache 9600` —— 只看 `input` 会把 9616 token 的上下文当成 16,
阈值永远不触发。而 DeepSeek 正是缓存命中率最高、也最需要压的那条路。

这条不是推理出来的,是 Step 6 之后查缓存归零那件事顺带查清的:同一份代码在
`qwen3.6-plus` 上 `cacheRead` 恒为 0,在 DeepSeek 上到 96%。**换个 provider,这个 bug 就隐形了。**

## 三、从哪儿切:只能切在 user 消息上

`features/compaction.ts:112`。切点只能是 `role === "user"` 的位置,理由有两条,都不是风格问题:

1. **协议**。从 toolResult 中间切,保留的那半截里会有「没有发起者的工具结果」。
   OpenAI / Anthropic 都要求 `tool_calls` 和 `tool` 消息配对。
2. **我们自己的校验**。`session/store.ts` 的 `checkToolCallsPaired` 下次读记录时会当成断链报错 ——
   也就是说切错地方的后果不是「模型有点困惑」,是**下次 `--resume` 直接打不开**。

一轮总是从 user 消息开始,所以在 user 消息处切,留下的一定是若干个完整的轮。
pi 的 `findValidCutPoints`(`packages/agent/src/harness/compaction/compaction.ts:313`)是同一条规矩。

保留最近 `KEEP_TURNS = 2` 轮(`:38`)。2 而不是 1,是因为压缩发生在 turn 中间 ——
「最近一轮」必然是用户正在等答复的那一轮,一个字都不能丢;再往前留一轮,
是为了让「算了不去成都了」这种紧挨着的改口还在原文里。**摘要最容易丢的就是否定和转折。**

### 摘要自己也是一条 user 消息

`session/types.ts:116`。pi 有个专门的 `compactionSummary` 角色
(`packages/agent/src/harness/messages.ts:94`),我们用的是 pi-ai 的 `Message`,只有三种角色,加不了第四种。

那就只能在 user 和 assistant 里选,**选 user**:assistant 消息是模型说过的话,
伪造一条等于在历史里编造模型的发言 —— 和 `core/context.ts` 里「不在历史里编造一次沉默」
是同一条原则的两面。摘要是外面塞进来的材料,和工具返回值同类,标注清楚就行。

代价是它也成了一个合法切点:压第二次时旧摘要会落进被压的那段,
于是**新摘要是从旧摘要生成的**。这不是缺陷,是信息接着往下传的方式 —— 实测第三次压缩的摘要里
「本来去成都3天,后改为西安3天(成都行程作废)」还在。

## 四、怎么记下来:CompactionEntry + 先落盘后记点

`session/types.ts:89`。压缩产物是一条新 Entry,**旧消息一条不删**:

```ts
{ type: "compaction", summary, retainedTail: Message[], tokensBefore, reason }
```

`retainedTail` 和文件里那几条 MessageEntry 内容重复,是有意的 —— 这一条 Entry 自己就够拼出
压缩后的上下文。重复几 KB 换一个自包含的锚点。

**顺序是先落盘、再记压缩点**(`session/store.ts:163`),不能反过来:

压缩发生在 turn 中间,而 `repl.ts` 是 turn 结束才 `sync` 的 —— 这一刻文件里还没有本轮产生的消息。
先记压缩点的话那几条就此消失,「恢复成压缩前的样子」当场断掉,而且**没有任何报错**。

之后 `written` 重新对齐到压缩后的长度(`:178`)。这几条在文件里都有对应物:
摘要对应 Entry 本身,尾巴对应 `retainedTail`。所以下一次 `sync` 只追加压缩之后新说的话。

### `tokensBefore` 只能说真话,不能说 0

`tokensBefore` 想回答的是「这次压缩把多大的东西压掉了」—— 事后判断压缩值不值的唯一依据。
它的值来自 `lastPromptTokens`,而那个变量**只在每步跑完之后**才被 provider 返回的 usage 填上。

于是有一条路上它是空的:`--resume` 之后立刻 `/compact`,这个进程一次请求都还没发过。
一开始那个变量的初值写的是 0,实测记录里就出现了:

```
已压缩:21 条 → 12 条(压缩前 prompt 0 token)
reason=manual  tokensBefore=0  retainedTail=11
```

**21 条消息不可能是 0 token。** 改成 `number | null`,`null` 就是「不知道」:

```
已压缩:7 条 → 5 条(压缩前多大不知道:这个进程还没发过请求)
```

摘要消息里「原文约 N token」那半句在 `null` 时**整句不出现** —— 那条消息是给模型看的,
一个用不上的数字只是噪声,一个错的数字它会当真。

这条和 BACKLOG 里「被中断那一轮的 usage 是 0」是同一条教训,那条也定过同样的调子:
**宁可显式说「未知」,也不填一个猜出来的数**。判据是「假数据比没数据更糟」——
没有你会去查,假的你会信。

### 恢复的时候能选

`session/store.ts:257` 的 `rebuild`:从后往前找到第一个 compaction,它之前的 MessageEntry 一条不要。
`--resume-full` 就当压缩没发生过。实测同一个会话:

```
--resume        历史 11 条,约 3623 字符
--resume-full   历史 27 条,约 12524 字符
```

**这正是 `retainedTail` 存副本换来的能力** —— 两份历史都在文件里,恢复时才有得选。

手改防线跟着补了一道(`:319`):`summary` 空、`retainedTail` 不是数组、`reason` 不认识,
三种都带行号报错。为什么单查它:一个 summary 被清空的 compaction 行不会让任何东西崩,
只会让模型**静悄悄少看一大段**,而人从终端上完全看不出来。

## 五、挂在哪个点上:`afterStep`,而且要 `results`

`compose.ts:87` → `core/hooks.ts:27`。`AfterStepContext` 带 `results`,
这个字段在 Step 2b 建骨架时就是为压缩留的。

挂 `afterStep` 而不是 `beforeStep`:要看到**这一步的工具结果也进了上下文之后**的样子。
一步里查了六个 POI 撑爆上下文,挂 beforeStep 得等到下一步才发现。

`core/loop.ts:262` 和 `:271` —— 两个调用点保证**每个 step 恰好触发一次,包括最后一步**。
`loop.ts` 一个字没改。

## 六、防死循环的闸:一开始写错了,实测才发现

第一版写的是「找不到可压的切点就永久关掉压缩」。看着很合理,实测是错的。

把窗口调到 12000 跑五轮,输出里:

```
turn 1  ctx 16
[压缩] 压不动:能压的只有 0 条,最近 2 轮要留着     ← turn 2,只有 2 轮,切不出来
[压缩] 已压缩:28 条 → 13 条(压缩前 prompt 8266 token)
[压缩] 已压缩:23 条 → 21 条(压缩前 prompt 9616 token)
[压缩] 已压缩:23 条 → 5 条(压缩前 prompt 9737 token)
```

**第 2 轮就撞了阈值,而那时候只有 2 轮、压不动。** 要是留着那个开关,后面三次压缩一次都不会发生 ——
而且不报任何错,表现是「压缩功能好像没生效」。

不 latch 也不会空转:`features/compaction.ts:224` 那条分支**一次模型请求都不发**,
而真压成功时历史严格变短(至少 2 条换成 1 条),迟早落到这里停下。
代价只是「压不动」这句话会每步都说一次,所以加了个只说一次的标记(`:261`)。

**这条是这一批最值钱的东西**:一个看着显然正确的防御,在真数据上是主逻辑的开关。
光读代码看不出来,得让它跑在「阈值很低、轮数很少」那个组合上。

## 七、验收

计划里的验收是「触发压缩;压缩后跟的是**新**意图」,加上 Q4 额外要回答的
「压缩后追问细节还答得上吗」。

**用 12000 的窗口跑五轮,意图变更放在会被压掉的那一段里**(第 3 轮说「算了不去成都了,改去西安」,
之后又聊了两轮,把它推进摘要)。

第 5 轮问「那第二天上午安排什么?」——回答全是兵马俑、华清宫、钟楼、陕历博,**成都出现 0 次**。

但这一轮还不算数:那时意图变更还在保留的尾巴里,是原文不是摘要。所以又补了决定性的一轮 ——
`--resume` 之后(上下文只剩 `摘要 + 4 条尾巴`)问「我们预算多少来着?几个人?第三天原本排的是什么?」:

| 问的 | 答的 | 只存在于 |
|---|---|---|
| 预算 | 3000 元,估算 2908,结余 92 | 摘要 |
| 人数 | 2 人 | 摘要 |
| 第三天 | 陕历博(需小程序预约)+ 大雁塔,富余可加小雁塔 | 摘要 |

三个全对。**一句「压缩后它还答得上来」要成立,得让被问的东西只可能来自摘要** ——
不然测的是「原文还在不在」,不是摘要质量。这和 Step 6 那条教训是同一件事:
验收词必须配一个会失败的对照组。

其余四项:

- JSONL 里能看到 compaction entry,`reason=manual tokensBefore=10947 retainedTail=10 summary=623字`
- 手改四种(summary 空 / reason 乱填 / retainedTail 不是数组 / tokensBefore 写成 `"unknown"`)全部带行号报错;
  `tokensBefore: null` 照常读得动
- `--no-compact` 之后一次都不压,`/compact` 报「不可用」
- `contextWindow <= maxTokens` 启动就抛,退出码 1

## 八、还没做的

- **overflow 触发没做。** 计划里三种触发原因(manual / threshold / overflow),只做了前两种。
  overflow 是「provider 说这次请求超窗口了」,要靠捕获错误路径 —— 和
  [BACKLOG 里 loop 失败路径那条](../../BACKLOG.md)一样,不依赖模型配合才测得了,等 Step 9 的 `--replay`。
- **摘要那次请求不进账。** 它走 `stream()` 而不是 `runTurn`,`ledger` 收不到 ——
  和散场抽记忆是同一个口子,记在 BACKLOG 里了。
- **单轮模式没有压缩。** 没有 session 就不装这块积木,而单轮不建会话文件。
- **没有「发之前就知道多大」的估算器。** 判定用的永远是上一次请求的大小,而会撞窗口的是下一次 ——
  中间隔着的正是那次危险的请求。窗口 1M 时无所谓,窗口 8K 时那一步就是撞墙的那一步,
  而 ollama 撞上去是**静默截断,不报错**。两个真消费者(Step 8 的输入上限、turn 内压缩)都还没做,
  所以估算器等它们一起写 —— 没有消费者的通用件验不出对错。设计和「自校准」的做法记在 BACKLOG。
