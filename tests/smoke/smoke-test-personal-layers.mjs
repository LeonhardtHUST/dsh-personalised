/**
 * smoke-test-personal-layers —— 三层上下文决策与渲染（G 稳定段 / P 个人记忆 / W 项目记忆）。
 *
 * 契约：docs/personalised/DESIGN.md §2。判据重点：
 *   - 子代理策略三档（instructions / none / all）+ 本插件后台子代理不给 P/W；
 *   - G 层只收 global 的 high/medium 指令，不含日期/工作区/计数，空则 ''；
 *   - P/W 层 pending 永不出现、跨工作区条目永不出现、同输入两次逐字节一致、预算硬约束。
 * 纯 Node、零依赖、不联网、不读盘。
 */
import { readFileSync } from 'node:fs'
import {
  PERSONAL_CONTEXT_NAME,
  STABLE_ORDER_PREFIX,
  STABLE_ORDER_SUFFIX,
  STABLE_SECTION_NAME,
  decideLayers,
  renderPersonalContext,
  renderStableSection,
  stableSectionOrder,
} from '../../lib/personal/layers.js'

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok - ' + name) } else { fail++; console.error('  FAIL - ' + name) } }
const eq = (a, b, name) => {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  ok(ja === jb, name + (ja === jb ? '' : ' got=' + ja + ' want=' + jb))
}

const OWN_WS = '--C-work-demo--'
const OTHER_WS = '--C-work-other--'
const entry = (id, over = {}) => ({
  id,
  kind: 'fact',
  category: 'identity',
  priority: 'medium',
  text: '默认正文 ' + id,
  scope: { type: 'global' },
  pinned: false,
  createdAt: '2026-01-0' + (id.length % 9 + 1) + 'T00:00:00.000Z',
  ...over,
})

console.log('[D1] decideLayers：子代理三档策略 / 后台子代理 / P 模式开关')
{
  eq(decideLayers({}), { stable: true, personal: true, workspace: true }, '顶层默认三层全开')
  eq(decideLayers({ personalMode: 'off' }), { stable: true, personal: false, workspace: false }, 'P 模式 off 关掉 P/W 但不关 G')
  eq(decideLayers({ instructionsEnabled: false }), { stable: false, personal: true, workspace: true }, '指令总开关只管 G')
  eq(decideLayers({ instructionsEnabled: false, personalMode: 'off' }), { stable: false, personal: false, workspace: false }, '两个开关一起关')

  eq(decideLayers({ isSubagent: true, policy: 'instructions' }), { stable: true, personal: false, workspace: false }, '子代理默认只给 G')
  eq(decideLayers({ isSubagent: true, policy: 'instructions', applyToSubagents: false }), { stable: false, personal: false, workspace: false }, 'applyToSubagents=false → 子代理连 G 都没有')
  eq(decideLayers({ isSubagent: true, policy: 'none', applyToSubagents: true }), { stable: false, personal: false, workspace: false }, 'policy=none → 什么都不给')
  eq(decideLayers({ isSubagent: true, policy: 'all' }), { stable: true, personal: true, workspace: true }, 'policy=all → G+P+W')
  eq(decideLayers({ isSubagent: true, policy: 'all', personalMode: 'off' }), { stable: true, personal: false, workspace: false }, 'policy=all 也受 P 模式总闸')
  eq(decideLayers({ isSubagent: true, policy: 'all', isOwnBackground: true }), { stable: true, personal: false, workspace: false }, '本插件后台子代理一律不给 P/W')
  eq(decideLayers({ isSubagent: true, policy: 'all', isOwnBackground: true, applyToSubagents: false }),
    { stable: false, personal: false, workspace: false }, '后台子代理 + 关指令开关 → 全关')
  eq(decideLayers({ isSubagent: true, policy: '不认识的策略' }), { stable: true, personal: false, workspace: false }, '未知策略回落 instructions')

  eq(stableSectionOrder('prefix'), STABLE_ORDER_PREFIX, 'position=prefix → order 100')
  eq(stableSectionOrder('suffix'), STABLE_ORDER_SUFFIX, 'position=suffix → order 10150')
  eq(stableSectionOrder(undefined), STABLE_ORDER_PREFIX, '缺省 prefix')
  eq(STABLE_SECTION_NAME, 'dsh-personalised:instructions', 'G 层 section 名')
  eq(PERSONAL_CONTEXT_NAME, 'dsh-personalised:personal', 'P/W 层 context 名')
}

