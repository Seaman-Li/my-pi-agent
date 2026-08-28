# prompt 缓存:一次排查记录

2026-08-29。起因是 `docs/prompt.md` 里一句「时命中时不命中,条件不知道」——
查下来根本不是「时好时坏」,是换模型了。这篇记结论,也记**怎么查的**,
因为方法比结论活得久:结论会随 provider 变,方法下次还能用。

---

## 结论

1. **token 数全是 provider 返回的,我们一个字没自己算。**
   `in` 还是个**减出来**的数:`prompt_tokens − cached_tokens − cache_write_tokens`。
2. **`qwen3.6-plus` 根本不返回 `cached_tokens` 这个字段** —— 不是返回 0,是键不存在。
   所以在它上面 `cacheRead` 结构上恒等于 0。
3. `qwen3.7-plus` 会返回。08-28 换成 3.6 是因为 3.7 免费额度用完了(403),
   缓存数从那一刻起全变 0 —— 时间点完全对得上。
4. **DeepSeek 官方 API 会返回**(字段名叫 `prompt_cache_hit_tokens`),而且命中率极高:
   同一句话 `in 270 / cache 6656`,**96% 的输入是缓存价**。
5. 缓存按 **128 token 一块**算 —— 观察到的每一个命中值都是 128 的整数倍。

一句必须说准的话:**我只能证明 3.6「不上报」,不能证明它「不缓存」。**
服务端可能照缓存不误,只是不告诉我们。但对我们来说后果一样 ——
**账上没有这个数,就没法拿它做任何决策。**

---

## 数据

### 历史 session 按模型分组

| 模型 | session | cacheRead |
|---|---|---|
| `qwen3.7-plus` | `20260827-034948` | 2176, 2176 |
| `qwen3.7-plus` | `20260827-134146` | 23936 |
| `qwen3.7-plus` | `20260827-221934` | 15872 |
| `qwen3.7-plus` | `20260828-004221` | 0, 0 |
| `qwen3.6-plus` | 其余 13 个 | **全 0**,包括 `in=70043` 那次 |

`004221` 是唯一的例外。它的 turn 1 是 `reason=error / in=0`,turn 2 才成功 ——
**没有成功写入过的前缀,自然读不到**。这是个合理解释,但没单独验证过,不当结论用。

### 同一句话,两个 provider

```
deepseek-v4-flash   2 step / in  270 / cache 6656 / out 186 / $0.0001
qwen3.6-plus        2 step / in 7021 /（没有 cache 这项）/ out 108
```

### DeepSeek 跨轮

```
turn 1   in  45 / cache 3328     ← 第一轮就命中：缓存在服务端，跨进程存在
turn 2   in 117 / cache 3328
turn 3   in  45 / cache 3456     ← 只涨 128，正好一个块
```

turn 1 就命中,是因为之前几次跑已经把「systemPrompt + 工具 schema」那段前缀写进去了。
这正是 `docs/prompt.md` 里量的那个「固定部分每步重发 6789 字符」——
在 DeepSeek 上它基本不要钱(`cacheRead` $0.007 对 `input` $0.22,**便宜 31 倍**)。

一次完整的黄山规划:3 step / `in 1864 / cache 12672` / **$0.0009**。

> 这个 `$` 是**用当时那张旧价表算出来的**,偏低。跑完之后才查清:代码里的价格抄自
> pi 的 `deepseek.json`,而那张表停在 2026-04-24 那版(`0.14 / 0.0028 / 0.28`);
> DeepSeek 自 2026-08-16 起改成按时段计价,off-peak 是 `0.22 / 0.007 / 0.66`,峰时翻倍。
> 价格表已经改成 off-peak 现价(`core/model.ts` 的 `DEEPSEEK_COST`),但**这一行的
> `$0.0009` 保留原样** —— 它是当时真跑出来的数,改成事后重算的值就不是实测了。
> 倍率变了,**结论没变**:重复前缀仍然便宜一个数量级。

---

## 怎么查的:九步

每一步只回答一个问题,只动一个变量。顺序不是事后整理的,就是当时走的路。

### ① 先问「这个数从哪来」,而不是「这个数为什么变」

**做法**:读 pi-ai 的 `packages/ai/src/api/openai-completions.ts`,找 usage 是怎么组装的。

```ts
// :1374 parseChunkUsage
const promptTokens    = rawUsage.prompt_tokens || 0;
const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens
                     ?? rawUsage.prompt_cache_hit_tokens ?? 0;
const input           = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
```

**结果**:全是 provider 给的,没有本地计数。而且 `in` 是减出来的。

**为什么先做这步**:如果这个数是我们自己算的,那「时命中时不命中」可能是**我们算错**,
排查方向完全不同。**没搞清一个数的来源就去解释它为什么变,是在赌。**

顺手还看到两件事:`stream_options: {include_usage: true}` 是 pi-ai 主动加的(`:708`),
不加流式响应压根不带 usage;`prompt_cache_key` **只在 baseUrl 含 `api.openai.com` 时才发**(`:700`),
所以我们对 dashscope 从来没发过显式缓存 key,能命中的都是隐式缓存。

### ② 把已有的 session 文件当天然对照组

**做法**:扫 `data/sessions/*.jsonl`,按 `SessionEntry.model` 分组统计 `cacheRead`。

```sh
node -e '
const fs=require("fs");
for(const f of fs.readdirSync("data/sessions").sort()){
  const es=fs.readFileSync("data/sessions/"+f,"utf8").trim().split("\n").map(JSON.parse);
  const h=es[0], ts=es.filter(e=>e.type==="turn");
  console.log(`${f.slice(0,17)} ${h.model.padEnd(14)} in=[${ts.map(t=>t.usage.input)}] cacheRead=[${ts.map(t=>t.usage.cacheRead)}]`);
}'
```

