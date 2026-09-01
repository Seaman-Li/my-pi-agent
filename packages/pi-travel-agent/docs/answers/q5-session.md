# Q5:session 怎么持久化和恢复

> 八个问题之五。落在 Step 5(5a 多轮 + 5b 落盘)。
> 行号都指本仓库 `packages/pi-travel-agent/`,截至 Step 5b 收尾。

## 一、先分清三个层次

| 概念 | 谁的单位 | 谁维护 |
|---|---|---|
| **step** | 一次模型请求 + 它要的那批工具 | `core/loop.ts`,一个 turn 之内 |
| **turn** | 若干 step,直到模型不再要工具 | `core/loop.ts` 的 `runTurn` |
| **轮次 / Entry** | 用户说一句 → 助手答完 | `repl.ts`,**loop 完全不知道有这一层** |

`grep -rn "session" src/core/loop.ts src/core/hooks.ts` 是空的。
这不是巧合,是这一整套设计的前提。

## 二、Entry 在哪生成 —— 不是 loop 埋点

写文件的只有四行,全在 `repl.ts` 的轮次边界上:

```
repl.ts:87    session.reset()                    /new,游标回会话头
repl.ts:184   session.sync(context.messages)     push 完用户那句话就落盘
repl.ts:221   session.sync(context.messages)     turn 跑完 + 收拾干净之后
repl.ts:222   session.recordTurn(result)         这一轮的账
```

**一轮写两次**是有意的:用户那句话单独先写(184),因为 turn 可能跑两分钟、可能被 kill,
而「用户说了什么」是整份记录里最不该丢的东西 —— 它是重放的起点。

### 为什么不挂 `afterStep` hook

这是最容易想到的做法,而且错得不明显。三条理由,第一条是硬的:

**1. step 结束时历史不自洽。** 假设在 `afterStep` 里落盘:

```
step 1  模型说「我查一下天气」+ toolCall(weather, id=call_abc)
        loop.ts:254   push assistant                 ← 内存里有了
        ───── 如果这时落盘 ─────                      ← 文件里也有了
        loop 开始执行 weather…
        ⌨ Ctrl-C
        loop.ts:244   发现 aborted,break             ← toolResult 永远不会 push
```

文件里于是留下:

```
id=3  message  assistant  toolCall(weather, id=call_abc)
                          ← 没有配对的 toolResult
```

下次 `--resume` 走到 `session/store.ts:254` 的 `checkToolCallsPaired`,当场报
`断链:工具调用 "weather"(id call_abc)没有对应的结果`。

**而这份断链是我们自己写的,用户什么都没改。** 那条校验本来是用来抓「文件被人改坏」的,
被自己的正常退出触发之后就废了 —— 报警器天天误报,等于没有报警器。

现在的顺序避开了它:

```
repl.ts:192   runTurn 返回(reason = "aborted")
repl.ts:209   repairDanglingToolCalls  → 给 call_abc 补一条「这次调用没有执行:上一轮被用户中断了」
repl.ts:210   dropEmptyAssistantMessages
repl.ts:221   session.sync             → 这时才写,写下去的是补齐的版本
```

**落盘时机必须落在「历史处于自洽状态」的那一刻。step 结束不是,turn 结束且收拾完才是。**

**2. 顺序对不上。** 收拾历史发生在 `runTurn` 返回**之后**(`core/context.ts:35` 和 `:105`),
hook 跑在 loop 内部,够不着那个位置。

**3. 职责错位。** hook 是给「改模型看到什么」用的(`beforeStep` 注入、`beforeToolCall` 拦截)。
记账不改任何东西,它是旁观者,而旁观者不需要挂在被观察者身上。

### 代价

单轮模式(`cli.ts` 的 `runOnce`)没有这四行,所以**不记会话**。
已记进 BACKLOG,等**真重放**那一批补 —— Step 9 做的是假模型(不发请求跑 loop),
和「把一次真实运行重跑一遍」是两件事,后者才要求单轮也有记录。

## 三、上下文怎么管:一个对象,原地追加

