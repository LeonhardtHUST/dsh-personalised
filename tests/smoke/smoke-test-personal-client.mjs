/**
 * C1 守卫：dsh-personalised「个性化」设置页（lib/client.js 手写区）
 *
 * 判据分层（全部源码取证型：零网络、零 DOM、零真实记忆）：
 *   A 位置   DSH-PERSONALISED 区块存在、恰在**两块 ITER5 生成区之外**、且在 function apply(ctx) 之前；
 *            并且落在生成器切片锚点（「插件挂载」注释）之后 —— 否则 build-iter5-skin 会把它当经典设置页切片走。
 *   B 契约   9 个 personal* 路由键与 docs/personalised/DESIGN.md §5 的路径逐一相等，且每个键都被组件真正消费。
 *   C 注册   settings.section id=personalised、order=26（紧跟旧记忆设置页的 25）、label 双语。
 *   D 改名   模块 id = dsh-personalised；plugins.detail.section 同时认领新旧包名（升级期两种名字都能进）。
 *   E 界面   五标签、四步向导每步一句话、1–3 分钟提示 + 取消（AbortController）、四种动作徽标、
 *            默认勾选 add/merge、合并目标原文、空/加载/错误提示、复制降级、FileReader、Blob 下载、
 *            配置只走 saveConfigPatch（唯一写出口）。
 *   F 真命令 node --check lib/client.js；tools/build-iter5-skin.mjs --check（生成区未被新区块破坏）。
 *
 * 为什么不用字符串计数当主判据：本仓踩过「注释里也有同一句话 ⇒ 裸 indexOf 恒真」的坑（见 t1 G4e），
 * 故凡涉及位置的断言都用**下标比较**，凡涉及清单的断言都用**集合比较**，并各带一条反例自检。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const CL = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   - ' + msg) } else { fail++; console.log('  FAIL - ' + msg) } }
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ')')
const diff = (want, got) => ({ missing: want.filter((k) => got.indexOf(k) < 0), extra: got.filter((k) => want.indexOf(k) < 0) })

// ── A 区块位置 ───────────────────────────────────────────────────────────────
console.log('[A] 区块位置与生成区边界')
const BEGIN = '/* ==== DSH-PERSONALISED BEGIN ==== */'
const END = '/* ==== DSH-PERSONALISED END ==== */'
eq(CL.split(BEGIN).length - 1, 1, 'A1 BEGIN 标记恰 1 处')
eq(CL.split(END).length - 1, 1, 'A2 END 标记恰 1 处')
const blkStart = CL.indexOf(BEGIN)
const blkEnd = CL.indexOf(END)
ok(blkStart > 0 && blkEnd > blkStart, 'A3 BEGIN 在 END 之前')
const block = CL.slice(blkStart, blkEnd + END.length)

const legacyBegin = CL.indexOf('// ===== ITER5-LEGACY-GENERATED:BEGIN =====')
const legacyEnd = CL.indexOf('// ===== ITER5-LEGACY-GENERATED:END =====')
const genBegins = [...CL.matchAll(/\/\/ ITER5-GENERATED:BEGIN/g)].map((m) => m.index)
const genEnds = [...CL.matchAll(/\/\/ ITER5-GENERATED:END/g)].map((m) => m.index)
eq(genBegins.length, 2, 'A4 ITER5-GENERATED:BEGIN 恰 2 处（legacy 内 1 + 外 1）')
eq(genEnds.length, 2, 'A5 ITER5-GENERATED:END 恰 2 处')
const inside = (i) => (i > legacyBegin && i < legacyEnd) || genBegins.some((b, k) => i > b && i < genEnds[k])
ok(legacyBegin > 0 && legacyEnd > legacyBegin, 'A6 legacy 生成区存在')
ok(!inside(blkStart) && !inside(blkEnd), 'A7 新区块整体在全部生成区之外（不手改生成区）')
// 生成器把「SettingsPage 起点 → 插件挂载注释」当经典设置页切片；区块必须在其右侧，否则会被派生进 Iter5Settings。
const sliceAnchor = CL.indexOf('    // ───────────────────────── 插件挂载')
const applyAt = CL.indexOf('    function apply(ctx) {')
ok(sliceAnchor > 0 && blkStart > sliceAnchor, 'A8 区块在生成器切片锚点（插件挂载注释）之后')
ok(applyAt > blkEnd, 'A9 区块在 function apply(ctx) 之前')
ok(CL.indexOf('    function SettingsPage() {') < blkStart, 'A10 区块不在经典 SettingsPage 切片里')
ok(block.indexOf('ITER5-') < 0, 'A11 区块内没有 ITER5 标记字面量（不会干扰 marker 计数）')