**结果**:按模型分得干干净净。

**为什么值得单说**:这 16 个样本**一次请求都没重发**就拿到了 ——
会话记录当初存 `TurnEntry`(reason / steps / usage)的理由是「这类字段事后补不上」,
这次直接兑现了。**先翻已有的数据,再去造新的。**

### ③ 绕过自己的抽象层,直接打 provider

**做法**:不经过 pi-ai,`fetch` 打 dashscope,原样打印 `usage`。

**结果**:

```
{"prompt_tokens":1064,...,"prompt_tokens_details":{"text_tokens":1064}}
```

**没有 `cached_tokens` 这个键。**

**为什么必须绕开**:这一步把「provider 没给」和「我们解析错了」彻底切开。
只要还隔着自己的代码,这两种就分不干净 —— 这是 Q7 那把刀在 HTTP 这一层的用法。

**顺带一条**:「字段不存在」和「值是 0」不是一回事,但经过 `?? 0` 之后长得一模一样。
只看我们的 `cacheRead=0`,永远发现不了这个区别。

### ④ 排除「前缀太短」

**做法**:把 system prompt 重复四遍撑到 4215 token,重测。

**结果**:还是没有 `cached_tokens`。

**为什么**:1064 token 可能低于某个门槛。不排除掉,「不上报」这个结论就不成立。

### ⑤ 排除「要等一会儿」

**做法**:同一前缀连发三次,第三次隔 3 秒。

**结果**:三次都没有。

**为什么**:缓存写入可能是异步的,第二次请求发出时还没落。

### ⑥ 想 A/B 另一个模型,撞上 403 —— 而这个 403 就是答案

**做法**:同样的探针换成 `qwen3.7-plus`。

**结果**:

```
403 Free quota exhausted. To continue accessing the model on a paid basis,
    please add funds or disable the "use free tier only" mode
```

**为什么这算收获**:它解释了 `.env` 里 `TRAVEL_MODEL_ID` 为什么在 08-28 从 3.7 变成 3.6 ——
**模型切换和缓存归零是同一个事件的两面**。到这里因果链才闭合:
不是缓存变得不稳定,是换了个不报缓存的模型。

### ⑦ 找一个会上报的 provider 来验

**做法**:接 DeepSeek 官方 API(见 `src/core/model.ts` 的 `deepseekFromEnv`)。

**为什么是它**:第 ① 步读源码时就看见了 `?? rawUsage.prompt_cache_hit_tokens` ——
那正是 DeepSeek 的字段名。**pi-ai 早就为这条路留了位置**,接上就能验。

### ⑧ 先截 body,再花钱

**做法**:起个本地 HTTP 服务器,把 `DEEPSEEK_BASE_URL` 指过去,跑一次 `stream()`,
把请求体打出来。不用 key、不花钱。

```
不带 --thinking   {..., "thinking":{"type":"disabled"}}
带 --thinking     {..., "thinking":{"type":"enabled"}, "reasoning_effort":"high"}
```

**结果**:配置确实生效了。**顺带抓到一个我推错的地方** ——
我按 `null ?? "low"` 推的是 `reasoning_effort: "low"`,实际是 `"high"`:
`clampThinkingLevel`(`models.ts:923`)遇到不存在的档位会**往上**找最近的可用档,
`low → medium(也没有)→ high`。

**为什么值得单独一步**:「配置写对了吗」和「provider 行为如何」是两个问题。
假服务器只回答前一个,而且零成本。真发出去之后再回头查,就分不清是配错还是对方不支持。

### ⑨ 真跑

`in 270 / cache 6656`。到这里结论闭环。

---

## 复现

```sh
# ① 看历史（不花钱）
node -e '...'   # 见第②步那段

# ② 直接打 provider 看原始 usage（约一次最便宜的请求）
#    关键是绕开 pi-ai，并且打印整个 usage 对象，而不是只取 cached_tokens
curl -s "$BASE_URL/chat/completions" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"...","messages":[{"role":"user","content":"在吗"}],"max_tokens":8}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["usage"])'
# 同一条连发两次，第二次看 prompt_tokens_details 里有没有多出 cached_tokens

# ③ 在 agent 里看
node src/cli.ts --model deepseek "成都明天天气怎么样"   # 摘要行有 cache 那一项
node src/cli.ts                  "成都明天天气怎么样"   # qwen3.6-plus，没有
```

---

## 还不知道的

- 3.6 到底是**不缓存**还是**只是不报**。目前无法从外部区分,也没打算再查 —— 不报就用不上。
- 128 这个块大小是观察出来的(所有命中值都是它的整数倍),不是文档确认的。
- DeepSeek 的缓存活多久。跨进程有效已经验到了,过期时间没测。

---

## 对 Step 7 的影响

压缩的判断依据是「上下文太贵了」。而**「贵」在两个 provider 上差一个数量级**:

| | 重复前缀的价格 | 该压什么 |
|---|---|---|
| `qwen3.6-plus` | 全价,一个 token 不打折 | 整个上下文都值得压 |
| `deepseek` | 1/31(`cacheRead` $0.007 vs `input` $0.22) | **只有新增的那部分**,主要是 `toolResult` |

所以 Step 7 **不能定一个写死的阈值**,得跟着 provider 的缓存能力走。
换模型的时候这件事必须重算 —— 而这次的教训正是:**模型换了,一个和它相关的数悄悄归零了,
没人注意到,直到两周后才从一句「时命中时不命中」查回来。**