```
cli.ts:191    const context: Context = { systemPrompt, messages: [] }   只造一次
   ↓
repl.ts:181   context.messages.push({ role:"user", … })                 每轮加一条
   ↓ 传引用，不是拷贝
loop.ts:254     context.messages.push(message)                          模型回复
loop.ts:268     context.messages.push(...results)                       工具结果
   ↓ runTurn 返回
repl.ts:209   repairDanglingToolCalls(context)                          看到的是 loop 刚加完的样子
repl.ts:221   session.sync(context.messages)                            全量
```

**没有第二份历史。** `loop.ts:37` 写着这条契约:
「会被原地追加:assistant 消息和工具结果都进这里,所以调用方持有的就是全量历史」。

因此 `sync` 传的是**全量而不是增量** —— repl 不知道 loop 这一轮加了几条(可能 2 条,
也可能 20 条),它只知道「现在总共这些」。差量由 `store.ts:98` 里的 `written` 计数器算。
这样「哪些已经写过了」这个状态只有一处,不用在两边对齐。

## 四、文件长什么样:一行一个 Entry,parentId 串成树

`data/sessions/<id>.jsonl`(gitignore):

```
id=1 parent=null  session   model=qwen3.7-plus promptHash=b0f1527f054c
id=2 parent=1     message   user: "我叫李四，下周想去成都。"
id=3 parent=2     message   assistant: "你好李四！…"
id=4 parent=3     turn      1 step / in 2789 / completed
```

**为什么是树而不是数组**(`session/types.ts:28`):会话里天然有「回到之前某个点重新开始」。
现在是 `/new`,将来是「把刚才那句改一下重问」。数组要回头改文件,树只要换个父节点:

```
/new 之后 ↓
id=4 parent=3   turn                  旧的那串(2、3、4)一条没删
id=5 parent=1   user: "我是王五…"      ← 挂回了会话头
```

`id` 用**递增整数不用 uuid**:这个文件是要给人手改的(Q5 的验收方式就是手改它)。
`"parentId": "7"` 一眼对得上第 7 行,ULID 不行。pi 用随机 id 是因为它要跨进程跨 lane 合并
(`packages/agent/src/harness/session/types.ts:14`),我们一个进程一个文件,可读性更值钱。

`turn` 那种 Entry 不存也能恢复对话,但恢复不了**账**。这类字段的特点是**事后补不上**。

## 五、resume 怎么做到的

`session/store.ts:322` 的 `resumeSession`,五步:

```
1. parseEntries(path)          store.ts:184   逐行 JSON.parse，报行号；查 id 重复
2. chainToRoot(entries)        store.ts:220   从「文件最后一行」沿 parentId 回溯到根，反转
3. filter(type === "message")  store.ts:332   链上的 message Entry → Message[]
4. checkToolCallsPaired        store.ts:254   toolCall 必须有配对的 toolResult
5. 从链上的 turn Entry 累加账   store.ts:337
```

第 2 步是全部关键:**「当前历史」不是「文件里所有行」,是「从叶子回溯到根的那一条链」。**
`/new` 之后的行挂在根下面,旧的那串自然走不到。

同时构造出接着写的状态(`store.ts:348-353`):

```ts
nextId  = 整个文件的 max id + 1     // 不是这条链的 —— 否则新 Entry 会和旧分支撞 id
rootId  = 会话头的 id
leafId  = 链的最后一个              // 下一个 Entry 挂在它下面
written = messages.length          // 已落盘 N 条，sync 从第 N+1 条开始追加
```

### 恢复出来的上下文怎么进到模型手里

一行:

```ts
cli.ts:221    context.messages = restored.messages;
```

不需要转换、不需要重放、不需要「喂」给模型 —— **存的时候就是原样存的 pi-ai `Message`,
读回来还是同一个形状**。之后这个 `context` 照常走 `runRepl` → `runTurn` → `stream()`。

所以「resume 之后再问桂林行程,它没有重查天气」是必然的:那条 toolResult 又发过去了。

配套两样(`cli.ts:237-238`):

```ts
session: restored?.session ?? createSession(…)   // 复用同一个写入方，接着往同一个文件写
ledger:  restored?.ledger                        // 账接着算，不从 0 开始
```

### 恢复了要让人看见

