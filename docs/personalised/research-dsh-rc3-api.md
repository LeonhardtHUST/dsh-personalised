# DSH 0.2.2-rc.3 相关 API 调研（自定义指令 / 模型调用 / 设置页 / 升级要点）

调研对象：本机安装版 DSH 0.2.2-rc.3（cordis 4.1.0），以及参考仓库 `ztl0001/dsh-custom-instructions` 与 `dsh-doc` 技能文档。只读调研，未改动安装目录、profile 与仓库代码。

## 0. 出处约定与取证方式

| 记号 | 实际路径 |
|---|---|
| `$AI` | `C:\Users\Leon\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai` |
| `$DOCS` | `$AI\dsh\docs` |
| `$SKILL` | `$AI\dsh-agent-preset\skills\dsh-doc`（`references/*.md`、`templates/decoration/*`） |
| `$REF` | GitHub `ztl0001/dsh-custom-instructions` 的 `main` 分支 |

安装版是 asar 归档，`glob`/`grep`/`ls` 看不到内部文件。以下事实用两种方式取证：Host 的文件读取工具按完整路径读 `src/*.ts`；目录列举与批量检索用 `ELECTRON_RUN_AS_NODE=1` 跑 `$env:DSH_NODE_EXECUTABLE`（`locate-docs.md:26-60` 授权的做法）。安装版 `$DOCS` 存在完整文档树，`docs/upgrade-guide/` 也在其中。

运行环境事实：`DSH_PROFILE=desktop`，`DSH_INSTALL_DIR=$AI\dsh`，`DSH_NODE_EXECUTABLE=...\DeepSeek Harness.exe`，`DSH_PROFILE_DIR=C:\Users\Leon\.dsh\profiles\desktop`。

## 1. 结论速查

| 需求 | rc3 的答案 | 出处 |
|---|---|---|
| 往系统提示词追加稳定段落 | `ctx.systemPrompt.section({name, order, text, interpolate})` | `$AI/dsh-system-prompt/src/index.ts:485` |
| 稳定排序锚点 | `ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')` = `0` | 同上 `:501`，`SECTION_ORDERS` 表 `:136-173` |
| 缓存友好写法 | 固定 `order` + 固定 `name` + `interpolate: false` + 文本不变；空文本段渲染时被丢弃 | 同上 `:297-302` |
| 按 agent / session 区分 | 在 `agent.ctx` 上注册同名 section，作用域覆盖全局 | `$SKILL/references/practices.md:19`，`$AI/dsh-system-prompt/src/index.ts:414-422` |
| 判断是否子代理 | `agent.session.header.origin === 'subagent'`、`.delegationDepth`、`.parentSession` | `$AI/dsh-session/src/types.ts:105-135`，属性声明 `$AI/dsh-session/src/index.ts:574` |
| 取当前会话 cwd | `ctx.workingDirectory.get(session)`；创建时目录在 `session.header.cwd` | `$AI/dsh-working-directory/src/index.ts:141`，`$AI/dsh-session/src/types.ts:106` |
| 列 provider / model | `ctx.llm.listProviders()`、`await ctx.llm.listModels(p)`、`await ctx.llm.resolveModelInfo(p, m)` | `$AI/dsh-llm/src/index.ts:498,733,775` |
| 发一次补全 | `ctx.llm.prepareCall({provider,model,maxTokens}, signal)` → `call.stream(opts)` → `BlockAssembler` | `$AI/dsh-llm/src/index.ts:975,206,1185` |
| 前端选模型 | `ctx.remote.session.modelCatalog()`（`{groups:[{id, models:[…]}]}`） | `$AI/dsh-client-ui-model-selection/src/client/catalog.ts:56` |
| 设置字段声明 | schemastery `z.object({...})` + `.volatile()`，需要设置页可编辑的字段必须 volatile | `$AI/dsh-settings/README.md:33`，`$SKILL/references/configuration.md:12` |
| 前端设置页 slot | `settings.section`（list, root scope），选项 `id`/`order`/`label` | `$AI/dsh-client-ui-settings/src/client/contract/slots.ts:57,134` |
| 前端读写设置 | `ctx.configForms.get(entryId)` → `set`/`unset`/`mutate` | `$AI/dsh-client-ui-settings/src/client/config-form-types.ts:36-74` |
| 客户端包依赖 | 不得 `require('@deepseek-ai/dsh-client-ui-primitives')` 等 Harness Client 包 | `$SKILL/references/practices.md:35` |

## 2. A. 向系统提示词追加一个稳定的自定义指令段落

### 2.1 服务与注册方法

服务名 `systemPrompt`，类 `SystemPrompt extends Service`（`$AI/dsh-system-prompt/src/index.ts:436,453`）。插件在 `inject` 里声明 `systemPrompt` 即可使用（参考仓库 `$REF/lib/index.js` 的 `export const inject = ['systemPrompt']`）。

注册段落的签名（`$AI/dsh-system-prompt/src/index.ts:485-494`）：

```ts
section(section: PromptSection): () => void
```

