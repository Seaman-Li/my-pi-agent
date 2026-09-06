# 架构图与工作流图

四张图,两两成对:同一个问题,一个是自己手写的 agent 怎么答的,一个是 pi 上游怎么答的。

| 图 | 看什么 | 规格 |
|---|---|---|
| [`travel-agent.architecture.html`](travel-agent.architecture.html) | 旅行助手的分层:loop 只读、compose 唯一装配处、两个 key 出口、两份 harness | [`.json`](travel-agent.architecture.json) |
| [`travel-agent.workflow.html`](travel-agent.workflow.html) | 一个 turn 怎么跑完:四个挂载点在哪儿插进去、六种结束方式 | [`.json`](travel-agent.workflow.json) |
| [`coding-agent.architecture.html`](coding-agent.architecture.html) | pi 上游的分层:pi-ai / pi-agent-core / coding-agent 三层,7 个工具,skills 的渐进式披露 | [`.json`](coding-agent.architecture.json) |
| [`coding-agent.workflow.html`](coding-agent.workflow.html) | pi 的两层循环:内层转「工具 + steering」,外层等 followUp | [`.json`](coding-agent.workflow.json) |

HTML 是自包含的,双击就能开:带深色/浅色、平移缩放、搜索、聚焦、按视角分章。

## 这四张图是怎么来的

用 `~/.claude/skills/archify`(v2.17)从 JSON 规格渲染。**JSON 才是源**,HTML 是产物 ——
改图改 `.json`,别改 `.html`。

```sh
S=~/.claude/skills/archify
R=<仓库根>                                   # 架构图要它来核对 sources 里的行号

node $S/bin/archify.mjs validate architecture travel-agent.architecture.json --quality showcase --repo-root $R
node $S/bin/archify.mjs deliver  architecture travel-agent.architecture.json travel-agent.architecture.html --quality showcase --repo-root $R
node $S/bin/archify.mjs visual-check travel-agent.architecture.html          # 真浏览器里量一遍

# workflow 那两张不带 --repo-root(workflow 的 schema 没有 sources 字段)
node $S/bin/archify.mjs validate workflow travel-agent.workflow.json --quality showcase
```

三条命令回答的是**三个不同的问题**,不能互相替代:

| 命令 | 证明了什么 | 没证明什么 |
|---|---|---|
| `validate` | 9 项 artifact 检查过了(正交走线、标签留白、走廊不合并…) | 浏览器里长什么样 |
| `deliver` | 规格字节冻结成快照,报 SHA-256 | 同上 |
| `visual-check` | 1440/1600/1920/2048 四个视口都不溢出、字号投影 ≥ 6px | **好不好看** —— 那要人看 |

四张图当前状态:`validate` 各 9/9,`deliver` ok,`visual-check` 四个视口全过。
**「好看」这一项没有人工复核过**,只有上面这些机器证据。

## 两个踩过的坑,记下来省得再踩

**① 仓库根的 `.gitignore` 有一条 `pi-*.html`。** 图原来叫 `pi-coding-agent.*.html`,
`git add` 会**静默**把它们吃掉 —— 提交完看着一切正常,克隆下来少两张图。所以改名成
`coding-agent.*`。加新图的时候先跑一次 `git check-ignore -v docs/diagrams/*`。

**② 纵向溢出比横向难修。** `visual-check` 要求 1440×900 上整页不滚动,而页高 =
页头 + 图面板 + 卡片。实测最有效的三刀,按性价比排:

1. **卡片文字压到一行**(换行的一条要占两行的高)
2. **节点加宽** —— 内容更宽 → 面板放大倍数下降 → 面板变矮。pi 那张把节点从 150 加到 186,
   页高从 1309 掉到 954
3. **标题别太长** —— 页头折成两行正好是 30px,pi 那张最后 30px 就卡在这儿

反过来,把 `viewBox` 加宽去「留白」是**反效果**:缩放比跟着降,sublabel 投影字号掉到
6px 以下,`composition/desktop-readability` 直接红。