console.log('[D2] renderStableSection：过滤 / 排序 / 字节确定性 / 空段消失')
{
  const entries = [
    entry('g1', { kind: 'instruction', priority: 'high', text: '数学推导要保留关键步骤。' }),
    entry('g2', { kind: 'instruction', priority: 'medium', text: '默认用中文回答。' }),
    entry('g3', { kind: 'instruction', priority: 'low', text: '低优先级指令应进 P 层。' }),
    entry('g4', { kind: 'instruction', priority: 'high', scope: { type: 'workspace', key: OWN_WS, path: 'C:\\work\\demo' }, text: '工作区指令只在本工作区。' }),
    entry('g5', { kind: 'pending', category: 'pending', text: '待确认的指令。' }),
    entry('g6', { kind: 'fact', text: '普通事实不进 G 层。' }),
    entry('g8', { kind: 'instruction', priority: 'high', evidence: 'unconfirmed', text: '未确认的指令不该注入。' }),
  ]
  const text = renderStableSection({ enabled: true, customText: '回答先给结论。', entries })
  ok(text.includes('回答先给结论。'), '自定义指令在 G 层首位')
  ok(text.includes('数学推导要保留关键步骤。') && text.includes('默认用中文回答。'), 'high/medium 指令入选')
  ok(!text.includes('低优先级指令应进 P 层'), 'low 优先级指令不进 G 层')
  ok(!text.includes('工作区指令'), 'workspace 指令不进 G 层')
  ok(!text.includes('待确认'), 'pending 永不进 G 层')
  ok(!text.includes('普通事实'), 'fact 不进 G 层')
  ok(!text.includes('未确认的指令'), '未确认指令即便 kind=instruction 也不进 G 层（evidence 双保险）')
  ok(text.indexOf('数学推导') < text.indexOf('默认用中文'), '高优先级排前')
  ok(!/2026|--C-work|条|共/.test(text), '不含日期/工作区/计数等易变字段')
  ok(text.endsWith('\n'), '固定以换行结尾')

  eq(renderStableSection({ enabled: true, customText: '', entries: [] }), '', '空内容 → 空串（整段消失）')
  eq(renderStableSection({ enabled: false, customText: 'x', entries }), '', 'enabled=false → 空串')
  eq(renderStableSection({ enabled: true, customText: '同一条', entries: [entry('g7', { kind: 'instruction', text: ' 同一条 ' })] }),
    renderStableSection({ enabled: true, customText: '同一条', entries: [] }), '自定义指令与记忆条目重复时只留一份')
  eq(renderStableSection({ enabled: true, customText: 'x', entries }), renderStableSection({ enabled: true, customText: 'x', entries }), '同输入两次逐字节一致')
  ok(renderStableSection({ enabled: true, customText: '带 {{变量}} 的指令' }).includes('{{变量}}'), '不插值（{{ }} 原样保留）')
}

