# dsh-personalised 仓库测绘（只读报告）

调研对象：`D:\Projects\GitHub\dsh-personalised`，git 仓库名已改为 dsh-personalised，包名与内部标识仍是 dsh-auto-memory。
取证方式：只读 `lib/*.js`、`tests/`、`tools/`、`package.json`、`locale/`、`skins/`；用 grep 定位后按行号读片段；用 `node -e` 求值 `DEFAULT_CONFIG` / `API` 表；跑过滤后的 smoke 子集计时；未整文件读取两个大 bundle。
行号基准：2026-11-17 20:2x 的 HEAD（a244cf03）。调研期间工作区被其他成员加入了 `package.json` / `pnpm-lock.yaml` / `commitlint.config.mjs` 改动，本报告未触碰这些文件；引用行号只对 `lib/*.js` 负责。

统计口径（本次实测）：

| 项 | 数值 |
| --- | --- |
| `lib/index.js` 行数 | 21232 |
| `lib/client.js` 行数 | 19753 |
| `DEFAULT_CONFIG` 键数 | 160 |
| 宿主 API 路由数（`API` 表） | 73 |
| `defineTool(...)` 工具数 | 19（15 个 `memory_*` + 4 个 `calendar_*`） |
| smoke 套件数 | 443（`tests/smoke/*.mjs`） |
| 提到 `dsh-auto-memory`/`auto-memory` 的 smoke 套件 | 105 |
| 全仓文本命中（排除二进制 assets/.git） | 3281 处 / 469 个文件 |

---

## 1. 插件入口、Config、配置读写、路由（Q1）

### 1.1 apply 入口与服务依赖

- 插件对象导出 `name = 'auto-memory-pre'`：`lib/index.js:332`。
- 需要的宿主服务：`export const inject = ['webServer', 'tools', 'systemPrompt', 'subagents', 'llm']`：`lib/index.js:335`。这决定了新增能力前要先确认对应服务已在 inject 列表里。
- 真正的入口 `export function apply(ctx, config)`：`lib/index.js:15639`。`config` 参数基本不使用，插件自己从 `dshHome()/dsh-auto-memory.json` 读配置。
- `apply` 不是 async，返回值不被宿主 await，因此工具注册前必须**同步**加载配置：`try { engine.loadConfigSync() }` 在 `lib/index.js:15741-15743`。这段注释同时说明为什么不能在 apply 里 await。
- 资源所有权顺序：`disposers` / `disposeSurfaces` 先建（`lib/index.js:15687-15736`），`ctx.effect(() => disposeSurfaces, 'dsh-auto-memory: surfaces')` 先登记；路由与工具注册在最后（`lib/index.js:21197-21213`）。新增任何长生命周期资源都应把 dispose 塞进 `disposers`。
- 服务惰性获取：`engine._subagents = ctx.get('subagents')`（`lib/index.js:17328`），`engine._llm = ctx.get('llm')`（`lib/index.js:17341`），`engine._workspaceRegistry` / `_sessionsSvc` / `_agentSvc` 同理（`17326-17344`）。

### 1.2 Config "schema" 的真实位置

仓库没有使用 cordis/schemastery 的 Config schema。全部配置定义集中在一个对象字面量：

- `const DEFAULT_CONFIG = { ... }`：`lib/index.js:555-1147`，共 160 个键。每段带注释，键的默认值就是唯一真源。
- 写入白名单直接由它派生：`const allowed = Object.keys(DEFAULT_CONFIG)`（`lib/index.js:20672`），POST `/config` 只接收这些键（`20672-20684`）。因此新增配置键的第一步就是加进 `DEFAULT_CONFIG`，否则前端传了也会被静默丢弃。
- 字段级校验在 `lib/settings-safety.js`：
  - `validateSettingsPatch(patch)`：时间格式、数组、整数范围、枚举，`lib/settings-safety.js:16-33`。
  - `validateSettingsPaths(patch, home, expand)`：`memoryRoot` / `userMemoryDir` / `workbenchRoot` 三个路径键，要求非空字符串、绝对路径、物理解析后落在 DSH_HOME 内，`lib/settings-safety.js:39-69`。新增路径型配置必须在这里登记，否则 POST 会直接放行任意路径。
- 一次性迁移是仓库惯例：`saveConfig` 会把**整个合并后的 config** 落盘，所以改默认值救不了老用户。现有例子 `upgradeCapacityDefaultsPre`（`lib/index.js:3084` 起）与 `upgradeSnapshotGapDefaultPre`（`lib/index.js:3140` 左右），在 `loadConfigSync` / `loadConfig` 两条路径都调用（`3233`、`3269`）。新增默认值或改默认值时要照这个模式写迁移，不能只改常量。

### 1.3 配置文件读写（config-io.js 与锁）

- 路径：`this._configPath = path.join(dshHome(), 'dsh-auto-memory.json')`，`lib/index.js:2379`。
- 旧名兼容：`_mergeConfigPre` 会把 `dsh-auto-memory-pre.json` **逐键补齐**到新名，同键以新名为准，只有新名缺键时才写盘，`lib/index.js:3003-3037`。这是本仓库最近一次"去 pre 改名"的完整兼容样例。
- 启动读：`loadConfigSync` → `withConfigLockSync` → `_loadConfigSyncLocked`（`3189-3239`），内部用 `readJsonQuarantinePreSync`（`3211`），损坏配置先隔离再回落默认，诊断写 `_readError`。
- 异步读：`loadConfig` / `_loadConfigLocked`（`3241-3275`），与同步路径共用 `_mergeConfigPre`。
- 保存：`saveConfig(patch)`（`3355-3367`）串行化后进 `_saveConfigChecked`（`3370-3501`）。保存期用 `readSettingsForSave` **严格读**（损坏即拒，不把默认写回真源），再 `validateSettingsPatch + validateSettingsPaths`，再迁移 `memoryRoot` / `userMemoryDir`（`migrateSettingsTree`），最后 `writeTextAtomicPre` 原子写（`3465`），成功才发布内存配置（`3485`）。
- 原子写/隔离原语：`lib/config-io.js` 导出 `writeTextAtomicPreSync`、`writeTextAtomicPre`、`readJsonQuarantinePreSync`、`quarantineFilePreSync`（`35-201`）。跨进程锁：`lib/config-lock.js` 的 `withConfigLockSync` / `withConfigLock` / `readConfigSnapshot`（`120-145`）。
- 保存的副作用：`semanticEngineMode` 会联动 `activationSource` / `contextSinkMode` / `pythonBackendEnabled`（`3395-3400`）；根目录变更会走迁移窗口与 in-flight 写 drain（`3415-3463`）。新增影响路径的配置要遵守这套事务，不要另写旁路。

### 1.4 路由注册方式（如何新增一条路由）

两层结构：常量表 + 数组注册。

1. 路径表 `export const API = { ... }`：`lib/index.js:347-429`，73 条。例如 `state: '/api/dsh-auto-memory/state'`（`348`）、`config: ...`（`377`）。
2. 路由对象数组 `const routes = [...]`：`lib/index.js:19137-21105`。每条形状固定：
   ```js
   {
     kind: 'exact',
     path: API.state,
     handler: async (req, res) => {
       if (!isLoopbackRequest(req, panelAllowedHosts)) return writeJson(res, 403, forbiddenPanelPayloadPre(req, panelAllowedHosts))
       if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
       try { writeJson(res, 200, result) } catch (e) { writeJson(res, 500, { error: String(e && e.message ? e.message : e) }) }
     },
   }
   ```
   现成模板：GET `/state`（`lib/index.js:20280-20301`）、GET `/list`（`20302-20322`）、读写 `/config`（`20650-20692`）。