// ── B API 契约 ──────────────────────────────────────────────────────────────
console.log('[B] API 键与 DESIGN §5 路径')
const tableMatch = /var API = \{[\s\S]*?\n    \}/.exec(CL)
ok(!!tableMatch, 'B1 客户端 API 表可解析')
const table = tableMatch ? tableMatch[0] : ''
const pairs = [...table.matchAll(/([A-Za-z0-9_]+): ROUTE_PREFIX \+ '([^']+)'/g)].map((m) => [m[1], m[2]])
const clientPaths = Object.fromEntries(pairs)
const WANT = {
  personalState: '/personal/state',
  personalEntries: '/personal/entries',
  personalPrompts: '/personal/prompts',
  personalImportPreview: '/personal/import/preview',
  personalImportCommit: '/personal/import/commit',
  personalImportUndo: '/personal/import/undo',
  personalExport: '/personal/export',
  personalContextPreview: '/personal/context-preview',
  personalAgentsMd: '/personal/agents-md',
}
const wantKeys = Object.keys(WANT)
const gotKeys = pairs.map((p) => p[0]).filter((k) => k.indexOf('personal') === 0)
{
  const d = diff(wantKeys, gotKeys)
  eq(d.missing, [], 'B2 9 个 personal* 键全部在表里')
  eq(d.extra, [], 'B3 表里没有多余 personal* 键')
}
for (const key of wantKeys) {
  eq(clientPaths[key], WANT[key], 'B4.' + key + ' 路径与契约一致')
}
// 每个键都必须被界面消费（防「加了键但没人用」）
const used = wantKeys.filter((key) => block.indexOf('API.' + key) >= 0)
eq(used.length, wantKeys.length, 'B5 9 个键全部被组件消费（实得 ' + used.length + '）')
ok(block.indexOf('API.personalState, { sessionId') >= 0, 'B6 personalState 带 sessionId（宿主按会话解析工作区）')
ok(/apiPost\(API\.personalImportPreview, payload, controller\.signal\)/.test(block), 'B7 预览请求可取消（传 AbortController.signal）')
ok(block.indexOf('API.personalImportCommit, { previewId: data.previewId, accept: accept, edits: edits }') >= 0, 'B8 commit 传 previewId/accept/edits')
ok(block.indexOf('API.personalImportUndo, { batchId: done.batchId }') >= 0, 'B9 undo 传 batchId')
ok(block.indexOf('API.personalAgentsMd, { text: String(textPair[0] || \'\'), expectedDigest: digestRef.current }') >= 0, 'B10 AGENTS.md 写入带 expectedDigest（乐观锁）')
ok(/apiGet\(API\.personalExport, params\)/.test(block) && block.indexOf('format: formatPair[0], scope: scopePair[0]') >= 0, 'B11 导出带 format/scope')
ok(/apiGet\(API\.personalContextPreview, \{ q:/.test(block), 'B12 上下文预览带 q')
// 反例自检：少一个键时集合差异必须点名它（判据非恒真）
{
  const doctored = gotKeys.filter((k) => k !== 'personalExport')
  eq(diff(wantKeys, doctored).missing, ['personalExport'], 'B13 反例：删一个键 ⇒ missing 恰为该键')
}

// ── C 注册 ──────────────────────────────────────────────────────────────────
console.log('[C] settings.section 注册')
const persIdAt = CL.indexOf("id: 'personalised', order: 26")
ok(persIdAt > 0, 'C1 注册选项含 id=personalised 且 order=26（紧跟旧记忆设置页 order 25）')
const regAt = persIdAt > 0 ? CL.lastIndexOf("slots.inject('settings.section'", persIdAt) : -1
const regSlice = regAt > 0 ? CL.slice(regAt, persIdAt + 200) : ''
ok(regAt > CL.indexOf('function registerSurfaces() {'), 'C2 注册发生在 registerSurfaces 内')
ok(regSlice.indexOf("slots.register({ name: 'settings.section'") >= 0, 'C3 走既有注册写法（slots.register + name）')
ok(regSlice.indexOf("label: function () { return L('个性化', 'Personalisation') }") >= 0, 'C4 label 双语（本地化函数）')
ok(regSlice.indexOf('PersonalisedSettings') >= 0, 'C5 渲染 PersonalisedSettings')
ok(CL.indexOf("id: 'auto-memory-pre', order: 25") >= 0, 'C6 旧记忆设置页仍在（order 25，未被顶掉）')

// ── D 改名 ──────────────────────────────────────────────────────────────────
console.log('[D] 模块 id 与包名认领')
ok(CL.indexOf("id: 'dsh-personalised'") >= 0, 'D1 模块 id = dsh-personalised')
ok(CL.indexOf("id: '@a9i5k4/dsh-auto-memory'") < 0, 'D2 旧模块 id 已移除（无第二份注册）')
ok(CL.indexOf("subj.pkg.name !== '@a9i5k4/dsh-auto-memory'") >= 0, 'D3 plugins.detail 仍认领旧包名')
ok(CL.indexOf("&& subj.pkg.name !== 'dsh-personalised'") >= 0, 'D4 plugins.detail 同时认领新包名')
ok(CL.indexOf("if (!subj || subj.kind !== 'bundle' || !subj.pkg) return null") >= 0, 'D5 非 bundle / 无 pkg 返回 null（宿主契约）')
ok(CL.indexOf("var ROUTE_PREFIX = '/api/dsh-auto-memory'") >= 0, 'D6 路由前缀保持旧名（兼容旧数据与旧测试）')

// ── E 界面质量硬要求 ────────────────────────────────────────────────────────
console.log('[E] 五个标签页与导入向导')
for (const key of ['instructions', 'memory', 'import', 'export', 'layers']) {
  ok(block.indexOf("{ key: '" + key + "'") >= 0, "E1 标签 '" + key + "' 存在")
}
for (const fn of ['PersonalisedSettings', 'PersonalInstructionsTab', 'PersonalMemoryTab', 'PersonalImportTab', 'PersonalExportTab', 'PersonalLayersTab', 'PersonalAgentsMdEditor']) {
  ok(block.indexOf('function ' + fn + '(') >= 0, 'E2 组件 ' + fn + ' 存在')
}
for (const step of ['第 1 步', '第 2 步', '第 3 步', '第 4 步']) {
  ok(block.indexOf(step) >= 0, 'E3 向导含「' + step + '」（每步一句话说明现在做什么）')
}
ok(block.indexOf('整理档案，通常需要 1–3 分钟') >= 0, 'E4 长耗时提示写明「1–3 分钟」')
ok(block.indexOf('new AbortController()') >= 0 && block.indexOf('abortRef.current.abort()') >= 0, 'E5 长任务可取消（AbortController）')
ok(block.indexOf("L('取消', 'Cancel')") >= 0, 'E6 取消按钮文案存在')
for (const badge of ['新增', '合并', '冲突', '跳过']) {
  ok(block.indexOf("'" + badge + "'") >= 0, 'E7 动作徽标「' + badge + '」')
}
ok(block.indexOf("(action === 'add' || action === 'merge')") >= 0, 'E8 默认只勾 add/merge（conflict/skip 默认不勾）')
ok(block.indexOf('查看要合并进去的现有条目') >= 0, 'E9 合并目标可展开看原文')
ok(block.indexOf('撤销本次导入') >= 0, 'E10 提交后提供撤销按钮')
ok(block.indexOf("L('正在读取记忆…'") >= 0, 'E11 记忆页有加载提示')
ok(block.indexOf('PST.empty') >= 0 && block.indexOf("L('还没有符合条件的记忆。") >= 0, 'E12 记忆页有空状态文案')
ok(block.indexOf("h(PersonalNote, { kind: 'error' }") >= 0, 'E13 错误统一用可读的错误块')
ok(block.indexOf('disabled: !!props.disabled') >= 0 && block.indexOf("cursor: 'not-allowed'") >= 0, 'E14 按钮禁用态明确（disabled 属性 + 视觉）')
ok(block.indexOf('navigator.clipboard') >= 0 && block.indexOf('document.execCommand') >= 0, 'E15 复制有降级路径')
ok(block.indexOf('new FileReader()') >= 0, 'E16 上传 .md/.txt 用 FileReader')
ok(block.indexOf('new Blob(') >= 0 && block.indexOf('a.download =') >= 0, 'E17 下载用 Blob + a[download]')
ok(block.indexOf('apiGet(API.models)') >= 0, 'E18 模型下拉复用 GET /models')
ok(block.indexOf('apiGet(API.personalPrompts)') >= 0, 'E19 第 1 步提示词来自宿主（不硬编码第二份）')
ok(block.indexOf('saveConfigPatch(patch, {') >= 0, 'E20 配置写入走 saveConfigPatch 唯一出口')
ok(block.indexOf('apiPost(API.config') < 0, 'E21 区块内没有绕过 write 出口的 POST /config')
ok(block.indexOf('var(--dsw-alias-brand-primary') >= 0 && block.indexOf('var(--dsw-alias-border-l1') >= 0 && block.indexOf('var(--dsw-alias-state-error-primary') >= 0, 'E22 样式用 DSH 主题令牌（深浅色可读）')
ok((block.match(/Array\.isArray\(/g) || []).length >= 8, 'E23 响应用例容错（Array.isArray 兜底 ≥8 处）')
ok(block.indexOf('customInstructionsEnabled') >= 0 && block.indexOf('personalTopK') >= 0 && block.indexOf('personalBudgetChars') >= 0 && block.indexOf('personalSubagentPolicy') >= 0 && block.indexOf('userMemoryInjectMode') >= 0, 'E24 分层/指令配置键接入界面')
ok(block.indexOf("L('个性化', 'Personalisation')") >= 0, 'E25 页面标题用「个性化」')

// ── F 真命令 ────────────────────────────────────────────────────────────────
console.log('[F] 真命令：语法 + 生成区自洽')
let syntaxOk = true
let syntaxMsg = ''
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'lib', 'client.js')], { stdio: 'pipe' })
} catch (e) {
  syntaxOk = false
  syntaxMsg = String((e && e.stderr) || e).slice(0, 400)
}
ok(syntaxOk, 'F1 node --check lib/client.js 通过' + (syntaxOk ? '' : ' -> ' + syntaxMsg))
let genOk = true
let genMsg = ''
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-iter5-skin.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' })
  genMsg = String(out)
  genOk = genMsg.indexOf('SYNC-OK') >= 0
} catch (e) {
  genOk = false
  genMsg = String((e && e.stderr) || e).slice(0, 400)
}
ok(genOk, 'F2 tools/build-iter5-skin.mjs --check 通过（生成区未被新区块破坏）' + (genOk ? '' : ' -> ' + genMsg))