`PromptSection` 字段（同文件 `:53-76`）：

```ts
interface PromptSection {
  readonly name: string                                    // 同层重复注册直接抛错
  readonly order: number                                   // 升序拼接；相等时按 name 的 code-unit 顺序
  readonly text: string | ((context: AssembleContext) => string)
  readonly interpolate?: boolean                           // 默认 true；false 保留 {{…}} 字面量
  readonly complete?: boolean                              // 声明自己是完整提示词；同时只能有一个
}
```

相邻 API（同文件）：`context(PromptContext)` 注册动态运行时上下文（`:520`）、`variable(name, provider)` 注册 `{{var}}`（`:568`）、`getContextOrder(name)`（`:510`）、`suppressRuntimeContext()`（`:537`）、`refreshContext()`（`:589`）、`assemble()`（`:621`）、`tools(provider)`（`:552`）。段落渲染函数 `renderPrompt(assembly)` 导出于 `:297`。

事件（同文件 `:24-38`）：`system-prompt/assemble`（waterfall，改写整个装配）与 `system-prompt/change`（emit，任何注册变化）。

### 2.2 排序表与缓存稳定性

`SECTION_ORDERS`（`$AI/dsh-system-prompt/src/index.ts:136-173`）是仓库自用位置表，关键值：

| 位置 | 值 |
|---|---|
| `HARNESS_IDENTITY` | -1000 |
| `DEPLOYMENT_PERSONA_PREFIX` | 0 |
| `PLAN_POLICY` / `TEAM_POLICY` | 500 / 600 |
| `FILE_REFERENCE` / `TOOL_BASH` / `TOOL_READ` / `TOOL_WRITE` | 900 / 1000 / 1100 / 1200 |
| `TOOLS_SDK` | 5000 |
| `DELIVERABLE_FILE_REFERENCES` / `STRUCTURED_OUTPUT` | 9000 / 9900 |
| `HARNESS_SOURCE` / `WEB_SURFACE` / `DEPLOYMENT_PERSONA_SUFFIX` | 10000 / 10100 / 10200 |

第三方段落可以取任意有限数值（`$AI/dsh-system-prompt/README.md:56`）。参考仓库选 `order: 100`，理由写在 `$REF/lib/config.js` 的 `SECTION_ORDER` 注释里：紧跟人格前缀（0），排在所有策略段和工具段（500+）之前。

缓存稳定性的可查结论：

- 段落按 `order` 升序、同值按 `name` 排序后拼接，空文本段被过滤（`$AI/dsh-system-prompt/src/index.ts:659,297-302`）。只要一次注册之后文本、顺序不变，渲染结果字节稳定。
- 渲染结果不变时，agent loop 不动 system 节点，前缀缓存可复用；变了就从第一个变化 token 开始失效（`$AI/dsh-system-prompt/README.md:156`）。
- `interpolate: false` 让 `{{` / `}}` 保持字面量；否则严格插值模式会替换变量，遇到未知变量直接抛错（`$AI/dsh-system-prompt/README.md:112`，`src/index.ts:290-293`）。
- 段落文本是同步函数，不能 `await`。需要异步加载的数据要么在注册前就绪，要么改走 `systemPrompt.context()` 并在 `agent/pre-step` 里刷新（本仓库 `lib/index.js:17437-17440,17549` 的注释已经踩过这个坑）。
- 注册与释放都会触发 `system-prompt/change`（`src/index.ts:446-449`）。

推荐形状（固定 name、固定 order、按需返回空串）：

```js
const SECTION_NAME = 'auto-memory:static-rules'
export const inject = ['systemPrompt']

export function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: 100,                 // 人格前缀之后、策略段之前
    interpolate: false,         // 指令是散文，可能带 {{ }}
    text: () => renderStaticRules(config),   // 空串 => 渲染时整段消失
  }), 'auto-memory:static-rules')
}
```

`renderStaticRules` 返回 `''` 就是"关闭注入"的干净实现，因为 `renderPrompt` 会过滤空段（`src/index.ts:300`）。

### 2.3 能否按 session / agent / subagent 区分

三种粒度都有原生支持：

1. 全局：在插件自己的 context 上 `ctx.systemPrompt.section(...)`，所有 agent 都看到。
2. 单 agent（= 单会话，因为每个会话由一个 agent 驱动）：在 `agent/created` 监听器里拿 `agent`，改在 `agent.ctx` 上注册。作用域内同名 section 覆盖全局（`$AI/dsh-system-prompt/README.md:114`，`src/index.ts:626-639`）。`agent/created` 的 payload 是 `{ agent, source, signal }`（`$AI/dsh-agent/src/runtime-types.ts:291`）。注册要包在 `agent.ctx.effect()` 里，并把 disposer 同时存在插件自己的 effect 中，插件卸载时才会一起清掉（`$SKILL/references/practices.md:19`）。
3. 段内分支（最省事）：`text(context)` 的入参里 `context.agent` 是该次装配对应的 Agent，`context.scope` 与之相同（`$AI/dsh-agent/src/runtime-types.ts:18-25`，注入点 `$AI/dsh-agent/src/dispatch.ts:174`）。据此可以在一个全局 section 里按会话返回不同文本或空串。