3. 注册与清理：`for (const route of routes) disposers.push(ctx.webServer.register(route))`，`lib/index.js:21209`。
4. 访问控制：`panelAllowedHosts` 每个 apply 周期解析一次（`lib/index.js:19123-19134`），来源优先 `DSH_AUTO_MEMORY_ALLOWED_HOSTS`，其次 `config.panelAllowedHosts`。`isLoopbackRequest` 支持回环与"私有地址 + Host 白名单"两档（`14187-14212`），403 统一返回 `forbiddenPanelPayloadPre`（`14228-14243`）。请求体读取 `readJsonBody(req, maxBytes=256KB)`（`14245-14254`）。
5. 前端路径表必须同步：`lib/client.js:3674` 的 `var ROUTE_PREFIX = '/api/dsh-auto-memory'`，`var API = {...}` 全部用 `ROUTE_PREFIX + '/xxx'`（`3678-3747`）。前端在表外不得出现裸 `/api/...` 字面量。
6. 守卫会锁死两边一致性：
   - `tests/smoke/smoke-test-api-paths.mjs`：A1 客户端路径 ⊆ 宿主，A2 宿主独有路径必须等于白名单，A3 表外裸路径为 0，A4 `path: API.x` 的键都存在（全文 `14-114`）。新增只在宿主使用的端点要加白名单并注明非界面消费者。
   - `tests/smoke/smoke-test-issue111-docs-real-names.mjs:41-60`：从 `lib/index.js` 取端点前缀并断言等于 `/api/dsh-auto-memory/`，同时要求 HANDBOOK/USER-GUIDE 写这个真名。

新增一条路由的最小改动：`API` 表加键 → `routes` 数组加对象（loopback + method 检查 + try/catch）→ 若前端要调用，在 `client.js` 的 `API` 表加 `ROUTE_PREFIX + '...'` → 跑 `smoke-test-api-paths`。如果端点只在宿主使用，还要改 `HOST_ONLY_WHITELIST`（该测试 `26-47`）。

### 1.5 新增一个 Config 字段的最小改动

1. `DEFAULT_CONFIG` 加键和注释（`lib/index.js:555-1147`）。带默认值就写常量，别散魔法数。
2. 如果是时间/数组/整数/枚举，在 `validateSettingsPatch` 加分支（`lib/settings-safety.js:16-33`）；如果是路径，把键加进 `validateSettingsPaths` 的两个数组（`lib/settings-safety.js:41`、`49`）。
3. 读取处统一 `engine.config.<key>`，并按仓库习惯给兜底：`Number(cfg.x) || 默认`，注意 0 是合法值时不能用 `||`（仓库有专门教训，见 `lib/index.js:1326-1342` 的 `parseGapRoundsPre`）。
4. 如果需要 UI，在设置页加控件（见第 6 节）。`settingsEntryInDsSettings` / `settingsEntryInPluginsPage` 是控制入口是否出现的两个现成例子（`lib/index.js:578-579`；`lib/client.js:16015-16018`、`19586-19613`）。
5. 如果改变了某个老键的默认值，补一次性迁移（`lib/index.js:3084`、`3140` 的模式），否则老用户磁盘上的旧值永远覆盖新默认。
6. 守卫：`tests/smoke/smoke-test-i335-settings-entry.mjs:31-40` 会从源码抽取 `DEFAULT_CONFIG` 并求值，断言新键存在且落在白名单里；`tests/smoke/smoke-test-t7a-defaults.mjs` 锁默认值常量化与不共用常量。新增键后至少要跑 settings 相关子集（见第 7 节）。

---

## 2. 系统提示词注入链（Q2）

### 2.1 三个注入面与注册点

全部通过 DSH 的 `systemPrompt` 服务注册，没有监听 `system-prompt/assemble`，也没有改历史消息。

| 面 | 注册代码 | 名称 | order | 通道语义 |
| --- | --- | --- | --- | --- |
| 静态纪律 | `lib/index.js:18294-18300` `ctx.systemPrompt.section({...})` | `dsh:auto-memory-pre-rules` | `SECTION_ORDER = 10000`（`338`） | 进 system prompt，字节稳定，是前缀缓存锚 |
| 动态记忆快照 | `lib/index.js:17551-18292` `ctx.systemPrompt.context({...})` | `dsh:auto-memory-pre` | 10000 | user-role，追加在历史尾部，内容变化才重复注入 |
| 记忆唤回 tail | `lib/index.js:18304-18344` `ctx.systemPrompt.context({...})` | `dsh:m6-reference-tail-pre` | 10001 | user-role，只渲染已 claim 的唤回 packet |

`SECTION_ORDER = 10000` 的注释写明"末尾注入，紧跟用户消息，recency 最高"（`lib/index.js:337-338`）。三个面都是**全局**注册，所有 agent 都会走到 `text(context)`，`context.agent` 用于区分会话。宿主契约（DSH 0.2.2-rc.3）见同目录 `research-dsh-rc3-api.md` §2.3：全局 section 对所有 agent 生效，要按 agent 区分只能在 `text(context)` 内分支。

`lib/context-host.js` 不在上述三个面里。它是 M5 Context Bridge 的 host：消费 accepted segment，组装 `ContextPushEnvelopePre`，按 `contextSinkMode` 走 null/fake/python sink，并记录 read/cite/correction 证据（`lib/context-host.js:1-14`）。默认由 `associativeMemoryEnabled && contextBridgeEnabled` 双门关闭，零构造、零 IO；它不往 system prompt 里写文本，改它不会改变注入块。同理，`tier-layer-inject.js` 是"把三层数据装成一段文本"的纯函数（`lib/tier-layer-inject.js:1-35`），`global-brief.js` 是"检测本工作区别的 Agent 改了哪些文件并生成简报"的纯逻辑（`lib/global-brief.js:1-25`），`team-inject.js` 只做预算仲裁（`lib/team-inject.js:1-24`），真正的注入点在 `renderMemoryDynamic` 与两个 `systemPrompt.context` 回调。

动态快照的关键回调逻辑：

- 总闸 `injectEnabled === false` 直接返回空串（`lib/index.js:17565`），只关这一条通路。
- `engine.withAgent(agent, ...)` 把 `engine.state` 绑定到当前 agent 的 runtime（`17567`）；`stateFor(agent)` 拿 per-session state（`2480` 起）。
- `capturePathsFor(agent)` 在每个 agent 注入时补登记路径（`17573`）。
- 15 秒 TTL：`st.loadedAt` 过期就 `void engine.refresh(agent)` 异步刷新（`17574-17581`），回调本身同步返回。
- 完整版由 `engine.renderMemoryDynamic(context)` 生成（`17592`，实现 `8421-8706`）；精简版由 `engine.renderSlimSnapshotPre(wsHint, agent)` 生成（`17601`，实现 `8169-8231`）。
- 请求级幂等：`finalizePre(txt)` 把本请求的最终文本写进 `st._reqTextKeyPre/_reqTextPre`（`17608-17619`）。宿主每个模型请求会调用 `text()` 两次（第一次 preStep assemble 被丢弃，第二次 refreshContext 才进模型），两次必须逐字节相同。请求键取"最近一次 step/end 的 seq"（`requestIdPre`，`8352-8381`）。
- 频率控制：完整版间隔 `snapshotMinGapRounds`（默认 20，`452-459`、`855`），精简版间隔 `slimEveryRounds`（默认 8，`461-471`、`864`）。每个新 turn 首次注入强制完整版，按 turn 号去重；长 turn 内后续 step 回到节流（`17621-17652`、`17990-18290`）。
- 内容指纹 `st._snapFp` 用于判断"快照是否变化"（`17994`、`18034`、`18136`、`18233`）。
- `renderReflectionRequest()` 是一次性块（`8751-8770`），被 `finalizePre` 包裹后两次调用才能一致（`17606-17607` 注释）。

### 2.2 动态快照的段顺序与合并

`renderMemoryDynamic` 用 `pushPart(bucket, kind, text, priority)` 逐段入账（`lib/index.js:8490-8494`），最后由 `composeMemoryEnvelopePre` 计量、裁剪、序列化（`8654-8662`）。顺序：

