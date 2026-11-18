# dsh-personalised 设计契约（实现者必读）

本文是 host、client、文档三条实现线共用的接口契约。改动接口先改本文。

## 1. 定位与个性化维度

dsh-personalised = DeepSeek Harness 个性化插件。原 dsh-auto-memory 的记忆引擎保留，在其上补齐“个性化”需要的维度：

| 维度 | 含义 | 落点 |
|---|---|---|
| 指令 | 用户自定义 system instructions，全局稳定 | 新增：`systemPrompt.section` |
| 画像 | 身份、技能、环境、目标、偏好、纠错 | 新增：结构化个人记忆库 + 相关性注入 |
| 项目 | 只对某个工作区有效的记忆 | 已有项目笔记 + 新增 workspace 作用域条目 |
| 迁移 | 从其他平台导入、导出给其他平台 | 新增：导出提示词、模型处理导入、导出档案 |
| 边界 | 子代理能看到什么、敏感信息过滤 | 新增：子代理策略；沿用 injection-policy |
| 节奏 | 自动沉淀、问候、无人值守 | 已有 |
| 外观 | 皮肤、字号、主题 | 已有 |

## 2. 分层上下文架构

| 层 | 内容 | 注入通道 | 变化频率 | 作用域 |
|---|---|---|---|---|
| G 全局指令 | 自定义指令 + 画像中 `kind=instruction`、`scope=global`、非 pending 的条目 | `ctx.systemPrompt.section({name:'dsh-personalised:instructions', order, interpolate:false})` | 仅在用户编辑/导入时变化，字节稳定，利于前缀缓存 | 所有会话；子代理按策略 |
| P 个人记忆 | 画像中 `kind=fact`（含 global 项目条目）按与最新用户消息的相关性取 top-K | `ctx.systemPrompt.context({name:'dsh-personalised:personal'})`（user-role） | 每个用户 turn 重算；结果不变则文本不变 | 全局，但只注入相关条目 |
| W 项目记忆 | 画像中 `scope.type=workspace` 且 `scope.key===当前 wsKey` 的条目 | 与 P 同一个 context 块的 `<workspace_memory>` 子段 | 同 P | 只在对应工作区 |
| 旧 user-memory | `~/.dsh/memory/MEMORY.md` | 原 `<memory_system>` 快照 | `userMemoryInjectMode='relevant'` 时按段落相关性截取，`'full'` 保持旧行为 | 全局 |

规则：

- G 层渲染必须确定性：条目按 priority(high>medium>low) → createdAt → id 排序；不含日期、工作区、计数等易变字段。空内容返回 `''`（整段消失）。
- `customInstructionsPosition`：`prefix` → order 100（人格前缀之后、策略段之前）；`suffix` → order 10150（工具与策略段之后、人格后缀之前）。
- P/W 层同一请求的两次 `text()` 调用必须逐字节一致（沿用仓库 `finalizePre` / `requestIdPre` 的请求键思路）。
- pending（待确认）条目永不注入。
- 子代理（`agent.session.header.origin==='subagent'` 或 `delegationDepth>0`）：`personalSubagentPolicy`
  - `instructions`（默认）：只给 G 层，且仅当 `customInstructionsSubagents=true`；不给 P/W。
  - `none`：什么都不给。
  - `all`：G + P + W（W 按子代理自己的 cwd 判定）。
- 本插件自己 spawn 的后台子代理（新 `personalised-*`、兼容旧 `auto-memory-*` 标签）一律不注入 P/W。

## 3. 数据模型

文件：`<userMemoryDir>/personal/profile.json`（默认 `~/.dsh/memory/personal/profile.json`），原子写。备份：`<userMemoryDir>/personal/backups/<batchId>.json`（每次导入提交前的整库快照，保留最近 20 个）。

```js
// profile.json
{ version: 1, updatedAt: ISO, entries: [Entry] }

// Entry
{
  id: 'pm_<base36时间><随机>',
  kind: 'instruction' | 'fact' | 'pending',        // 由 category 推导，见下
  category: 'instructions' | 'identity' | 'skills' | 'environment' | 'projects'
          | 'goals' | 'preferences' | 'corrections' | 'pending',
  priority: 'high' | 'medium' | 'low',
  evidence: 'explicit' | 'inferred' | 'unconfirmed',
  time: string | null,        // '长期有效' | '事件:2026-10-15' | '确认:…' | null
  status: string | null,      // '进行中' | '规划中' | '已完成' | '已暂停' | '状态未知' | null
  text: string,
  scope: { type: 'global' } | { type: 'workspace', key: wsKey, path: string },
  source: { type: 'manual' | 'import' | 'agent', platform?: string, batchId?: string },
  pinned: boolean,            // true 时 P/W 层无视相关性阈值总是注入（仍受预算）
  createdAt: ISO, updatedAt: ISO,
}
```