子代理判定用会话头部，不要只看 `parentSession`（`$AI/dsh-session/src/types.ts:105-135`）：

```ts
const h = agent.session.header     // readonly 属性，不是方法（$AI/dsh-session/src/index.ts:574）
h.origin === 'subagent'        // 产品级分类，普通 fork 不会置这个值
h.delegationDepth              // 缺省=顶层，子代理=父深度+1
h.parentSession                // 直接创建者；普通 fork 可能历史残留，单独不可判类型
```

运行时树关系在 `ctx.subagents`（`SubagentRuntime`，`$AI/dsh-subagent/src/index.ts:194,210`）：`rootOf(agent)`（`:300`）把本地子代理解析到根 agent，`namesOf(agent)`（`:312`）给出成员名（根固定 `lead`）。要"只在根会话注入、子代理不注入"，最直接的写法：

```ts
text: (context) => {
  const agent = context.agent
  if (agent === undefined) return ''                      // 诊断装配，不注入
  if (agent.session.header.origin === 'subagent') return ''
  return renderInstructions()
}
```

### 2.4 取当前会话的 workspace / cwd

- 当前目录：`ctx.workingDirectory.get(session): string`（`$AI/dsh-working-directory/src/index.ts:141`）。这是"有效目录"，会随 `set()` 变化，且存活于 Session projection 里，冷读也行（`$AI/dsh-working-directory/README.md:44`）。服务 `inject: ['fs','sessionProjections','systemPrompt']`（`src/index.ts:77`），插件要用它需在 `inject` 里声明 `workingDirectory`。
- 创建时目录：`session.header.cwd`（属性，`$AI/dsh-session/src/index.ts:574`；字段定义 `$AI/dsh-session/src/types.ts:106`）。
- workspace：`ctx.workspaceRegistry.get(id)` / `list()`（`$AI/dsh-workspace/src/index.ts:186,298,308`）。注意工作目录变了但 workspace 头不变，`README.md:44` 明确写了"header continues to identify the original project"。
- 段落里的 cwd 变量：`{{cwd}}` 不是内建变量，agent loop 不注册它，写了会导致装配失败（`$AI/dsh-system-prompt/README.md:80`）。目录文本由 working-directory 服务以 user-role 上下文形式提供（`context: 'WORKING_DIRECTORY'`，order 100，`src/index.ts:179`）。

### 2.5 不要用的两条路

- 不要监听 `system-prompt/assemble` 去加文本或改工具。`practices.md:17` 明确禁止；工具声明已归 provider 所有，waterfall 不接收工具数组（`$AI/dsh-system-prompt/README.md:112`）。
- 不要用 `agent/request` 改消息。该事件在 rc3 标记为 deprecated，只为老监听器保留（`$AI/dsh-agent/README.md:78`）。往历史里加内容用 `agent.inject()`（`practices.md:18`）。

## 3. B. 用用户选定的模型做一次非流式补全

rc3 没有独立的 `complete()`。`ctx.llm` 只有流式入口，非流式就是把流抽干后用 `BlockAssembler` 取块。

### 3.1 枚举可用 provider 与 model

```ts
ctx.llm.listProviders(): LlmProviderInfo[]                       // $AI/dsh-llm/src/index.ts:498
await ctx.llm.listModels(provider: string): LlmModelInfo[]       // :733（校验 provider/id/name、去重）
await ctx.llm.resolveModelInfo(provider, model, signal?): LlmResolvedModelInfo   // :775
ctx.llm.listConfigurableProviders()                              // :570（配置页用，含 settingsNs/baseURLEnv/nativeAuth）
```

`LlmModelInfo` 在 `$AI/dsh-llm/src/types.ts:369`，`LlmModelContext`（contextWindow）在 `:388`。GUI 侧选择要求模型必须在适配器目录里（`README.md:28`），Host 侧路由则接受未列出的 id。

前端对应的 Remote：`remote.llm` 命名空间确实存在（`$AI/dsh-client-ui-settings-models/src/client/index.ts:68` 的 inject 列表含 `'remote.llm'`），`@Remote` 标注的方法有 `listProviders`、`listConfigurableProviders`、`discoverModels`（`src/index.ts:497,569,657`）。会话级模型目录走 `ctx.remote.session.modelCatalog()`，返回 `ModelCatalog`（`{groups:[{id, models:[{id, reasoning, …}]}]}`，`$AI/dsh-client-ui-model-selection/src/client/catalog.ts:56-68`），这是内置选择器的数据源。

### 3.2 发起一次请求（标准范式）

完整可参照的官方实现是会话标题生成：`$AI/dsh-session-title-llm/src/index.ts:236-291`。要点：

