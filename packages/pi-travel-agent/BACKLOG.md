# BACKLOG

冒出来但当次不做的事。每条写清「什么时候做」,否则它就是永远不做。

## loop 的失败路径没法确定性验收 —— Step 9

Step 2a 实测:想让模型故意用非法参数调工具触发 `execute` 抛错,**三种问法它都拒绝**
(它会读 schema 里的 description 自行拦截)。于是这三条路径目前只有代码,没有验收:

- 工具 `execute` 抛异常 → 包成 error 结果回灌
- 模型编了个不存在的工具名 → `没有名为 X 的工具`
- `max_steps` 触顶

它们都需要「不依赖模型配合」的手段。Step 9 的 `--replay` 正好提供这个:
喂一段固定的 assistant 消息进 loop,不发真请求。到那一步一起补。

## 参数校验 —— Step 3b

`loop.ts` 的 `executeToolCalls` 里,`toolCall.arguments` 目前未经校验直接透传给 `execute`。
Step 3b 补 `Value.Convert` → `Check`:模型经常把数字写成字符串,Convert 能救回来。
位置已经在代码里标好了。

## `--model` 之外的开关没有严格校验 —— 有需要再说

`parseArgs` 对不认识的 `--xxx` 不报错,会把它当成 prompt 的一部分吞掉。
开关多到会打错字的时候再收紧。