1. `frame-head`：`<memory_system>` 与读法/来源身份说明（`8497`，默认文案 `DEFAULT_PROMPT_LAYERS.snapshotHead`，`lib/index.js:1164`）。
2. `frame-meta`：工作区、日期、日界、自动沉淀状态（`8498`，文案 `1165`）。
3. `rules-section`：从用户级/项目笔记里提取的规则条目（`8499`；提取 `8455-8470`；纯逻辑在 `lib/rules-layer.js:211-337`）。
4. `workspace-map`：其他工作区索引（`8501-8503`）。
5. `tier0-catalog`：Tier-0 常驻目录，由 `refresh()` 预计算在 `state.tier0LayerText`（`8509-8511`；装配 `lib/tier-layer-inject.js`）。
6. `whiteboard-plan` / `handoff-ledger`：PLAN.md 与最新交接账本，各自清洗敏感段并按字符预算截断（`8514-8519`）。
7. `plan-update-request`：水位/接续触发时的一次性白板更新请求（`8525-8528`）。
8. `handoff-pointer`：工作区未绑定时的全局账本绝对路径（`8530-8532`）。
9. `water-advisory`：上下文水位提醒（`8534-8536`）。
10. `recent-logs` / `reflection` / `user-memory` / `project-notes`：证据层，`recent-logs` 与 `reflection` 为 `low/normal`，`user-memory` 与 `project-notes` 为 `must`（`8552-8565`）。每段用同一个 `sub` 字符预算截断（`8545`）。
11. `external-memory` / `external-sessions`：其他 AI 工具记忆的绝对路径索引，不整段注入内容（`8575-8588`）。
12. `calendar`：未完成日程（`8591-8597`）。
13. `welcome-title` / `welcome-body`：暂离回归提示（`8605-8608`）。
14. `frame-inscription`：每轮收尾自检提醒（`8612`，文案 `1198-1214`）。
15. `frame-tail`：`</memory_system>`（`8613`）。

两个附加段在 envelope 之前合入同一本账：

- 团队段：`engine._teamInject.decide(candidates, usedNow, budgetChars, teamEnabled && teamInjectEnabled)`，接受才追加（`lib/index.js:8633-8644`）；预算仲裁纯函数在 `lib/team-inject.js`（默认 `priority='low'`，团队关闭时返回空）。
- 全局动态简报：`globalBriefEnabled === true` 时 `external.briefDetectSyncPre()` 返回文本，以 `kind='global-brief'`、`priority: 6` 追加（`8647-8653`；实现 `lib/global-brief.js` 的 `diffBriefPre`/`buildDraftPre`/`renderBriefPre`，`77/184/227`；检测入口 `lib/index.js:14475-14590`）。注意这里的 `6` 不在 priority 词表里，`memory-envelope.js:54-55` 会归一成 `normal`。

敏感内容过滤：`stripSensitiveSections`（`lib/injection-policy.js:24`）只包在用户级、项目笔记、白板、账本这四段上（`8515`、`8517`、`8564`、`8565`）。外部记忆、日历、日志等不走这层。injection-policy 另导出 `sensitiveSections` / `filterSensitiveHits` 供检索侧命中过滤（`1-70`）。

### 2.3 完整版与精简版的内容差异

精简版在 2026-10-01 被用户要求瘦身，现在只保留（`lib/index.js:8192-8225`）：

- 检索指引 `snapshotSlimGuide`；
- 上一轮真实投递唤回时的动态行 `snapshotSlimRecallHit`（渲染后清标，`8207-8215`）；
- 精简说明 `snapshotSlimNote`（含完整版间隔 n）；
- `snapshotSlimMaintain`（每轮维护底线）；
- `snapshotSlimRecallNote`（声明唤回通道独立存在）。

不再包含规则全文、Tier-0 目录、白板/账本、日历（`8192-8200` 注释给出实测大小与砍掉的理由）。这意味着规则与账本在第 2 到第 N-1 个请求里**不在场**，模型要用 `memory_recall` / `memory_read` 主动取。若新功能依赖"每轮都在场"，要么塞进精简版，要么接受节流。

### 2.4 缓存友好度：哪些段每轮变，哪些稳定

稳定（同一进程、同一配置、同一天内字节不变）：

- `systemPrompt.section` 的整段 `renderMemoryStatic()`（`lib/index.js:8709-8747`）。它不含日期和工作区，是 system prompt 的缓存锚。加内容会让 system prompt 变一次，之后继续稳定。
- 动态快照里的 `frame-head` 与 `frame-tail`（默认文案，`8497`、`8613`）。
- `frame-meta` 在日期、工作区、自动沉淀开关不变时稳定（`8498`）。

会变（每次变化都会在历史尾部追加一条新的 user-role 快照）：

- `recent-logs`：任一 `memory_log` 写入后变（`8552-8556`）。这是最频繁的变化源。
- `rules-section`：用户级/项目笔记的规则条目变化后变（`8455-8470`、`8499`）。
- `tier0-catalog`：记忆目录变化后变（`8509-8511`）。
- `whiteboard-plan` / `handoff-ledger`：白板/账本写入后变（`8514-8519`）。
- `user-memory` / `project-notes`：文件变化后变（`8564-8565`）。
- `reflection`：每日反思落盘后变（`8558-8560`）。
- `calendar`：日程增删后变（`8591-8597`）。
- `water-advisory`：越过水位阈值后出现，10 分钟新鲜度窗口（`8534`）。
- `welcome-title/body`：暂离超过 `awayMinutes` 后出现，下一轮可能消失（`8605-8608`）。
- `plan-update-request`：一次性，出现一轮后清位（`8823`）。
- `frame-inscription`：含 `{date}`，同一天内稳定；跨天变一次（`8612`）。
- `snapshotSlimRecallHit`：只有上一轮真的投递了唤回才出现一次，下一轮消失（`8207-8215`）。

缓存结论：静态 system prompt 不因记忆内容变化而击穿，历史前缀也只在尾部追加；但每条新快照都会成为历史的一部分，长会话里若每轮都有日志变化，完整版/精简版会持续膨胀上下文。现有缓解手段是 `snapshotMinGapRounds` / `slimEveryRounds` / `injectBudgetChars` / `snapshotTieredInject`，以及"内容不变时宿主 project() 去重"（`17550`、`8419-8420` 注释）。没有把"稳定段/动态段"拆到两个不同 system prompt 区段的机制，所有动态内容都在同一个 user-role 快照里。

### 2.5 新增一段系统提示词注入的最小路径

静态纪律（每轮字节稳定，不参与裁剪）：

1. 在 `renderMemoryStatic()` 里加一行 `lines.push(...)`，`lib/index.js:8709-8747`。文案若允许用户覆盖，加进 `DEFAULT_PROMPT_LAYERS`（`1154-1235`），并在 `renderMemoryStatic` 用 `L(...)` 读。

动态段（跟随完整版/精简版节流）：

1. 数据预计算放在 `_doRefresh`（`lib/index.js:7292-7392`），结果挂 `state.<field>`。
2. 在 `renderMemoryDynamic` 里加 `pushPart(bucket, 'your-kind', text, priority)`（`8490-8613` 之间挑位置）。`bucket` 只能是 `rules` / `memoryReferences` / `otherDynamic`（`lib/memory-envelope.js` 的 `ENVELOPE_BUCKETS_PRE_V1`），`priority` 用 `low|normal|must`。
3. 如果要让用户能单独关，把 `'your-kind'` 加进 `PROMPT_SECTION_KEYS_PRE_V1`（`lib/index.js:1245-1259`）；若属于硬性行为要求，再加进 `PROMPT_SECTION_MUST_PRE_V1`（`1266-1269`）。前端文案表 `PROMPT_SECTION_TEXT` 必须同步（`lib/client.js:18193-18215`），`smoke-test-t1-prompt-sections` 会断言两个集合严格相等（`tests/smoke/smoke-test-t1-prompt-sections.mjs:56-101`）。
4. 如果还要出现在精简版，改 `renderSlimSnapshotPre`（`8169-8231`），并接受 `snapshotSlimNote` 的语义。

另一个独立通道（不挤进动态快照）：新增一个 `ctx.systemPrompt.context({ name, order, text })`，模板 `lib/index.js:17551-17553` 或 `18304-18306`。这种方式适合"内容独立、需要单独投递"的块，但要自己处理两帧幂等与请求级去重。

