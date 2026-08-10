# pi 自荐的阅读路径（参考，非执行计划）

> **这份文档由 pi 自己生成**——直接问它"该怎么读你的源码"得到的回答。原文保留未改，作为参照物。
>
> **不要按这个顺序执行**，实际日程见 [../STUDY-SCHEDULE.md](../STUDY-SCHEDULE.md)。两者的分歧本身有信息量：
>
> pi 把 `extensions.md` 排第一，日程表把扩展机制放在 Day 12。日程表的理由是——不先理解 agent loop 和状态归约，扩展点就是一堆没有上下文的钩子名，记不住也用不上。pi 的排序更像"按功能重要性"，日程表的排序是"按认知依赖"。
>
> 哪个更好取决于目的：想快速上手写扩展，pi 的顺序更快；想搞懂架构，认知依赖的顺序更稳。你的目标是后者。

按优先级排列，理解 agent 工作原理的最佳路径。

## Timeline

### 1. `packages/coding-agent/docs/extensions.md`
**目标**: 理解扩展系统 = agent 的工具/命令/事件钩子机制
**关注点**:
- 扩展如何注册工具（tools）
- 扩展如何注册斜杠命令（commands）
- 事件钩子（hooks）有哪些，触发时机
- 扩展的生命周期

### 2. `packages/coding-agent/docs/session-format.md`
**目标**: 理解 JSONL 会话格式 + SessionManager API = agent 的状态管理
**关注点**:
- JSONL 条目类型有哪些
- 会话如何分支（branching）
- SessionManager API 的读写接口
- 会话如何支持恢复和回放

### 3. `packages/agent/src/agent-loop.ts`
**目标**: 代理循环的实际实现
**关注点**:
- 主循环结构（LLM 调用 → 工具执行 → 结果回传）
- 工具调用的编排逻辑
- 流式响应处理
- 错误处理和重试

### 4. `packages/coding-agent/docs/sdk.md`
**目标**: 理解编程接口，agent 如何被嵌入
**关注点**:
- SDK 暴露的 API 表面
- 如何以编程方式启动一个 agent session
- 与 RPC mode / JSON event stream mode 的关系