`repl.ts` 开场会回放历史(`render.ts` 的 `formatHistory`),只放用户说的话和模型正文,
中间的工具步折成 `⋯ N 步工具调用`。

不回放的话屏幕上和新开一个会话一模一样,用户只能试探性地问一句去撞 ——
而「模型记得刚才的事」恰恰是多轮唯一的卖点,看不见就等于没有。
工具步不显示但**要报数**:那 N 步是真花了钱、真进了上下文的。

## 六、验收:手改 JSONL,四种断法四种报错

「报错而不是静默跳过」是这一题的硬标准。静默跳过的后果是
**模型收到一段少了几句的历史,而人完全看不出来**。

| 手改成什么样 | 报什么 | 哪一层抓的 |
|---|---|---|
| 某行加个逗号 | `x.jsonl:3 不是合法 JSON:Unexpected non-whitespace character…` | `parseEntries` |
| id 重复 | `x.jsonl:6 id "5" 和前面某条重复了` | `parseEntries` |
| `parentId` 改成 `"99"` | `断链:Entry "5" 的 parentId 是 "99",但文件里没有这个 id` | `chainToRoot` |
| 删掉一条 toolResult **并把链重新接好** | `断链:工具调用 "weather"(id call_…)没有对应的结果` | `checkToolCallsPaired` |

第四条是特意构造的:光删一行会被 `parentId` 检查抓住,所以要把后面那条的 parentId
接回它的父节点 —— 链完全合法,只有第二层才抓得出来。

另外三条边界:

- **写不进去不打断对话**:`chmod 444` 之后打一句 `[会话记录写不下去了] EACCES…`,
  之后不再重试,聊天照常。聊天比记账重要,但也绝不能静默。
- **prompt 变了会提醒**:会话头存了 system prompt 的指纹,对不上就说一声
  「你接着聊的这段历史是在另一套规则下产生的」。
- **`--resume=<id>` 不写成 `--resume <id>`**:后者没法和 prompt 区分开,会把话吃掉。

## 七、现在还不支持什么

**a) resume 不到某一个 Entry。** `store.ts:220` 的起点写死了:

```ts
let current: Entry | undefined = entries[entries.length - 1];   // 文件最后一行
```

`--resume=<id>` 里那个 id 是**会话 id(文件名)**,不是 entry id。

**b) 不能从某个 Entry 开分支。** 唯一的分叉是 `/new`,而且固定挂回根(`store.ts:133`):

```ts
reset(): void {
    state.leafId = state.rootId;   // 只能回到根
    state.written = 0;
}
```

**数据结构完全支持** —— 手写一行 `parentId: "10"` 追加进去,`resumeSession` 就正确读出了
从 10 分叉的新链(25 条变 10 条,旧分支还在文件里)。**缺的是入口。** 要做是三件事:

1. `chainToRoot(entries, path, fromId?)` 加起点参数,`resumeSession` 透传
2. `reset()` 变成 `rewind(entryId)`:`leafId = entryId`,而 `written` **要重算成
   那条新链上的 message 条数** —— 清 0 只对回到根成立,回到中间清 0 会把已落盘的消息再追一遍
3. 分叉点要校验:不能落在工具调用答到一半的地方。实测从 id=7(五个并行调用只答了两个)
   分叉,`checkToolCallsPaired` 当场报错。落在 `turn` Entry 后面最安全

加上 REPL 入口(`/rewind` 列出每一轮让人选),大概 80 行。BACKLOG 里有,坑 2 也写进去了。

**c) 「从一个 Entry 新建一个 session」不打算做。** 那是复制成另一个文件。
同一个文件里分叉才是 append-only 树的意义,拆成两个文件反而丢掉了
「这两段有共同前缀」这个信息。

## 八、一句话总结分层

```
core/loop.ts      只认识「一轮之内的 step」，不认识 session，也不认识轮次
repl.ts           在轮次边界上调 4 次 session 的方法 —— 这是唯一的接缝
session/store.ts  只认识「Entry 和文件」，不认识终端、不认识旅行
```

三层互相不知道对方存在,靠 `repl.ts` 那四行接起来。
这也是为什么 `session/` 那 437 行能整体搬去做下一个 agent —— 它不依赖任何上面的东西。