```ts
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'

const messages = [createUserMessage({
  content: [{ type: 'text', text: prompt }],
  source: { kind: 'auto-memory' },        // MessageSourceMap 需自行 augment（见 :19-23 同文件写法）
})]

const call = await ctx.llm.prepareCall({ provider, model, maxTokens }, signal)
const options = {
  ...call.config,
  messages,
  system: systemText,                     // 一次性调用者的系统提示词槽位（types.ts:581）
  purpose: 'auto-memory-reflect',         // 声明用途，见 3.3
  signal,
}
const assembler = new BlockAssembler()
for await (const chunk of call.stream(options)) assembler.push(chunk)
const blocks = assembler.blocks()          // ContentBlock[]
const finish = assembler.finish            // FinishReason
```

- `prepareCall(config, signal, configure?)` 冻结路由、补齐适配器默认值、校验推理强度，返回 `PreparedLlmCall`（方法 `$AI/dsh-llm/src/index.ts:975-979`，返回类型 `:184-207`）。`PreparedLlmCall.stream(options)` 一次性派发，`options` 里的 call-config 字段必须与 `config` 一致，否则 `INVALID_PREPARED_CALL`。
- 也可以直接用 `ctx.llm.stream(options)`（`:1185`），由自己填齐 `provider`/`model`/`messages`。省掉 `prepareCall` 就省掉了默认值补齐与前置校验。
- `GenerateOptions` 全字段见 `$AI/dsh-llm/src/types.ts:564-606`：`provider`、`model`、`messages`、`system?`、`tools?`、`toolHistory?`、`temperature?`、`maxTokens?`、`stop?`、`signal?`、`sessionId?`、`purpose?`、`reasoningEffort?`。
- 终止块：`finish.reason` 为 `{kind:'error',failure}` 或 `{kind:'aborted',failure}` 时要把错误抛出去；`stop`/`max-tokens`/`tool-calls` 是正常终止（`$AI/dsh-session-title-llm/src/index.ts:204-219`）。
- 失败码走 `failure.code`，如 `NO_ADAPTER`、`MISSING_CREDENTIAL`、`AUTH`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`，`LLM_FAILURE_CODES` 是全集；`new LlmError` 只接受内建码或 `HTTP_<status>`（`$AI/dsh-llm/README.md:95`）。
- 本服务不重试。重试在 `dsh-llm-retry`，挂在 agent 失败步骤的扩展点（同上 `:95,178`）。

### 3.3 声明请求用途（rc3 必需）

`LlmRequestPurposeMap` 是空接口，由产出方用模块增强补上自己的键（`$AI/dsh-llm/src/types.ts:555`，`README.md:61`）：

```ts
declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'auto-memory-reflect': true
  }
}
```

不声明而传 `purpose` 只是类型层报错，运行期适配器会当未知用途处理；但升级指南把"用途由生产方声明"列为破坏性变更（`$DOCS/upgrade-guide/v0.2.2-alpha.2/llm-request-purpose-declarations/guide.md`），照做即可。

### 3.4 取"用户选择的模型"

| 场景 | 读法 | 出处 |
|---|---|---|
| 有 agent 句柄 | `agent.model.current()` → `{provider, model, reasoningEffort?} \| undefined` | `$AI/dsh-agent/src/model-selection.ts:105`，`README.md:45-50` |
| 段落装配里 | `context.modelSelection`（本步固定值） | `$AI/dsh-agent/src/runtime-types.ts:22` |
| 只要上次实际请求 | `session.requestHeader()?.config` | `$AI/dsh-agent/src/model-selection.ts:165` |
| 会话投影 | `modelSelection` 投影的 `lastUsed` / `pending` | `$AI/dsh-agent/src/model-selection.ts:72-90` |

`agent.model.current()` 的优先级是"待生效选择 → 上次请求 → `agent.options`"。只读它不会钉住选择，也不会影响已准备的步骤（`$AI/dsh-agent/README.md:48`）。

### 3.5 前端让用户选模型

两条路，按控制力度选：

1. 复用会话模型目录：`ctx.remote.session.modelCatalog()` 拿 `groups`，自己渲染下拉；把 `{provider, model}` 写进插件设置。注入 `remote`、`remote.session`（`$AI/dsh-client-ui-settings-models/src/client/index.ts:68`）。
2. 让用户直接填两个字符串：设置页给两个文本框（或一个 `provider/model` 组合框），Host 侧用 `await ctx.llm.resolveModelInfo(provider, model)` 校验存在，失败就把错误回显。这条实现最简单，也避开了目录缓存与 `llm/models-updated` 的失效处理（`$AI/dsh-llm/src/types.ts:26`）。

前端不需要、也不能 `require` 内置模型选择组件（`$SKILL/references/practices.md:35`），自绘下拉即可，配色只用 `--dsw-alias-*` token。

## 4. C. 设置页：schema、slot、locale

### 4.1 Config schema（schemastery）

Host 半用 `@deepseek-ai/schemastery` 的默认导出（`import z from '@deepseek-ai/schemastery'`，见 `$AI/dsh-system-prompt/src/index.ts:437`）。可用链式方法（`$AI/schemastery/src/index.ts:165-179`）：`volatile()`、`role(text, extra?)`、`default(value)`、`comment(text)`、`description(text)`。

字段类型写法：

```js
export const Config = z.object({
  enabled:      z.boolean().default(true).volatile(),
  instructions: z.string().default('').volatile(),
  style:        z.union(['concise', 'detailed']).default('concise').volatile(),
  maxEntries:   z.number().step(1).min(1).max(200).default(20).volatile(),
})
```

- 布尔：`z.boolean().default(x)`。
- 枚举/下拉：`z.union(['a','b'] as const).default('a')`，仓库内实例见 `$AI/dsh-experimental-translator/src/index.ts:55`、`$AI/dsh-llm-deepseek/src/config.ts:94`。
- 多行文本：rc3 的 schema 层没有 textarea 角色，`z.string()` 在通用表单里对应单行输入。多行是前端控件的事：自己画 `<textarea>`，值仍然存在 `z.string()` 字段里。参考仓库正是这么做的（`$REF/client/client.js` 顶部注释"the primitive value field is a one-line `<input>`, and a system prompt is prose"）。
- 敏感值：`z.string().role('secret')`，设置投影会把 secret 从值与默认值里抹掉，只留"已设置"标记（`$AI/dsh-settings/src/schema.ts:23`，`$AI/dsh-settings/README.md:49`）。

`volatile()` 是设置页可编辑的前提：设置服务只把活动条目的 volatile 字段投影成表单（`$AI/dsh-settings/README.md:33`）。volatile 字段在运行期是引用对象，读值要用 `.get()`（`$SKILL/references/configuration.md:12`；参考仓库 `$REF/lib/config.js` 的 `isVolatileReference`/`readConfigValue` 用 `Symbol.for('cosmokit.volatile.write')` 判定）。安装版对应实现是 `isVolatile(value)`（`$AI/dsh-settings/src/schema.ts:4-11`）。

`Config` 字段的权威清单在 `$DOCS/config-catalog.md`（按包名分节）。

### 4.2 持久化路径

- 设置服务写：`ctx.settings.update(ns, patch, expectedRevision?)`、`replace`、`mutate(ns, ops, expectedRevision?)`（`$DOCS/subsystems/settings.md:56-70`）。`ns` 是 profile 里该条目的局部 id，也就是 `cordis.patch.yml` 中 `- id:` 的值。
- 插件自己写配置：走 config-editor，不要手改 profile 补丁文件（`$SKILL/references/configuration.md:3-10`）：

```js
const entry = ctx.fiber.entry
const editor = ctx.get('configEditor')
await editor.edit(entry, current => ({ ...current, field: value }))
```

- 普通（非 volatile）字段改动会重启插件，`apply` 重建状态；volatile 字段原地生效（同上 `:12`）。

### 4.3 前端设置面板

slot 契约在 `$AI/dsh-client-ui-settings/src/client/contract/slots.ts`：

| slot | kind / scope | 用途 | 行号 |
|---|---|---|---|
| `settings.section` | list / root | 设置页的一个独立导航项 | `:57` |
| `settings.section.icon` | list / root, inline | 与 section 同 `id` 的导航图标 | `:65` |
| `settings.general.item` | list / root | General 页里的一行偏好，不占一整页 | `:100` |
| `settings.plugins.tab` | list / root | 「插件」页里的一个标签 | `:74` |

`settings.section` 的 owner props 只有一个 `close()`（`:134-137`）；`settings.section.icon` 收到 `{size, active}`（`:140-145`）。注册选项由注册方自带：`id`（导航键）、`order`（位置）、`label`（本地化函数）。官方页示例（`$AI/dsh-client-ui-agent-preset/src/client/index.ts:283-290`）：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'agent-presets',
  order: 20,
  label: () => ctx.locale.bind('settings.agentPreset')('nav'),
  locale: 'settings.agentPreset',
  inject: sectionInjected,     // 注入给组件的 props
}, AgentPresetSection))
```

`ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` 是标准形态：obiter 的声明塌陷时注册被释放，回来时重装（`$SKILL/references/practices.md:36`）。

读写设置的客户端服务是 `ctx.configForms`（`$AI/dsh-client-ui-settings/src/client/config-form-types.ts`）：

```ts
ctx.configForms.get(entryId): ConfigForm<T>
  getSnapshot(): { status:'loading'|'ready'|'unavailable', value, base, user, revision, writable }
  subscribe(listener): () => void
  set(field, value): Promise<boolean>
  unset(field): Promise<boolean>        // 清掉覆盖，回到组合层默认值
  mutate(ops, expectedRevision?): Promise<boolean>
```

`user` 层"字段是否存在"才是"已被用户覆盖"的判据，值相等也算覆盖（`:21-26`）。写入被拒时会重新拉 Host 状态；`writable` 是唯一权威（`$AI/dsh-client-ui-settings/README.md:36`）。另有 `ctx.configForms.whileServed(namespaces, register)`，用于"宿主没挂这个命名空间时不显示页面"（同上 `:40`）。

rc3 现状：`autoGenerate` 默认为真，但"尚未有内置客户端按 schema 自动生成页面"（`$AI/dsh-settings/README.md:39`）。所以设置页仍要自己写；宿主侧可以调用 `configure({ auto: false }, ctx.fiber)` 声明"这个实例不用自动页"（`$AI/dsh-client-ui-settings/src/index.ts:24`）。