// ── G 真执行：把区块装进沙箱，真调用每个组件（React hooks 桩） ─────────────
// 目的：node --check 只能证明语法；这里证明**渲染期**不抛错（未定义标识符 / 读 undefined 属性
// 这类错误静态守卫看不见 —— 本仓 2026-09-27 就是被同一类问题放过去的，见 smoke-test-client-loadable 头注释）。
console.log('[G] 组件真执行（hooks 桩）')
function makeHookHarness() {
  let cursor = 0
  const states = []
  const hooks = {
    useState: (initial) => {
      const i = cursor++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], (v) => { states[i] = v }]
    },
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  return {
    hooks,
    // 每次「挂载」清空状态槽：否则上一个组件的第 N 个 hook 值会被下一个组件读到（桩的串味不是产线问题）。
    start: () => { cursor = 0; states.length = 0 },
    element: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  }
}
function buildBlockSandbox(extra) {
  const names = ['h', 'L', 'L3', 't', 'apiGet', 'apiPost', 'API', 'saveConfigPatch', 'currentSessionIdClient', 'configOf', 'useState', 'useEffect', 'useRef', 'console']
  const exports = ['PersonalisedSettings', 'PersonalInstructionsTab', 'PersonalMemoryTab', 'PersonalImportTab', 'PersonalExportTab', 'PersonalLayersTab', 'PersonalAgentsMdEditor']
  const body = block + '\nreturn { ' + exports.map((name) => name + ': ' + name).join(', ') + ' }\n'
  return new Function(...names, body)(...names.map((name) => extra[name]))
}
{
  const harness = makeHookHarness()
  const noop = () => {}
  const env = {
    h: harness.element,
    L: (zh, en) => zh,
    L3: (zh) => zh,
    t: (k) => k,
    apiGet: () => Promise.resolve({}),
    apiPost: () => Promise.resolve({}),
    API: { config: '/c', models: '/m', personalState: '/s', personalEntries: '/e', personalPrompts: '/p', personalImportPreview: '/ip', personalImportCommit: '/ic', personalImportUndo: '/iu', personalExport: '/ex', personalContextPreview: '/cp', personalAgentsMd: '/a' },
    saveConfigPatch: () => Promise.resolve({}),
    currentSessionIdClient: () => 'sess-test',
    configOf: (d) => (d && d.config) || {},
    useState: harness.hooks.useState,
    useEffect: harness.hooks.useEffect,
    useRef: harness.hooks.useRef,
    console: { log: noop, warn: noop, error: noop },
  }
  let api = null
  let loadErr = ''
  try { api = buildBlockSandbox(env) } catch (e) { loadErr = String(e && e.message ? e.message : e) }
  ok(!loadErr, 'G1 区块可装入沙箱（不抛）' + (loadErr ? ' -> ' + loadErr : ''))
  const draft = {
    customInstructionsEnabled: true, customInstructions: '回答先给结论', customInstructionsPosition: 'prefix', customInstructionsSubagents: true,
    personalInjectMode: 'relevant', personalTopK: 8, personalBudgetChars: 1600, personalSubagentPolicy: 'instructions', userMemoryInjectMode: 'relevant',
  }
  const cases = [
    ['PersonalisedSettings', () => api.PersonalisedSettings({})],
    ['PersonalInstructionsTab', () => api.PersonalInstructionsTab({ draft: draft, setKey: noop, state: { instructions: { chars: 42 } } })],
    ['PersonalMemoryTab', () => api.PersonalMemoryTab({ state: { workspace: { key: 'k', path: 'C:/ws' } }, onChanged: noop })],
    ['PersonalMemoryTab(no ws)', () => api.PersonalMemoryTab({ state: null, onChanged: noop })],
    ['PersonalImportTab', () => api.PersonalImportTab({ state: { workspace: { key: 'k', path: 'C:/ws' }, importModel: { provider: 'deepseek', model: 'chat' } }, sessionId: 's', onImported: noop })],
    ['PersonalImportTab(no state)', () => api.PersonalImportTab({ state: null, sessionId: 's', onImported: noop })],
    ['PersonalExportTab', () => api.PersonalExportTab({ state: { workspace: null } })],
    ['PersonalLayersTab', () => api.PersonalLayersTab({ draft: draft, setKey: noop, sessionId: 's' })],
    ['PersonalAgentsMdEditor', () => api.PersonalAgentsMdEditor()],
  ]
  for (const [name, run] of cases) {
    harness.start()
    let err = ''
    let out = null
    try { out = run() } catch (e) { err = String(e && e.message ? e.message : e) }
    ok(!err && !!out && !!out.type, 'G2 ' + name + ' 渲染不抛且返回元素' + (err ? ' -> ' + err : ''))
  }
  // 负路径自检：同一判据必须能捕到渲染期 ReferenceError / 属性读取错误
  harness.start()
  let caught = ''
  try { api.PersonalInstructionsTab({ draft: {}, setKey: noop }) } catch (e) { caught = String(e && e.message ? e.message : e) }
  ok(caught === '', 'G3 规则：缺省 props 也不抛（防御到位）')
  const boom = new Function('h', 'return function Boom(){ return h("div", null, undefinedThing.x) }')(harness.element)
  let boomErr = ''
  try { boom() } catch (e) { boomErr = String(e && e.message ? e.message : e) }
  ok(boomErr.indexOf('undefinedThing') >= 0, 'G4 反例：渲染期未定义标识符确实被捕获（判据非恒真）')
}

console.log('\n[C1 personal client] ' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
