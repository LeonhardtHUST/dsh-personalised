# DSH 0.2.2-rc.3 兼容性审计（2026-11-17）

`$AI` = `…\resources\app.asar\dsh\node_modules\@deepseek-ai`，`$DOCS` = `$AI\dsh\docs`。

## P0

**P0-1 `startActivation()` 仍传 rc2 的嵌套 `request`。** `lib/index.js:1886-1900` 的 `callSubagentStartPre()` 把 `prompt/parent/cwd/agentPreset/agentOptions/maxDepth` 包在 `request` 里。rc3 已拍平（`$AI\dsh-subagent\src\types.ts:29,144-191`；`$DOCS\upgrade-guide\v0.2.1-rc.2\subagent-activation-options\guide.md:12,16`），`startActivation` 首行读 `spec.parent.id`（`$AI\dsh-subagent\src\index.ts:275`）直接 `TypeError`，被 `lib/index.js:12773-12788` 的 catch 吞掉。结果：所有 `auto-memory-*` 子代理（自动沉淀、问候、折叠、智能检索、总结）在 rc3 上静默失效，且不触发熔断。
修复：字段平铺到外层，`signal` 必填（缺省新建 AbortController）。同步改 `tests/smoke/smoke-test-host021-migration.mjs:74-75`（它锁定了错误契约）。

## P1

**P1-1 `activation.localAgent` 在 rc3 不存在。** `lib/index.js:1911-1912` 取 `localAgent/agent/handle.agent`，rc3 返回 `{childId, name, messageId?, result, dispose}`（`$AI\dsh-subagent\src\types.ts:49-66`）。后果：`_ownSubagents` 不登记（`:12732`），pre-step/turn-stopping 的套娃防护失效（`:17410`、`:17492`），子代理会话不回收（`:12801`）。修复：用 `ctx.get('agents').get(activation.childId)` 反查（`$AI\dsh-subagent\README.md:151`）。

**P1-2 用 `header.parentSession` 判子代理。** `lib/context-host.js:342`、`lib/shadow-host.js:247`。rc3 普通 fork 不再写该字段（`$DOCS\upgrade-guide\v0.2.1-rc.3\independent-session-forks\guide.md:12,21`）。修复：改用 `origin==='subagent' || delegationDepth>0`（同 `lib/index.js:1694` `isSubAgentSession`）。

## P2

- **P2-1** `subagents.list()` 已删除（`lib/index.js:10618/12371/12707`），provider 枚举恒空，回退 `spawn` 仍可用。改用 `getProvider(name)` 探测。
- **P2-2** 诊断探针按 rc2 API 名（`start/startContinuable/drainContinuableChildren…`）探测（`lib/index.js:12382-12447`），rc3 下恒报 absent。改探测 `startActivation/sendMessage/interrupt/drainDescendants/waitForChildren/getProvider/listDescendants/rootOf/namesOf`。
- **P2-3** `settings.yaml` 兜底路径已被 rc3 一次性导入改名（`lib/index.js:1605`），死代码，无功能影响。
- **P2-4** `lib/client.js` 的 `exports.inject` 缺 `'locale'`，组合里没有 locale 服务时界面语言回落中文。

## 已核对无问题

`system-prompt/assemble`、`agent/request`、`parentAgent`、`LlmError`、`modelSelection` 均无命中；`systemPrompt.section/context`、`webServer.register`、`tools.register`、`agent/pre-step`、`agent/turn-stopping`、session header 字段、client 侧 require（仅 react/react-dom）与 6 类 slot 契约均与 rc3 一致；rc3 的 runtime-context `<system-reminder>` 文本经 `stripRuntimeIntentPre` 实测仍能正确剥除。

## 新代码注意

`lib/personal/llm-call.js` 调 `ctx.llm` 时要传 `purpose`；rc3 要求用途由生产方声明（`$DOCS\upgrade-guide\v0.2.2-alpha.2\llm-request-purpose-declarations\guide.md`），JS 插件无类型层，运行期传字符串即可。

## 限制

结论来自 rc3 源码与文档加纯函数实测，未在运行中的 DSH 里触发真实子代理调用。本机全量 smoke 有 25/448 个既有失败（缺 python、变异锚点漂移等），与 rc3 无关。