console.log('[D3] renderPersonalContext：P/W 归属 / pending 与跨工作区隔离 / 包裹 / 预算')
{
  const entries = [
    entry('p1', { kind: 'fact', text: '项目 A 正在迁移到 rc3。' }),
    entry('p2', { kind: 'fact', text: '用户喜欢简洁的回答。' }),
    entry('p3', { kind: 'instruction', priority: 'low', text: '低优先级指令：偶尔给对比表。' }),
    entry('p4', { kind: 'instruction', priority: 'high', text: '高优先级指令已经在 G 层。' }),
    entry('w1', { scope: { type: 'workspace', key: OWN_WS, path: 'C:\\work\\demo' }, text: '本项目只用 PowerShell。' }),
    entry('w2', { kind: 'instruction', priority: 'high', scope: { type: 'workspace', key: OWN_WS, path: 'C:\\work\\demo' }, text: '本项目测试必须跑 --filter=personal。' }),
    entry('w3', { scope: { type: 'workspace', key: OTHER_WS, path: 'C:\\work\\other' }, text: '别的工作区的秘密。' }),
    entry('w4', { scope: { type: 'workspace', key: OWN_WS, path: 'C:\\work\\demo' }, kind: 'pending', category: 'pending', text: '本项目截止时间待确认。' }),
    entry('w5', { scope: { type: 'workspace', key: OWN_WS, path: 'C:\\work\\demo' }, kind: 'fact', evidence: 'unconfirmed', text: '别注入这条未确认的项目信息。' }),
  ]
  const out = renderPersonalContext({ query: '项目迁移 PowerShell 对比表', entries, wsKey: OWN_WS, topK: 8, budgetChars: 1600 })
  ok(out.text.includes('<personal_memory>') && out.text.includes('</personal_memory>'), 'P 段有 personal_memory 包裹')
  ok(out.text.includes('<workspace_memory>') && out.text.includes('</workspace_memory>'), 'W 段有 workspace_memory 包裹')
  ok(out.text.includes('项目 A 正在迁移到 rc3。'), 'global fact 进 P 层')
  ok(out.text.includes('低优先级指令'), '低优先级指令进 P 层')
  ok(!out.text.includes('高优先级指令已经在 G 层'), '高优先级指令不在 P 层重复')
  ok(out.text.includes('本项目只用 PowerShell。') && out.text.includes('本项目测试必须跑'), 'W 层收本工作区条目（含 workspace 指令）')
  ok(!out.text.includes('别的工作区的秘密'), '跨工作区条目永不出现')
  ok(!out.text.includes('截止时间待确认'), 'pending 永不出现（workspace 也不行）')
  ok(!out.text.includes('未确认的项目信息'), 'evidence=unconfirmed 的 workspace 条目也不注入')
  ok(out.personal.length + out.workspace.length <= 1600, 'P+W 正文不超预算')
  eq(out.counts.workspace, 2, 'W 命中 2 条')
  ok(out.personal.split('\n')[0].includes('项目 A'), '相关度高的条目在前')
  eq(renderPersonalContext({ query: '项目迁移 PowerShell 对比表', entries, wsKey: OWN_WS }), out, '同输入两次逐字节一致')

  const noWs = renderPersonalContext({ query: '项目', entries, wsKey: null })
  eq([noWs.workspace, noWs.text.includes('<workspace_memory>')], ['', false], '没有 wsKey → W 层为空')

  const empty = renderPersonalContext({ query: 'x', entries: [], wsKey: OWN_WS })
  eq([empty.text, empty.personal, empty.workspace], ['', '', ''], '两层都空 → text 为空串')

  const onlyPending = renderPersonalContext({ query: 'x', entries: entries.filter((e) => e.kind === 'pending'), wsKey: OWN_WS })
  eq(onlyPending.text, '', '只有 pending → 不注入')

  const tiny = renderPersonalContext({ query: '项目', entries, wsKey: OWN_WS, topK: 8, budgetChars: 120 })
  ok(tiny.personal.length + tiny.workspace.length <= 120, '小预算也守住字符上限（' + (tiny.personal.length + tiny.workspace.length) + '）')

  // W 优先拿一半预算（P 用剩下的），避免项目上下文被全局记忆挤空
  const half = renderPersonalContext({ query: '项目', entries, wsKey: OWN_WS, budgetChars: 400 })
  ok(half.workspace.length <= 200, 'W 最多先取一半预算（' + half.workspace.length + '≤200）')

  const zero = renderPersonalContext({ query: '项目', entries, wsKey: OWN_WS, budgetChars: 0 })
  eq(zero.text, '', 'budgetChars=0 → 不注入（不回落默认预算）')

  const full = renderPersonalContext({ query: '项目', entries: entries.filter((e) => e.scope.type === 'workspace' || e.id === 'p1'), wsKey: OWN_WS, budgetChars: 40 })
  ok(full.personal.length + full.workspace.length <= 40, 'W 吃满预算时 P 不会超发（' + (full.personal.length + full.workspace.length) + '≤40）')
}

console.log('[D4] 纯函数纪律')
{
  const src = readFileSync(new URL('../../lib/personal/layers.js', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/from ['"]node:/.test(code), '不读盘/不依赖 node 内置')
  ok(!/\bfetch\s*\(|Date\.now|Math\.random|toLocaleString/.test(code), '无网络/时钟/随机/本地化（渲染可复现）')
  ok(!src.startsWith('\uFEFF'), '无 BOM')
}

console.log('\n[personal-layers] pass=' + pass + ' fail=' + fail)
if (fail) process.exit(1)
console.log('PASS')