### 4.4 locale

- 客户端字典：`ctx.locale.register(ns, { en, zh, ja, … })`，`ctx.locale.bind(ns)` 得到 `t`；命名空间要合并进 `LocaleNamespaceMap`，基线语言（en 与 zh）必须完整（`$AI/dsh-client-locale/README.md:40-42`）。注册要在 `ctx.effect` 里，返回 disposer。
- 注册到 slot 时给 `locale: 'xxx'` 选项，框架会把 `t` 作为 prop 注入组件（上面 agent-preset 的写法，以及参考仓库 `$REF/client/client.js` 里的 `locale: LOCALE_NS` 与 `props.t`）。
- 包级展示文案：`locale/en.json`、`locale/zh.json` 里 `meta.title`、`meta.description`，可选 `meta.detail` 指向单图详情文档（`$SKILL/references/host-plugin.md:33-43`，`$SKILL/references/plugin-details.md:8-11`）。`package.json` 需导出 `./locale/*.json` 与 `./icon`，并把它们列进 `files`。
- 新增语言包才用 `ctx.locale.addLanguage({id,label,fallback:'en'})`；普通插件注册字典就够。内置语言 id 与第三方语言包同 id 会冲突（`$DOCS/upgrade-guide/v0.2.1-rc.2/built-in-japanese/guide.md`）。

## 5. D. rc3 升级要点

### 5.1 manifest（`package.json`）

权威类型在 `$AI/dsh-package-manifest/src/types.ts`：

| 字段 | 是否必需 | 说明 | 行号 |
|---|---|---|---|
| `name` / `version` | 必需 | 包身份 | `:10-12` |
| `icon` | 可选 | 包根相对路径，SVG/PNG/JPEG/WebP，≤256 KiB，realpath 后必须仍在包内；优先于 `./icon` 导出 | `:15`，`$SKILL/references/host-plugin.md:52` |
| `engines.node` | 建议 | rc3 要求 Node ≥ 24.9，不再支持 22 | `$DOCS/upgrade-guide/v0.2.1-rc.2/node-24/guide.md` |
| `engines.dsh` | 可选但推荐 | 写了自己的 `engines.dsh`，DSH 就只看它，忽略 `@deepseek-ai/dsh*` peer 范围；`workspace:` 值在此非法 | `:61`，`v0.2.1-alpha.3/plugin-engines-dsh/guide.md` |
| `dsh.manifestVersion` | 可选 | 目前只允许 `1`，读取方不强制 | `:34`，`$AI/dsh-package-manifest/README.md:50-55` |
| `dsh.bundle.patch` | bundle 必需 | 一个路径或按序应用的数组，相对包根 | `:75` |
| `dsh.bundle.platforms` | 可选 | 如 `["win32"]`，缺省不限平台 | `:73` |
| `dsh.bundle.listedByDefault` | 可选 | 默认 true | `:77` |
| `dsh.client.platform` | client 必需 | 当前只有 `'web'` 被消费 | `:89` |
| `dsh.client.inject` | 可选 | 注释原文是 "Informational package-name dependencies, not Cordis service injection"；参与工厂到达顺序与主客端组合边，不提供服务注入 | `:91`，`$DOCS/subsystems/client-modules.md:17-33` |
| `dsh.client.immediately` | 可选 | stage-one 注册屏障 | `:93` |
| `dsh.client.external` | 可选 | 超出 client baseline 的精确模块请求，含 `<pkg>/client` 子路径 | `:99` |

`dsh.client.inject` 里的包名在 rc3 未必存在：安装版 `$AI` 目录里没有 `dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-runtime` 这三个包（它们是源码仓库里的包，安装版把它们打进 renderer）。该字段只是信息性排序提示，写不存在的名字不会让页面多出能力，也不会让 `require()` 成功。客户端只用基线模块（React 等）就能工作，见 `$SKILL/templates/decoration/client.js`。

client 产物形态（`$SKILL/templates/decoration/client.js:1-22`，`$DOCS/subsystems/client-modules.md:94`）：

```js
window.__ModuleLoader__.load({
  id: '<package name>',
  factory(require) { const React = require('react'); return { inject: ['slots'], apply(ctx) {} } },
})
```

包还必须导出 `./client`（`package.json.exports`），`dsh.client` 才会被扫进 boot 图。

### 5.2 `cordis.patch.yml`

`insert: [rows]` 追加行；行有 `id`、`name`（包说明符）、可选 `config`、可选 `disabled`/`inject`/`intercept`/`isolate`；带 `id` 不带 `insert` 的补丁改写同 id 行，`config` 是整体替换而非深合并（`$SKILL/references/composition-reference.md:7-19`）。参考仓库的最小 patch 只有一条与包同名的 `insert`（`$REF/cordis.patch.yml`）。`id` 同时是设置表单的命名空间，改 id 会让前端页签读到空数据。