kind 推导：`instructions`、`corrections` → `instruction`；`pending` 或 `evidence==='unconfirmed'` → `pending`；其余 → `fact`。
G 层只收 `kind=instruction && scope.global && priority!=='low'`；低优先级指令与 workspace 作用域指令进入 P/W 层按相关性注入。

## 4. 档案格式（导入导出共用）

与 `lib/personal/prompts.js` 的 EXPORT_PROMPT 一致：

```
### 1. 指令与行为规则
[高][明示][长期有效] 内容
[中][归纳][事件:2026-10-15][进行中] 内容
```

- 分类标题匹配 `^#{2,4}\s*(\d+)[.、]?\s*(标题)`，按序号或标题关键词映射到 category（1..9 对应 instructions..pending）。
- 行内标签：优先级 `高/中/低|high/medium/low`，证据 `明示/归纳/待确认|explicit/inferred/unconfirmed`，状态词表见 Entry.status；其余方括号字段视为 time。
- 无标签的列表行（`- 内容`）按所在分类导入，priority=medium，evidence=inferred。
- 去掉外层 ``` 代码块；“完整性声明”“待核实事项”段落不作为条目，放进 report.notes。
- 导出 Markdown：按 1..9 分类输出同样格式，文首一行说明来源与时间，末尾附完整性声明；workspace 条目在内容前加 `〔项目:<path>〕`。

## 5. Host 路由（全部 loopback-only，JSON；API 表键名 → 路径）

主前缀为 `/api/dsh-personalised`。旧 `/api/dsh-auto-memory` 由统一兼容映射注册为同处理器别名，保留方法、请求体和访问检查，不使用重定向。新浏览器代码只使用主前缀。

配置主文件为 `$DSH_HOME/dsh-personalised.json`。仅在主文件不存在时，在配置事务内读取旧 `dsh-auto-memory.json` 和更早的 `-pre` 配置，普通旧配置优先。旧文件只读保留；主文件存在（包括空对象）后不再从旧文件补键。数据目录和 Workspace key 不变。迁移与回退操作见 [MIGRATION.md](../MIGRATION.md)。

| API 键 | 方法 & 路径 | 请求 | 响应 |
|---|---|---|---|
| `personalState` | GET `/personal/state?sessionId=` | – | `{ok, instructions:{enabled,text,position,applyToSubagents,chars}, layers:{personalInjectMode,userMemoryInjectMode,personalTopK,personalBudgetChars,personalSubagentPolicy}, importModel:{provider,model}, stats:{total, byKind, byCategory, workspaces:[{key,path,count}]}, workspace:{key,path}|null, promptsVersion}` |
| `personalEntries` | GET `/personal/entries?scope=all|global|workspace&workspace=<key>&category=&kind=&q=` | – | `{ok, entries:[Entry]}` |
| `personalEntries` | POST 同路径 | `{op:'upsert', entry}` 或 `{op:'delete', ids:[]}` | `{ok, entry?|deleted?}` |
| `personalPrompts` | GET `/personal/prompts` | – | `{ok, version, exportPrompt, importPrompt}` |
| `personalImportPreview` | POST `/personal/import/preview` | `{text, mode:'model'|'parse', provider?, model?, sessionId?, workspace?:{key,path}|null, platform?}` | `{ok, previewId, mode, usedModel, items:[{tempId, action:'add'|'merge'|'conflict'|'skip', entry, targetId, existing, reason}], report:{summary,merged,conflicts,omissions,notes}, warnings:[]}` |
| `personalImportCommit` | POST `/personal/import/commit` | `{previewId, accept:[tempId], edits?:{[tempId]:Partial<Entry>}}` | `{ok, batchId, added, merged, skipped}` |
| `personalImportUndo` | POST `/personal/import/undo` | `{batchId}` | `{ok, restored}` |
| `personalExport` | GET `/personal/export?format=md|json&scope=all|global|workspace&workspace=` | – | `{ok, format, filename, content}` |
| `personalContextPreview` | GET `/personal/context-preview?q=&sessionId=` | – | `{ok, stable, personal, workspace, chars:{stable,personal,workspace}}` |
| `personalAgentsMd` | GET `/personal/agents-md` | – | `{ok, path, exists, text, digest}` |
| `personalAgentsMd` | POST 同路径 | `{text, expectedDigest}` | `{ok, digest}`；digest 不符返回 409 |

- 模型模式：`provider/model` 缺省时依次取 `personalImportProvider/Model` → `subagentProvider/subagentModel`；仍无则 400 `{error:'请选择用于处理导入的模型'}`。超时 `personalImportTimeoutMs`。模型输出非法 JSON 时降级为 parse 模式结果并在 `warnings` 说明。
- 预览存在内存，30 分钟过期；commit 时 previewId 失效返回 410。
- workspace 目标：缺省为 `sessionId` 绑定工作区；没有绑定工作区时 workspace 作用域条目降级为 global 并给 warning。
- `personalAgentsMd` 指向 DSH 原生 `$DSH_HOME/AGENTS.md`（dsh-agent-instructions 在会话首轮以 system-reminder 注入）。

## 6. 配置键（加入 DEFAULT_CONFIG，经现有 POST `/config` 保存）

| 键 | 默认 | 说明 |
|---|---|---|
| `customInstructionsEnabled` | `true` | G 层总开关 |
| `customInstructions` | `''` | 自定义 system instructions，上限 20000 字符 |
| `customInstructionsPosition` | `'prefix'` | `prefix`/`suffix` |
| `customInstructionsSubagents` | `true` | 子代理是否收到 G 层 |
| `personalInjectMode` | `'relevant'` | `relevant`/`off`（P/W 层） |
| `personalTopK` | `8` | 1–30 |
| `personalBudgetChars` | `1600` | 200–8000 |
| `personalSubagentPolicy` | `'instructions'` | `instructions`/`none`/`all` |
| `userMemoryInjectMode` | `'relevant'` | `full`/`relevant` |
| `personalImportProvider` | `''` | 导入用模型 provider |
| `personalImportModel` | `''` | 导入用模型 id |
| `personalImportTimeoutMs` | `180000` | 30000–600000 |

## 7. Agent 工具

`memory_profile`：`{action:'search'|'add'|'update'|'remove', query?, entry?, id?, scope?:'global'|'workspace'}`。add 默认 `source.type='agent'`、`evidence='explicit'`；scope=workspace 时绑定当前会话工作区。子代理调用 add/update/remove 时拒绝（只读）。

## 8. 前端

新增一个 `settings.section`（id `personalised`，导航名「个性化 / Personalisation」），组件放在 `lib/client.js` 中以 `/* ==== DSH-PERSONALISED BEGIN ==== */ … END` 包围的独立区块（不放进 ITER5 生成区）。五个标签页：

1. 指令：开关、多行编辑框、位置、子代理开关、字数/约 token；“DSH 原生 AGENTS.md”折叠编辑器。
2. 记忆：按分类分组列表，作用域筛选（全局 / 当前工作区 / 全部）、搜索、编辑、删除、置顶、新增。
3. 导入：四步向导——复制导出提示词 → 粘贴或上传档案 → 选择模型处理或本地解析、目标工作区 → 预览勾选（add/merge/conflict/skip 徽标，可逐条改文本）→ 提交，提交后显示“撤销本次导入”。
4. 导出：格式、范围、预览、复制、下载。
5. 分层：P/W 注入模式、top-K、预算、子代理策略、旧 MEMORY.md 注入模式；“上下文预览”输入一句话看三层将注入什么。

写配置统一走现有 `saveConfigPatch`；模型列表复用 GET `/models`。

### 原生 solid 浮层

所有插件内容浮层使用宿主主题的不透明表面，继承原生边框、字体、圆角和阴影令牌。经典档与变体档走同一最终表面样式层，覆盖面板、通知、向导、对话框、菜单、提示及固定保存栏；不得以皮肤透明度、背景图或模糊重新改变浮层透明度。

宿主遮罩、阴影和透明布局容器允许保留相应语义；它们不等同于内容表面。插件不得定义宿主 `--dsw-alias-*` 来反向覆盖主题，避免局部皮肤污染其他组件。资源只在存在真实消费引用时打包；删除装饰图必须同步清单与回归。