---

## 3. 记忆分层、路径、作用域（Q3）

### 3.1 路径总表

用户级（跨工作区）：

| 内容 | 路径 | 证据 |
| --- | --- | --- |
| 用户级记忆 | `~/.dsh/memory/MEMORY.md`（`userMemoryDir` 默认 `~/.dsh/memory`） | `lib/index.js:563`、`3616-3619`、`3659` |
| 用户级日历 | `~/.dsh/memory/CALENDAR.md` | `3660` |
| 用户级问候 | `~/.dsh/memory/greetings/YYYY-MM-DD.json` | `globalPaths()` `6953-6963`、读取顺序 `7358-7362` |
| 全局简报水位 | `~/.dsh/memory/global-brief/<wsKey>.json` | `14483` |
| 技能导出 | `<DSH_HOME>/skills/`（`mem-skill-*`） | `lib/skill-export-host.js:30-37`、`lib/index.js:18782` |
| 皮肤 | `~/.dsh/memory/skins/<name>/` | `lib/index.js:1519-1535`、`lib/skin-center.js:39` |

项目级（集中式根目录，按工作区分隔）：

| 内容 | 路径 | 证据 |
| --- | --- | --- |
| 项目根 | `~/.dsh/memory/workspaces/<wsKey>/`（`memoryRoot` 默认） | `lib/index.js:567`、`3527`、`3530` |
| 项目笔记 | `<projectDir>/MEMORY.md` | `3662` |
| 每日日志 | `<projectDir>/YYYY-MM-DD.md` | `3663` |
| 反思 | `<projectDir>/reflections/` | `3664` |
| 白板 | `<projectDir>/handoff/PLAN.md` | `3666` |
| 交接账本 | `<projectDir>/handoff/handoff-YYYYMMDD-HHMMSS.md` | `3665`、`3745` |
| 归档日志 | `<projectDir>/archive/` | `3923`、`3941`、`7733` |
| 项目问候 | `<projectDir>/greetings/YYYY-MM-DD.json` | `3667-3669` |

插件数据（用户级，非项目）：

| 内容 | 路径 | 证据 |
| --- | --- | --- |
| Hub 三店 | `~/.dsh/memory/hub/{facts,episodes,procedures}.json` | `lib/index.js:16135`、`16179-16186` |
| 工作区技能库 | `~/.dsh/memory/workspaces/<wsKey>/hub/procedures.json` | `16161-16173` |
| 索引 sidecar | `~/.dsh/memory/index/files/` | `7989`、`8919`、`16232` |
| 语义状态/判定 | `~/.dsh/memory/semantic/`（`judgement-shadow.jsonl`、`activation-shadow-v2.jsonl`、`l0/`、`engine-switch-state.json`） | `16127`、`16335`、`16503`、`19900` |
| 证据事件 | `~/.dsh/memory/evidence/events/` | `9368`、`19931` |
| 降级台账 | `~/.dsh/memory/degrade/latest.json` | `10521` |
| 召回统计 | `~/.dsh/memory/recall-stats.json` | `15748` |
| 工作台 | `~/.dsh/memory/workbench.json`，工作区根默认 `<DSH_HOME>/aik_auto_memory_use` | `11345`、`1783`、`11382` |
| 团队 | `~/.dsh/memory/team/` | `15820-15821`、`15937` |
| 导入导出 | `~/.dsh/exports/dsh-auto-memory/`（含 `uploads/`） | `9911`、`10010` |
| 诊断日志 | `<DSH_HOME>/dsh-auto-memory-diagnose.log` | `1719` |

旧目录兼容：`lib/datadir.js` 的 `memoryDir(name)` 会在 `name-pre` 存在时逐文件补齐到裸名，绝不 move、绝不覆盖已有真实数据，失败回落旧目录（`lib/datadir.js:64-101`）。这是"去 pre 改名"的数据侧兼容样例，后续改名可直接复用。

### 3.2 用户级 MEMORY.md 是全量注入，不是相关性检索

- `_doRefresh` 直接 `readTextSafe(p.userFile)` 读整篇，写进 `state.userText`（`lib/index.js:7307-7310`）。
- 注入时 `part('memoryReferences', 'user-memory', L('snapshotUserTitle'), stripSensitiveSections(sanitizeForInjection(s.userText)), sub, 'must')`（`8564`）。
- `part` 用 `truncateHead(text, max)` 截断（`8547-8551`、`1310-1321`），`max = sub = floor((injectBudgetChars - 500 - catalogCost) / 4)`（`8545`）。也就是说，用户级记忆与项目笔记、日志、反思**平分**一份预算，单段超长时从尾部截断并附"…(截断…)"。
- 规则层额外从 `s.userText` / `s.notesText` 里按结构化前缀与约束语汇提取，单独走 `rules-section`，不受 20 轮 gap 约束、不参与裁剪（`8453-8470`、`8499`；`lib/rules-layer.js:211-337`）。规则段只保留每条的摘要（`ruleSummaryPre` 默认 200 字符，`lib/rules-layer.js:289-311`），没有整段容量上限。
- 没有任何"按相关性检索用户级记忆再注入"的路径。`memory_recall` 是模型显式调用的工具，与自动注入是两条链。`injectExcludeSources` 只作用于 Tier-0 / 唤回来源闸门（`lib/index.js:8090-8091`），不影响 `user-memory` 段。

结论：当前用户级记忆是"全量读取 + 预算内截断 + 敏感段剥离 + 规则条目另抽"，不是 RAG。

### 3.3 项目记忆的隔离键

- `wsKey(ws)`：`'--' + String(ws).replace(/[\\/:*?"<>|]/g, '-') + '--'`（`lib/index.js:3512-3515`）。隔离依据就是**工作区绝对路径字符串**。
- `projectDirOf(ws)`：如果 `config.projectMemoryDir` 是绝对路径，直接返回它（所有工作区共享一份，失去隔离）；否则 `path.join(memoryRoot, wsKey(ws))`（`3518-3531`）。
- `memoryRoot` 默认 `~/.dsh/memory/workspaces`（`567`），保存时要求物理路径落在 DSH_HOME 内（`lib/settings-safety.js:39-69`）。
- 旧布局 `{ws}/.dsh-memory` 会在 refresh 时 `migrateLegacy` 复制到集中式目录，只复制不删旧（`lib/index.js:3601-3614`、`7297`）。
- 风险：`wsKey` 只做字符替换，不做哈希。Windows 上 `C:\a:b` 与 `C:\a*b` 会落到同一目录；路径大小写不同也可能撞同一目录（Windows 大小写不敏感）。改隔离方案时不能只改 `wsKey`，因为 `workspaceRef` / procedure 工作区库 / migration / 证据归属都以它为身份（`16166-16173`、`16193`）。

### 3.4 子代理（subagent）注入边界

- 注册的三个注入面都是全局的，`text(context)` 对每个 agent 都会跑；代码注释明确写"本回调对每一个 agent（含子会话/子代理）都会跑一次"（`lib/index.js:17570-17571`）。
- 插件自己 spawn 的子代理会被 `_ownSubagents` 标记，`pre-step` 直接早退（`17492`），`turn-stopping` 直接 return（`17408-17410`），`consolidateTurn` 也跳过（`13271`）。
- 对非本插件 spawn 的子代理，`pre-step` 里 `skip = isSubAgentSession(agent)`，跳过 `refresh`，避免把 state 切到错误工作区（`17507-17511`；判定函数 `1694` 起，看 `origin === 'subagent'` / `delegationDepth`，不看 `parentSession`）。
- 结果是：子代理会拿到静态纪律段（system prompt 全局 section），动态快照则用**它自己的 runtime state** 渲染（通常为空，只剩 head/meta/inscription/tail）。插件没有把父会话的记忆投影给子代理，也没有"子代理不注入"的白名单。
- `lib/subagent-prompt-guard.js`（`buildSubagentGuardPre` / `withSubagentGuardPre`，`55-79`）与 `lib/hub-message-filter.js` 当前**没有被 `lib/index.js` import**。全仓 grep 只有模块自身与 `hub-message-filter` 的头部注释提到它们；最近提交 a244cf03 只把文件补进 git，没有接线。`subagent-prompt-guard` 的价值因此为零；`hub-message-filter` 里描述的"记忆中枢拦截宿主自动回报"也未生效。改动子代理注入前先决定是否接线，不要假设已有边界控制。
- 子代理的工具面继承父会话（`subagent-prompt-guard.js:10-13` 的取证），所以 `memory_*` 工具在子代理里可调用，可能写入当前工作区记忆。
- 已有测试没有覆盖"子代理是否被注入记忆"这一面（`tests/smoke` 中没有对应套件）。这是新增"个人化记忆"时最容易失控的边界。