### 5.3 与本插件相关的破坏性变更（从 rc2 之前升到 rc3）

按升级指南目录逐条对照（`$DOCS/upgrade-guide/README.md` 是索引，`v<T>/` 目录描述"从 vT 升到下一个版本"）：

| 变更 | 对我们的影响 | guide |
|---|---|---|
| `system-prompt/assemble` 不再携带工具声明，工具只能来自 step 准入注册 | 若曾在 waterfall 里补工具，必须改成 `ctx.systemPrompt.tools()` 或 tools 注册 | `v0.2.1-rc.2/conditional-tools/guide.md` |
| `AgentOptions.parentAgent` → `ownerAgent` | 创建/恢复 agent 的旧参数失效 | `v0.2.1-rc.2/agent-runtime-owner/guide.md` |
| subagent 服务删掉 `drainChildren`/`listChildren`/`list` | 子代理清点改用 `listDescendants(rootSessionId)` / `namesOf` | `v0.2.1-rc.2/subagent-service-methods/guide.md` |
| 辅助 LLM 请求用途改由生产方声明 | 见 3.3 | `v0.2.2-alpha.2/llm-request-purpose-declarations/guide.md` |
| `new LlmError` 只收内建码，其它用 `LlmError.fromFailure` | 自定义错误码要改 | `v0.2.2-alpha.2/llm-error-builtin-codes/guide.md` |
| 模型目录首次使用后自动刷新，自定义缓存持有者要提供实时配置与变更通知 | 前端模型列表不要自己永久缓存 | `v0.2.1-rc.4/model-listing-refresh/guide.md` |
| 会话模型选择在步骤准备时固定，投影类型移到所属包 | 读模型别在 step 中途改 | `v0.2.1-alpha.4/session-model-selection/guide.md` |
| 运行时上下文日志文本加 reminder 包装，清空快照写空标记 | 解析 context 日志文本的代码会受影响 | `v0.2.2-rc.1/runtime-context-reminders/guide.md` |
| Node 24.9+ | `engines.node` 要更新 | `v0.2.1-rc.2/node-24/guide.md` |
| 内置语言 id 与第三方语言包冲突 | 自定义语言包不能复用 `ja` 等内置 id | `v0.2.1-rc.2/built-in-japanese/guide.md` |
| `settings.yaml` 一次性导入（旧版用户设置迁移） | 自定义存储若叫 `settings.yaml` 会被改名 | `$AI/dsh-settings/README.md:35` |

`engines.dsh` 的取值范围按目标版本写，例如 `">=0.2.2-rc.3 <0.3.0-0"`。参考仓库写的是 `">=0.1.0-rc.7 <0.3.0-0"`（`$REF/package.json`），它覆盖 rc3。

### 5.4 参考仓库的现状与 rc3 的差距

`ztl0001/dsh-custom-instructions` 的 Host 半在本机 rc3 上仍可用，前端半需要改：

| 位置 | 事实 | 后果 |
|---|---|---|
| `$REF/lib/index.js` | `inject = ['systemPrompt']`，`apply` 里 `ctx.systemPrompt.section({name:'custom-instructions', order:100, interpolate:false, text:()=>…})` | 与 §2 一致，可直接照抄 |
| `$REF/lib/config.js` | 三个字段全 `.volatile()`，读值走 `value.get()` | rc3 的 volatile 契约一致 |
| `$REF/client/client.js` | `require('@deepseek-ai/dsh-client-ui-primitives')` 取 `SettingsForm`/`SettingsFormModel`/`Switch`/`Tag`/`settingsTextField` | rc3 禁止 require 该包（`practices.md:35`），安装版也没有这个包；照抄会在 rc3 抛错并让 slot 条目崩溃 |
| `$REF/package.json` | `dsh.client.inject` 列了 `@deepseek-ai/dsh-client-ui-slots` | rc3 无此包；该字段只是信息性提示 |
| `$REF/package.json` | 缺 `dsh.manifestVersion`、`engines.dsh` | 可选字段，建议补 |

要在 rc3 复刻同款设置页，把 `SettingsForm` 那套换成自绘：一个受控 `<textarea>`、两个自绘开关（`role="switch"` + `aria-checked`）、一个保存按钮，写入走 `ctx.configForms.get(ns).set('instructions', text)`，覆盖标记读 snapshot 的 `user` 字段。

## 6. 本仓库现状与可执行差距

本仓库 `@a9i5k4/dsh-auto-memory` v3.3.17 已经在用正确通道：静态纪律走 `systemPrompt.section()`，动态内容走 `systemPrompt.context()`（`lib/index.js:18293-18304`，`lib/client.js:2482`），注入面声明 `inject = ['webServer','tools','systemPrompt','subagents','llm']`（`lib/index.js:335`），设置页注册为 `settings.section` 的 `auto-memory-pre`（`lib/client.js:19586-19587`）。

