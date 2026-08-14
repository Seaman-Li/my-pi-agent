# Provider 加载链路：models.json 是怎么生效的

> Day 3 的产出。目标是能不看笔记复述这条链路。
> 行号基于 `v0.84.1`。路径均相对仓库根 `/Users/simonli/Downloads/MyProjects/PiAgent/`。

跑这条命令时发生了什么：

```bash
./pi-test.sh --model dashscope/qwen3.7-plus -p "1+1等于几"
```

---

## 完整链路（九步）

| # | 位置 | 发生什么 |
|---|---|---|
| 1 | `pi-test.sh` 末行 | `tsx packages/coding-agent/src/cli.ts` |
| 2 | `packages/coding-agent/src/cli.ts:20` | 设进程标题、配置 HTTP dispatcher → `main(argv)` |
| 3 | `packages/coding-agent/src/main.ts:11` | `parseArgs()` 解析出 `--model` 和 `-p` |
| 4 | `packages/coding-agent/src/core/agent-session-services.ts:142` | **`ModelRuntime.create({ authPath, modelsPath })`** ← 配置的唯一入口 |
| 5 | `packages/coding-agent/src/core/model-runtime.ts:176` | `ModelConfig.load(modelsPath)` 读 JSON（实现在 `model-config.ts:245`） |
| 6 | `packages/coding-agent/src/core/model-runtime.ts:269 → 245` | `rebuildProviders()` → `recomposeProvider("dashscope")` |
| 7 | `packages/coding-agent/src/core/provider-composer.ts:420` | `composeModelProvider()` 纯配置构造出 Provider |
| 8 | `packages/coding-agent/src/core/model-runtime.ts:276` | `updateModelSnapshot()` 算 `all` / `available` |
| 9 | `packages/coding-agent/src/core/model-resolver.ts:371` | `resolveModelScope()` 把字符串 `"dashscope/qwen3.7-plus"` 匹配成 Model 对象 |

**第 4 步是关键**：`agentDir` 在这里确定（`config.ts:515` 的 `getAgentDir()`），`authPath` 和 `modelsPath` 都从它派生。改 `PI_AGENT_DIR` 环境变量就能整体换一套配置——`test.sh` 用 `env -i` 换 `HOME` 达到隔离，根子也在这一行。

```ts
// config.ts:515
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) return expandTildePath(envDir);
	return join(homedir(), CONFIG_DIR_NAME, "agent");   // 默认 ~/.pi/agent
}
```

---

## 核心：`recomposeProvider` 的三条分支

`model-runtime.ts:245-267`，**今天唯一必须读懂的 23 行**。

| 情况 | 行为 | 例子 |
|---|---|---|
| 有内置、无配置 | **直接用内置，原样不动** | `anthropic` |
| 有内置、有配置 | `composeModelProvider` 叠加覆盖 | 用 `modelOverrides` 时 |
| **无内置、有配置** | 纯配置构造 | **`dashscope`** |

第一条那句源码注释点破了用意：

```ts
// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
```

没有覆盖时**刻意绕开合成流程**，防止合成过程意外改变内置 provider 的认证/流式行为。防御性设计。

**失败降级**（同一函数的 `try/catch`）：

```ts
} catch (error) {
	this.compositionErrors.set(providerId, ...);
	if (base) this.models.setProvider(base);        // 有内置 → 退回内置
	else this.models.deleteProvider(providerId);     // 没有 → 删掉
}
```

所以 `models.json` 写错时**不会让 pi 崩溃**，只是那个 provider 不可用。配置写错了 `--list-models` 只是少一行，而不是报错退出。

---

## 一句话结论

> **`models.json` 不是另一套目录，而是同一个目录的一层覆盖。**

`ModelRuntime` 每次重建时把内置 provider 和你的配置合成，结果统一注册进 `this.models`，`--list-models` 读的就是它。

这也解释了文档里那句 "The file reloads each time you open `/model`"——重新 `load` + `rebuildProviders` 即可，不需要重启。

---

## 三个容易困惑的点

### ① 密钥不在启动时读取

配置里写的是：

```json
"apiKey": "!security find-generic-password -ws pi-dashscope"
```

这个 `!command` **不在上面九步的任何一步执行**，而是**每次发请求前**才跑。文档原话：*For `models.json`, shell commands are resolved at request time.*

启动阶段只是把字符串记下来。`--list-models` 显示"可用"靠的是**配置里有 `apiKey` 字段**，而不是真去执行了命令——这就是为什么启动 pi 时钥匙串不弹授权窗，要到发第一个请求才弹。

### ② 模型在目录里 ≠ 可用

`model-runtime.ts:281`：

```ts
available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider))
```

内置的 anthropic/openai 等都在 `all` 里，但没配凭证，进不了 `available`。文档里 "models load but stay unavailable in `/model`" 说的就是这个过滤。

### ③ `getModelsPath()` 是死函数

`config.ts:529` 定义了 `getModelsPath()`，但**全项目零调用**。`model-runtime.ts:175` 内联了同样的表达式 `join(getAgentDir(), "models.json")`。

按 `AGENTS.md` 那条 "Inline single-line helpers that have only one call site"，这个函数其实该删。**追链路时不要被它误导**——它不在路径上。

> 这是「符号存在 ≠ 实际被调用」的又一个实例，参见 [agent-factcheck.md](agent-factcheck.md)。第一版链路图里我把它写进去了，验证后才发现没有调用关系。

---

## `model-runtime.ts` 结构图（787 行，按需回查）

| 行段 | 段落 | 何时读 |
|---|---|---|
| 66–128 | 类型定义 | 扫一眼 |
| **131–152** | **字段声明（22 个）** | ⭐ 全类的状态清单 |
| 154–217 | 构造 + `create()` 工厂 | ⭐ |
| **219–283** | **provider 组装** | ⭐⭐ Day 3 核心 |
| 285–382 | 可用性刷新（异步、seq 防竞态） | 跳过 |
| 384–470 | 查询接口 | 扫一眼，都是一两行 |
| 472–571 | 认证与凭证管理 | 跳过 |
| 573–787 | 请求准备与流式调用 | **Day 4 再来** |

四个关键字段就能概括整个类：

```ts
private readonly models: MutableModels;      // 最终目录，setProvider 往这塞
private readonly builtins = new Map<...>();  // 内置 provider
private config: ModelConfig;                  // 你的 models.json
private snapshot: ModelRuntimeSnapshot;       // all / available 快照
```

**整个类做的事**：把 `builtins` 和 `config` 合成后塞进 `models`，再算出 `snapshot`。