---

## 4. 已有导入/导出（Q4）

### 4.1 迁移包（migrate-pack）

- 格式常量：`MIGRATE_PACK_FORMAT_PRE = 'dam-pack-v1'`，校验算法 `sha256` 与 `sha256+userFiles-v2`，上限 20000 文件 / 256MB（`lib/migrate-pack.js:28-43`）。
- 入口函数：
  - `buildPackPre(opt)`：纯函数打包，不写盘；包结构含 `format / createdAt / source{ws,slug,host} / runtime{pluginVersion} / summaryRecord / files / userFiles / stats / checksum`（`lib/migrate-pack.js:198-243`）。
  - `validatePackPre(pack, opts)`：校验格式、路径穿越、文件数、checksum；带 `userFiles` 的老包默认拒收，除非 `allowUnprovenUserFiles=true`（`249-309`）。
  - `planImportPre` / `rewritePackForTargetPre` / `calendarMergePre` / `mergeSummaryRecordPre`：预览、路径重写、日历合并、摘要合并（`329`、`366`、`546`、`489`）。
- 引擎侧：
  - `migrateExport(opts)`：打包一个工作区，只收 `.md/.json/.jsonl/.txt`；边界用 `fileWithinRoots` 防 symlink 越界；输出原子写；默认 gzip 到 `~/.dsh/exports/dsh-auto-memory/<slug>.dam-pack.gz`（`lib/index.js:9907-10005`）。
  - `migrateUploadPre(request, name)`：流式接收 `.dam-pack(.gz)`，暂存到 `exports/.../uploads/`，只做校验不导入（`10008` 起）。
  - `migrateInspect(opts)`：只读预览差异，返回 `previewToken`（`10106` 起）。
  - `migrateImport(opts)`：先备份后落盘，冲突策略 `keep|overwrite|rename`，导入前用 `previewToken` 对齐预览结果（`10137` 起）。
- 四个路由：`/migrate-export`、`/migrate-inspect`、`/migrate-upload`、`/migrate-import`（`lib/index.js:20410-20465`），全部 loopback-only；upload 要求 `application/octet-stream`。
- 前端入口在 `Iter5Storage` / `Iter5Migration`（`lib/client.js:14662`、`16102`），中文文案键 `migExport/migImport/...` 在 `I18N`（`628-629` 附近）。

### 4.2 外部记忆接入（external-import）

- 路由 `/external-import`：`lib/index.js:20876-20893`，请求体 `{source, target:'user'|'project', sessionId}`；必须解析出绑定工作区，再 `engine.external.importInto(...)`。这里就是 issue #384/#387 的修复点：导入绑定会话（`sessionId` 必填、`wsBound` 必须为真），同一来源用 marker 去重。
- `ExternalMemory.importInto` 是**链接模式**：不复制外部内容，只往用户级或项目笔记追加一个带 SHA-256 marker 的链接块，列出源文件绝对路径和用法（`lib/index.js:14787-14811`）。重复接入用 `ifAbsent: marker` 幂等跳过。
- 移除：`removeImported` 按 marker 删除整段，写回时带 `expectedDigest` 乐观锁（`14829-14851`）。
- 来源清单/扫描/过滤：`ExternalMemory.discover`（`14603`）、`filterEnabledPre`、`summarize`（`14857`）；关闭来源后注入侧还要再过一次 `filterEnabledPre`（`8567-8574` 注释），否则缓存里的旧来源会继续被注入。
- 格式上没有单独的"导入文件"格式，全部是 Markdown 段 + HTML 注释 marker。

### 4.3 写入保护门（memory-mutation / transaction）

- `validateMutationBoundaryPre(input)`：接收规范化投影 `{beforeIds, afterIds, protectedRegions, changes, archivedIds}`，做三条硬保护：丢卡必须显式归档（M1）、用户备注区摘要必须原样带回（M2）、重复 id 拒绝（M3）；`strict` 只影响软项，不影响 M1-M3（`lib/memory-mutation.js:76-231`；拒绝文案 `212-231`）。
- `withMemoryMutationPre(engine, file, job, admission)`：写入事务与 admission 边界，配合 `captureMemoryMutationPre` / `drainMemoryMutationFlightsPre` / `withMemoryAdmissionScopePre`（`lib/memory-mutation-transaction.js:51-336`）。
- 采用情况：白板/账本写路径通过 `wb-contract.js` 的 `toMutationProjectionPre` + `validateMutationBoundaryPre`；普通 `appendText` / `writeFull` 走 `withMemoryMutationPre`；设置迁移前用 `drainMemoryMutationFlightsPre` 等待在途写（`lib/index.js:3423-3448`）。新增写路径要复用这两个入口，不要裸 `writeFile`。

---

## 5. 插件内调用 LLM 的方式（Q5）

结论：插件**没有**直接 HTTP 调 LLM，也没有 `ctx.llm.complete()` 之类的非流式入口。所有"让模型干活"的功能都通过 `ctx.subagents` 启动一个后台子代理，读它的最终文本。

- 服务获取：`engine._subagents = ctx.get('subagents')`（`lib/index.js:17328`）。
- 统一启动函数 `callSubagentStartPre(subagents, providerName, opts)`（`lib/index.js:1879-1919`）：DSH 0.2.x 用 `subagents.startActivation({provider, label, request, signal, delivery})`；0.1.x 回退 `subagents.start(...)`；两者都没有则抛错。返回值统一成 `{result, dispose, localAgent?, childId}`。
- 执行体 `_runSubagentOnce(text, label, agent, timeoutMs)`：`lib/index.js:12607-12804`。
  - 工作台就绪门控（`12620-12635`）；同一 prompt 在飞去重（`12600-12605`）。
  - 并发闸门：同时在飞 ≥3 直接跳过（`12650-12653`）。
  - 归属门 `WB_GATED_JOBS`（`1810`）：greet/fold/summarize/consolidate/consolidate-logs/distill 六个写路径必须先过工作台期牌（`12681-12702`）。
  - 模型选择：`subAgentOptions(this.config, lane)`（`1834-1851`），读 `subagentModel`、`subagentProvider`、`subagentReasoningEffort`，并按任务分 `long/short` 车道取 `subagentReasoningEffortLong/Short`（`SUBAGENT_LANES`，`1785-1795`）。provider 与 model 必须成对下发，否则跨 provider 选模型会 `UNKNOWN_MODEL`（`1838-1846` 注释）。
  - 调用：`subagents.startActivation` 的 `prompt` 是 block 数组（`12721-12728`）；超时用 `AbortController` + `withTimeout`，默认 90s（`12716-12718`、`12736-12740`）。
  - 失败降级：`UNKNOWN_MODEL` / 无配置模型先回退到宿主 `agent-default-model` 重试一次（`12741-12770`），仍失败则开 30 分钟熔断（`12782-12787`）。
  - 回收：子代理结束后 `recycleSubagentSession` 把会话目录搬进备份（`12801-12803`、`12806` 起），标签前缀 `auto-memory-` 是回收判据（`lib/subagent-gc.js:33`）。