按 rc3 要求逐项对照：

| 项 | 现状 | 建议 |
|---|---|---|
| `engines.node` | `">=22.18.0"`（`package.json:6-8`） | 改 `">=24.9.0"`（rc3 要求） |
| `engines.dsh` | 缺 | 加 `">=0.2.2-rc.3 <0.3.0-0"` |
| `dsh.manifestVersion` | 缺 | 加 `1` |
| `dsh.client.inject` | 含 `dsh-client-ui-slots`、`dsh-client-runtime`（`package.json:43-53`），rc3 无此包 | 只保留真实存在的包名，或直接删除该字段 |
| `locale/*.json` | 有 `meta.title`/`meta.description`，无 `meta.detail` | 若加详情页需同时加 `docs/` 并写进 `files`（`files` 现在没有 `docs`） |
| 详情文档 | 未声明 | 可选；声明就必须存在，缺失会显示错误而不是回退 README（`$SKILL/references/host-plugin.md:34`） |
| 模型调用能力 | `inject` 已含 `llm`，但 `lib/` 里没有 `ctx.llm.` 调用点 | 按 §3.2 实现，并补 `LlmRequestPurposeMap` 声明 |

## 7. 附录：任务点名包的实况

| 包 | 它在 rc3 里是什么 | 对本功能是否可用 |
|---|---|---|
| `dsh-system-prompt` | 提示词注册表与装配管线，`ctx.systemPrompt` | 主通道，见 §2 |
| `dsh-agent-instructions` | 加载 `$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md` 和项目 `AGENTS.md`/`CLAUDE.md` 链，在会话首个 `agent/pre-step` 以 user-role `<system-reminder>` 消息注入（`$AI/dsh-agent-instructions/README.md:34,60-62,105`） | 不是系统提示词段落。适合"按工作区文件"的指令；想让一段全局文本进入 system prompt 且不随工作区变化，用 `section()` |
| `dsh-persona` | 只有一条行的插件：把 `deployment:persona-prefix` / `deployment:persona-suffix` 段注册到**当前 scope**，用于 agent preset 覆盖人格；挂全局会撞上注册表自己的同名段而报错（`$AI/dsh-persona/src/index.ts:1-13,62-74`） | 不能当"通用追加段落"用；要做 per-agent 人格覆盖才用它 |
| `dsh-agent` | `ctx.agents`、`Agent` 句柄（`agent.ctx` / `agent.model` / `agent.session` / `agent.status`）、`agent/*` 事件（`$AI/dsh-agent/README.md:28-80`，事件签名 `src/runtime-types.ts:291-351`） | 需要按会话注册或读模型选择时用，见 §2.3、§3.4 |
| `dsh-llm` | `ctx.llm`（`LlmRuntime`）：适配器注册、目录、模型解析、`prepareCall`、`stream`（`$AI/dsh-llm/src/index.ts:369-1187`） | 见 §3 |
| `dsh-settings` / `dsh-client-ui-settings` | Host 设置表单投影与写回（`ctx.settings`）；客户端 `ctx.configForms`、`ctx.settingsSchema` 与全部 settings slot 契约（`$DOCS/subsystems/settings.md:27-71`，`$AI/dsh-client-ui-settings/src/client/contract/slots.ts:14-101`） | 见 §4 |
| `dsh-workspace` | `ctx.workspaceRegistry`：workspace 的创建、排序、归档、会话置顶（`$AI/dsh-workspace/src/index.ts:186-477`） | 要"工作区级"配置才用；取路径用 `dsh-working-directory` |
| `dsh-working-directory` | `ctx.workingDirectory.get/ensure/set`，目录作为 required 上下文参与装配（`$AI/dsh-working-directory/src/index.ts:141,154,188`） | 取当前 cwd 的唯一正路，见 §2.4 |
| `dsh-personalized-recommendations` | 纯组合 bundle，`src/index.ts` 只有 `export {}`，运行时行全在 `cordis.patch.yml`；它把 6 个推荐/卡片行打包成实验性功能（`$AI/dsh-personalized-recommendations/src/index.ts`、`README.md:1-30`） | 没有可调 API，与本功能无关 |

## 8. 未验证与限制

- 没有 `cordis_inspect_*` 工具，因此没有做运行时注册核对（slot 实际条目、Service 实例方法）。结论全部来自安装版源码与文档。
- 安装版没有独立的 `dsh-client-ui-primitives` / `dsh-client-ui-slots` 包目录；它们在源码仓库中存在（`$DOCS/config-catalog.md:5239-5240`），安装版是否把同名模块挂进浏览器模块表未做实测。按 `practices.md:35`，实现时不应依赖这一点。
- `remote.llm` 的具体方法集合只核到 `@Remote` 标注处（`listProviders`/`listConfigurableProviders`/`discoverModels`）；`lib/typert.remote-client.d.ts` 在安装版里不存在于该路径，未逐一验证类型声明。
- 前端设置页的渲染效果（主题、间距、无障碍）未在浏览器里验证。