- 调用点（全部 `runSubagent(...)`）：
  - 每轮自动沉淀 `auto-memory-consolidate`：`lib/index.js:13414`；prompt 在 `13384-13412`；配额与冷却 `13272-13306`（默认 30 分钟冷却，22:00-08:00 翻倍，每日上限 8，计数落盘 `auto-consolidate-state.json`）。
  - 日志蒸馏 `auto-memory-consolidate-logs`：`13630`；`auto-memory-distill`：`13759`。
  - 长期记忆折叠 `auto-memory-fold`：`7793`（AI 折叠容量超限内容）。
  - 智能检索关键词/答案 `auto-memory-smart-kw` / `auto-memory-smart-ans`：`9699`、`9725`（带 7/12 秒超时）。
  - 工作区摘要 `auto-memory-ws-map`：`10349`；会话总结 `auto-memory-summarize`：`11052`；问候语 `auto-memory-greet`：`11323`。
- `ctx.llm` 只用于设置页模型抽屉的数据源：`/api/dsh-auto-memory/models` 调 `llm.listProviders()` / `llm.listModels(pid)`（`lib/index.js:21075-21103`）。没有用 `ctx.llm` 发请求。
- 成本边界：这些都是真实 LLM 调用，受 `autoConsolidate`、`autoConsolidateDailyMax`、`subagentModel`、30 分钟熔断与 90s 超时约束（`658-700` 附近的默认值、`12782-12787`）。新增自动沉淀类功能要复用同一配额与熔断，不要新开一条无上限的调用链。

---

## 6. client.js 的设置面板（Q6）

### 6.1 文件形态与注册方式

- `lib/client.js` 是手写的 `window.__ModuleLoader__.load({ id, factory })` bundle（`11-19`），不是 Vite/React 项目产物。界面用 React，但全部是 `React.createElement`（`h`），没有 JSX（`14-18`）。
- 依赖通过 `require('react')` / `require('react-dom')` 拿（`15-23`）；`package.json` 的 `dsh.client.inject` 声明要注入的客户端包（`package.json:31-44`）。
- 插件导出 `exports.inject = ['slots', 'sessions', 'remote', 'remote.session']`（`lib/client.js:19731`），`exports.apply = apply`（`19749`）。
- 注册入口 `function apply(ctx)`：`lib/client.js:19231`。`slides` 服务取 `ctx.slots`（`19265`），slot 注册集中在 `registerSurfaces()`（`19564-19659`）。
- 设置数据不走宿主的 settings 服务：读配置用 `apiGet(API.config)`（`11665`、`19282`），保存走**唯一写出口** `saveConfigPatch(patch)`（`3900-3921`，内部 `apiPost(API.config, ...)`，成功后 `emit()` 广播让所有设置入口重取），`save()` 只是它的调用方（`15333-15351`）；未保存草稿只存在内存 `iter5SettingsDrafts`（`11637`、`11649`），不写 localStorage。

设置相关落点（三处，同一份组件 `Iter5HostSettings`）：

| slot | 注册点 | 触发条件 |
| --- | --- | --- |
| `settings.section` | `lib/client.js:19586-19588` | `settingsEntryPre('settingsEntryInDsSettings')` |
| `settings.plugins.tab` | `19593-19595` | `settingsEntryPre('settingsEntryInPluginsPage')` |
| `plugins.detail.section` | `19603-19613` | 同上，且 `subject.pkg.name === '@a9i5k4/dsh-auto-memory'` |

另有 `sidebar.footer.action`（`19570-19574`）、`shell.overlay` 三块（`19575-19583`）、`conversation.view` 的"记忆"页与"白板看板"页（`19619-19636`）。`refreshSurfaces()`（`19707` 起）负责按配置增删入口。

### 6.2 设置 UI 的实现与重复副本

设置组件是 `Iter5HostSettings`（`14189`）包 `Iter5Settings`（`14965`）。但 `lib/client.js` 里有**两份完整的设置实现**加一份旧版：

- `11569` 的 `Iter5HostSettings` / `11639` 的 `Iter5Settings`：在某个更早的作用域里，属于旧副本。
- `14189` / `14965`：当前生效的顶层副本，`registerSurfaces` 用的就是它。
- `18216` 的 `SettingsPage()`：经典设置页，`19228` 结束，**它是生成的源**。

生效副本的分区结构：

- 分组 `i5GroupsDef`：`engine: ['engine']`、`memory: ['window','capacity','skills']`、`appearance: ['store','look','skin']`、`behavior: ['handoff','auto','team','about']`（`lib/client.js:14976`）。
- 分区标签 `sectionLabels`：`15414-15427`（注意 `team` 键写了两遍，`15423-15424`，第二行覆盖第一行）。
- 分区容器 `section(key, title, content)`：`15429-15471`；导航按钮 `15478-15480`；各分区内容从 `15482` 的 `section('engine', ...)` 开始，依次 `window`（`15720`）、`capacity`（`15805`）、`skills`（`15820`）、`handoff`（`15841`）、`auto`（`15869`）、`store`（`15961`）、`look`（`15998`）、`team`（`16034`）、`skin`（`16037`）、`about`（`16052`）。
- 表单原语：`set(key, value)` 写草稿（`15310-15316`）、`field(label, control, hint)`（`15352-15366`）、`save()` 统一 POST `/config`（`15333-15351`）。草稿按 `iter5Identity() + draftScope` 存在内存 `iter5SettingsDrafts`（`11637`、`11649`），不写 localStorage（注释明确不把可能含凭据的配置落到浏览器存储）。

### 6.3 新增一个设置分区的模板

改经典设置页 `SettingsPage()`（`lib/client.js:18216-19228`），因为 `Iter5Settings` 是它生成的。

1. `sectionLabels` 加键（经典副本在 `18584` 附近；生效副本在 `15414`，生成时会从经典切片重建）。
2. 在 `SettingsPage` 返回的分区列表里加一个 `section('yourKey', sectionLabels.yourKey, [ field(...), ... ])`，模板照 `section('window', ...)`（经典副本约 `18849` 起，对应生效副本 `15720`）。
3. 控件写 `set('configKey', value)`，label 用 `t('i18nKey')` 或 `L('中文','English')`；生成后的 `field()` 会带 `data-i5-field`，Iter5 的"基础/进阶"折叠靠这个属性分组（`15429-15470`；生成器的补丁在 `tools/build-iter5-skin.mjs:309`）。
4. 分组归属：经典 `SettingsPage` 没有分组概念，分组表由生成器注入（`tools/build-iter5-skin.mjs:216` 的 `i5GroupsDef` 字面量）。新分区要出现在某个分组下，得改这个生成器字面量（或直接改生成产物并同步回生成器），然后重新生成；否则 `hidden=true`（生成产物 `lib/client.js:15436`）。当前四个组是 `engine / memory / appearance / behavior`。
5. 需要更通俗的文案时，在 `skins/iter5/settings-copy.js` 加一行 `iter5SettingCopy` 映射（文件开头 `function iter5SettingCopy(label)`）。
6. 跑 `node tools/build-iter5-skin.mjs` 重新生成 `Iter5Settings`，再跑 `--check` 确认同步。生成器会覆盖 `lib/client.js` 的两个生成区：
   - `ITER5-LEGACY-GENERATED`：`lib/client.js:10804-13287`
   - `ITER5-GENERATED`：`lib/client.js:13288-16697`
   生成器把经典 `SettingsPage()` 切片后改名成 `Iter5Settings`（`tools/build-iter5-skin.mjs:205-206`），并做一系列 `replaceOnce` 注入。手改生成区而不改经典页/`skins/iter5/*`，下次生成会被整段还原，而静态守卫仍然全绿。`tools/build-iter5-skin.mjs:1-30` 记录了 2026-10-01 的真实事故与 R2 拦截策略。
7. 如果只改 `lib/client.js` 的生效副本而不改经典页，`--check` 会报 stale；`--force` 会明确丢弃手改。正确做法是先改经典页，再生成。

### 6.4 locale 文本如何引用

设置 UI 有三层文案：

- `I18N` 键值表：`lib/client.js:241` 起，`I18N.zh` / `I18N.en` / `I18N.ja`（`996` 起，日语缺失回落中文），读取函数 `t(key)`（`2515-2519`）。适合长度短、复用高的字段名。
- 内联双语 `L(zh, en)`（`956-962`）与 `L3(zh, en, ja)`（`963-993`）。设置页大量使用这一种，尤其新建分区。
- 插件元数据 `locale/zh.json` / `locale/en.json`（只有 `meta.title` / `meta.description`），由宿主 `readPluginMeta` 读取，`package.json` 的 `exports` 暴露 `./locale/*.json`（`package.json:19-23`）。新增设置项不需要动这两个文件。

### 6.5 skins/iter5 与设置面板的关系

- `skins/iter5/*.js/css` 是皮肤与界面源：`style-choice.js`、`alternate-home.js`、`ui.js`、`views.js`、`surfaces.js`、`native-panel.js`、`native-workbench.js`、`native-search.js`、`native-skills.js`、`native-storage.js`、`native-team.js`、`native-map.js`、`native-messages.js`、`settings-copy.js`，由 `tools/build-iter5-skin.mjs:521` 拼接进 `ITER5-GENERATED` 块；`skins/legacy/iter5-325.js.frozen` 是冻结的经典页源（`55-75`）。
- 设置页的**结构**来自经典 `SettingsPage()` 切片，**文案/皮肤**来自 `skins/iter5/settings-copy.js` 与 `skin.css` / `native-settings.css`。
- `lib/assets/skin/` 是运行时图片资源，`skin-center.js` 管槽位与主题（`SKIN_DIRS`，`lib/skin-center.js:39`），与设置分区无关。

---

## 7. 测试体系（Q7）

### 7.1 runner 与耗时

- `node tools/run-smoke.mjs` 串行/并行跑 `tests/smoke/*.mjs`，每套件默认超时 60s，默认轻车道 4 并发；重负载套件走单独车道，重车道默认 8 并发、超时 240s（`tools/run-smoke.mjs:40-53`、`80-140`）。
- `package.json`：HEAD 版本**没有** `scripts` 字段，跑测试直接 `node tools/run-smoke.mjs`。当前工作区被其他成员加入了 `"scripts": { "test": "node tools/run-smoke.mjs", ... }`（`package.json:10-16`），这是本次调研之外的工具链改动，合并前需确认保留；不要把它当作仓库原有入口。
- 运行器把 `TEMP/TMP` 指到仓库同盘的 `.dsh-smoke-tmp/run-*`，退出时整目录删除，避免系统盘残留（`tools/run-smoke.mjs:56-77`）。
- 支持 `--filter=<substring>`、`--timeout`、`--jobs`、`--lanes=off`、`--heavy-jobs`。
- 我实测（本机，2026-11-17）：
  - `node --check lib/index.js` 0.45s；`node --check lib/client.js` 0.49s。
  - `node tools/run-smoke.mjs --filter=inject`：4 个套件全部 PASS，1.5s（套件本身 0.5-0.7s）。
  - `node tools/run-smoke.mjs --filter=settings`：12 个套件全部 PASS，39.4s（最慢 `smoke-test-settings-emit-effective-config.mjs` 38.1s）。
- 全量：当前 443 个套件，其中 50 个进入重车道，重车道单跑耗时表合计约 1056.8s（`tools/run-smoke.mjs` 的 `HEAVY_MS`）。按重车道 8 并发、轻车道 4 并发估算，全量约 3-5 分钟；仓库注释记录过一次 16 核实测 179.9s（旧树 354 套件）。我没有跑全量：443 个套件会做整树临时副本并真跑 Python / 生成器，超出本次只读调研的边界。需要精确数字时在空闲机跑一次 `node tools/run-smoke.mjs`。

### 7.2 三个代表套件的写法

1. `tests/smoke/smoke-test-t1-prompt-sections.mjs`（源码取证型，0.4s）
   读 `lib/index.js` 与 `lib/client.js`，用正则截出 `PROMPT_SECTION_KEYS_PRE_V1` / `PROMPT_SECTION_MUST_PRE_V1` / `PROMPT_SECTION_TEXT`，用 `new Function` 求值字面量，断言两个集合严格相等、must 是子集、must 段有"关掉后果"文案，并做"删一个键/加一个键"的反例自检（`26-101`）。另有一段限定在 `SettingsPage` 作用域内断言 hooks 顺序（`109-116`）。零副作用，适合锁"前后端清单漂移"。

2. `tests/smoke/smoke-test-c5-tier-inject.mjs`（纯模块单测型，0.4s）
   直接 `import` `lib/tier-layer-inject.js` 与 `lib/tier0-catalog.js`，用 77 条项目条目等夹具构造真实形状语料，断言 per-layer 配额、闸门下探、降级标注、层账等不变量（`14-60`）；文件相关用例用 `mkdtempSync(tmpdir())` 建临时目录，`finally rmSync` 清理（`220-232`）。适合锁纯函数与预算契约。

3. `tests/smoke/smoke-test-inject-frame-fidelity.mjs`（生产代码抽取 + 真实帧序型，0.4s）
   从 `lib/index.js` 抽出生产决策段（`let tieredFullGranted = false` 到最后一个 `return finalizePre(...)`）和 `finalizePre` 的真实实现，拼成可执行片段，按宿主真实帧序驱动：pre-step 写请求键、帧①渲染、append `step/start`、帧②渲染（`1-45`）。断言两帧逐字节相同、含真人消息的请求必须交付完整版，并统计"未包裹的决策出口"为 0（`19` 行 PASS）。适合锁"两次 text() 调用"这类宿主契约。

补充一个设置入口守卫：`tests/smoke/smoke-test-i335-settings-entry.mjs` 用 Proxy 沙箱求值 `DEFAULT_CONFIG` 字面量，断言两个 `settingsEntry*` 键存在、默认 true、在白名单内；再从 `lib/client.js` 抽 `settingsEntryPre()` 真调用四档配置，含"双关纠正"负路径（`31-40` 起）。新增设置入口时照这个写法补一条。

---

## 8. 字面量统计与改名风险（Q8）

### 8.1 分类统计

全仓文本（排除 `.git`、`lib/assets`、`node_modules`，含 docs/tests/tools）命中 `dsh-auto-memory|auto-memory` 共 3281 处，分布在 469 个文件。代码侧热点：

| 类别 | 出现位置 | 数量/说明 |
| --- | --- | --- |
| 路由前缀 `/api/dsh-auto-memory` | `lib/index.js` 75 处、`lib/client.js` 5 处 | 宿主 API 表 73 条；客户端 `ROUTE_PREFIX` 1 处 + 表内 64 条引用 |
| 包名 `@a9i5k4/dsh-auto-memory` | `lib/index.js` 11 处、`client.js` 模块 id / plugins.detail 认领、`package.json`、`cordis.patch.yml` | 客户端 `__ModuleLoader__.load({id})`（`lib/client.js:12`）、`plugins.detail.section` 的 `pkg.name` 比较（`19610`） |
| 配置文件名 `dsh-auto-memory.json` | `lib/index.js:8` 处 | 配置路径 `2379`、错误提示、legacy 合并 `3022`、诊断 |
| 旧配置名 `dsh-auto-memory-pre.json` | 4 处 | `lib/index.js:3003-3034` |
| localStorage 键 | `lib/client.js` 40 处读写 | `dsh-auto-memory.panel.pinned/geom/pos`、`lastActive`、`seenVersion`、`fontScale.v2`、`accentTheme.v1` 等；`3660-3672` 有旧键迁移块 |
| 子代理标签 `auto-memory-*` | `lib/index.js` 11 处；回收判据 `lib/subagent-gc.js:33` | `PLUGIN_LABEL_PREFIX='auto-memory-'` 是插件会话的唯一判据 |
| 环境变量 | `DSH_AUTO_MEMORY_ALLOWED_HOSTS`（`14234` 等 7 处）、`DSH_AUTO_MEMORY_DEV/REL`（`tools/release.mjs`） | 改名要同时兼容旧变量 |
| 数据目录 | `~/.dsh/memory/*` 不含 "auto-memory" 字样；`~/.dsh/exports/dsh-auto-memory/` 含 | 导出目录 `9911`、`10010` |
| 诊断日志 | `<DSH_HOME>/dsh-auto-memory-diagnose.log`（`1719`） | 用户提 issue 时会按这个名字找 |
| 工作区根 | `<DSH_HOME>/aik_auto_memory_use`（`1783`） | 记忆中枢工作台目录，配置 `workbenchRoot` 可覆盖 |
| npm / GitHub | `registry.npmjs.org/@a9i5k4%2Fdsh-auto-memory`（`7047`）、`NOTICES_URL` 指向上游 Aik358 仓库（`341`） | 更新检查与 notices 都硬编码上游 |
| docs / 测试 | `README*` 各 60 处；105 个 smoke 套件提到字面量 | `smoke-test-api-paths`、`smoke-test-issue111-docs-real-names` 直接锁死前缀与文件名 |

### 8.2 改名时的兼容要点

这个仓库已经做过一次"去 pre"改名，现成的兼容模式可以直接抄：

- 配置名：`_mergeConfigPre` 逐键补齐旧 `dsh-auto-memory-pre.json`，同键以新名为准，只在缺键时写盘（`lib/index.js:3003-3037`）。新名字应保留同样的"读旧名 + 合并 + 幂等写"逻辑，不能只 rename 文件。
- 数据目录：`datadir.memoryDir` 对 `name-pre` 做逐文件增量补齐，失败回落旧目录，绝不 move、绝不覆盖（`lib/datadir.js:64-101`）。
- localStorage：`lib/client.js:3660-3672` 有 `legacy localStorage keys` 的迁移块，说明前端也应有旧键兼容。
- 路由：目前**没有别名机制**。换前缀意味着宿主与客户端两张表、`smoke-test-api-paths` 白名单、`smoke-test-issue111` 的硬编码断言、文档一起改。要兼容旧前端（升级过程中宿主与浏览器 bundle 可能不同步），需要在新前缀之外保留一段时间的旧前缀 handler，或让客户端 `ROUTE_PREFIX` 支持回退。
- 包名/module id：`package.json`、`cordis.patch.yml`（`- id: auto-memory-pre` / `name: '@a9i5k4/dsh-auto-memory'`）、客户端 `__ModuleLoader__.load({id})`、`plugins.detail.section` 的 `pkg.name` 比较、`dsh.client.inject` 清单，五处必须一致，否则宿主认不到客户端或设置页认领不到详情页。
- 子代理标签：`auto-memory-` 前缀是 `subagent-gc` 识别"插件自己的一次性会话"的唯一依据（`lib/subagent-gc.js:33`、`lib/index.js:12802`）。改名后旧标签的子代理会话不会被回收，需要同时匹配新旧两个前缀。
- 更新/通知：`checkUpdate` 硬编码 npm 包名（`7047`），`NOTICES_URL` 硬编码上游 GitHub raw（`341`）。改名后要么改指新仓库，要么保留旧源，否则老用户收不到更新提醒。
- 环境变量与导出目录：`DSH_AUTO_MEMORY_ALLOWED_HOSTS`、`exports/dsh-auto-memory/`、诊断日志名都会影响用户的脚本与 issue 模板；建议保留旧名读取，新名优先。
- 测试成本：105 个 smoke 套件提到字面量，其中至少 20 个直接 assert 路径/文件名/前缀。改名不是改一处常量，必须跑全量并逐条修断言（或者加兼容层让旧断言继续成立）。
- 工作台目录 `aik_auto_memory_use` 与 `workbench.json` 里的 owner/期牌绑定；改目录名会让已有工作台会话变成"孤儿"，需要迁移或保留旧目录。

---

## 9. 给实现者的最小改动清单（汇总）

新增 host 路由：
1. `API` 表加键（`lib/index.js:347-429`）。
2. `routes` 数组加 `{kind:'exact', path: API.x, handler}`，照 `API.state`（`20280-20301`）/ `API.config`（`20650-20692`）。
3. loopback 检查 + method 检查 + try/catch + `writeJson`。
4. 前端消费则同步 `lib/client.js:3678-3747`。
5. 跑 `smoke-test-api-paths`；宿主独有端点改白名单。

新增 Config 字段：
1. `DEFAULT_CONFIG`（`555-1147`）；路径型加 `validateSettingsPaths`（`lib/settings-safety.js:41-69`），其它类型加 `validateSettingsPatch`（`16-33`）。
2. 读配置用 `engine.config.key`，0 合法时不用 `||`。
3. 改默认值补一次性迁移（`3084`、`3140`）。
4. 需要 UI 时改经典 `SettingsPage()`（`lib/client.js:18216-19228`）并重新生成（第 6 节）。

新增 agent tool：
1. 在 `const tools = [...]`（`lib/index.js:18347`）里加 `defineTool('name', 'description', { params }, async (args, exec) => {...})`，模板 `memory_log`（`18348`）/ `memory_status`。
2. 写路径必须过 `sanitizeForWrite`（`lib/index.js` 的写闸门）与 `withMemoryMutationPre`；读路径用 `engine.resolvePaths(exec.agent)` / `resolvePathsForSession`。
3. 工具注册与 execute 包装在 `21198-21207`；新增工具要确认没有测试锁工具数（目前没有全局数量断言）。
4. 工具描述里写清调用时机，GUIDANCE 常量（`344`）不自动包含新工具，必要时同步。

新增系统提示词注入：
1. 静态纪律加 `renderMemoryStatic()`（`8709-8747`）。
2. 动态段加 `pushPart(...)`（`8490-8613`）+ `DEFAULT_PROMPT_LAYERS` 文案（`1154-1235`）+ 可关则加 `PROMPT_SECTION_KEYS_PRE_V1` / `MUST`（`1245-1269`）+ 前端 `PROMPT_SECTION_TEXT`（`lib/client.js:18193-18215`）。
3. 独立通道用 `ctx.systemPrompt.context`（`17551-17553`、`18304-18306`），注意两帧一致与请求键。

---

## 10. 未决与风险

- 全量 smoke 没有实际跑。报告里的 3-5 分钟是估算，仓库注释 179.9s 是旧树数据；需要精确值请在空闲机跑一次并记录。
- `docs/personalised/research-dsh-rc3-api.md` 是并行调研的 DSH API 资料，本报告不重复其内容；涉及宿主 API 的结论（section/context 作用域、非流式补全不可用）以该文为准。
- `lib/hub-message-filter.js` 与 `lib/subagent-prompt-guard.js` 未接线，`lib/index.js` 没有 import。若新方案依赖"记忆中枢不因子代理回报而重启一轮"或"子代理不主动发消息"，需要先把这两个模块接进 `apply`（或删掉，避免误以为已有防护）。
- `Iter5Settings` 是生成产物，且 `sectionLabels` 里 `team` 键重复（`lib/client.js:15423-15424`）。新增分区时如果只改生成区，下一次 `build-iter5-skin` 会覆盖；如果只改经典页不提交通道，`--check` 会红。两条路都要走完整。
- 用户级记忆没有向量检索注入，只有全量截断。要改成"按相关性注入"需要新写一条从 `state.userText` 到召回/排序/预算的链，并处理"规则段必须每轮在场"的既有约束，不能直接替换 `user-memory` 段。
- 子代理注入没有边界控制，也没有测试。个人化记忆若包含敏感偏好，子代理也会看到（全局 section + 继承工具面），需要显式决定是否在 `text(context)` 里按 `agent.session.header.origin` 返回空串（DSH 0.2.2-rc.3 支持，写法见 `research-dsh-rc3-api.md` §2.3）。
- `projectMemoryDir` 设为绝对路径时所有工作区共享一份记忆，与"项目隔离"语义冲突；改隔离方案前先确认这个兼容开关是否保留。
- 改名涉及 105 个 smoke 套件与文档锁，建议按"旧名读取 + 新名写入 + 双前缀路由 + 双标签回收"四层兼容推进，不要一次性替换。
