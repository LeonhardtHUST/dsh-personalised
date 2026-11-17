/**
 * smoke-test-personal-archive —— 个性化档案格式（解析 / 渲染 / 往返）。
 *
 * 契约：docs/personalised/DESIGN.md §4；格式常量来自 lib/personal/prompts.js 的 EXPORT_PROMPT。
 * 判据纪律：每条断言在实现被改坏时都会报红（分类号映射、标签归类、围栏剥离、notes 不进条目、
 *           导出可被自己解析回来）。纯 Node、零依赖、不联网、不读宿主。
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  ARCHIVE_FORMAT_VERSION,
  CATEGORIES,
  CATEGORY_IDS,
  PRIORITIES,
  PRIORITY_RANK,
  categoryFromTitle,
  compareEntriesForRender,
  formatEntryLine,
  normalizeEvidence,
  normalizePriority,
  normalizeStatus,
  normalizeTime,
  parseArchive,
  renderArchive,
  renderJson,
} from '../../lib/personal/archive-format.js'
import * as personal from '../../lib/personal/index.js'

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok - ' + name) } else { fail++; console.error('  FAIL - ' + name) } }
const eq = (a, b, name) => {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  ok(ja === jb, name + (ja === jb ? '' : ' got=' + ja + ' want=' + jb))
}

// 带外层代码块的真实形状档案（模型按 EXPORT_PROMPT 输出时的样子）
const ARCHIVE = [
  '以下是从其他平台导出的档案：',
  '```markdown',
  '',
  '### 1. 指令与行为规则',
  '',
  '[高][明示][长期有效] 数学推导要保留关键步骤，并解释关键变换的依据。',
  '[中][归纳] 默认用中文回答。',
  '- 无标签列表行按所在分类导入。',
  '',
  '### 2. 身份与背景',
  '',
  '[中][明示] 用户是后端工程师。',
  '',
  '### 5. 项目与持续性工作',
  '',
  '[高][明示][事件:2026-10-15][进行中] 项目A：目标为迁移到 rc3；下一步补测试。',
  '〔项目:C:\\work\\demo〕该仓库只用 PowerShell 脚本。',
  '',
  '### 9. 待确认与信息缺口',
  '',
  '- 用户是否换过工作？',
  '```',
  '',
  '**完整性声明：** 基于本次会话可见的信息。',
  '**待核实事项：** 项目A 的截止时间未知。',
].join('\n')

console.log('[A1] 分类表：九类、序号 1..9、id 与 DESIGN §3 一致')
{
  eq(CATEGORIES.length, 9, '九类')
  eq(CATEGORIES.map((c) => c.index), [1, 2, 3, 4, 5, 6, 7, 8, 9], '序号 1..9')
  eq(CATEGORY_IDS, ['instructions', 'identity', 'skills', 'environment', 'projects', 'goals', 'preferences', 'corrections', 'pending'], 'id 顺序')
  ok(CATEGORIES.every((c) => c.zh && c.en && c.keywords.length > 0), '每类都有中英标题与关键词')
  eq(categoryFromTitle('1. 指令与行为规则'), 'instructions', '按序号映射')
  eq(categoryFromTitle('### 3、知识、技能与能力边界'), 'skills', '按序号 + 顿号映射')
  eq(categoryFromTitle('纠错与重要负反馈'), 'corrections', '按标题关键词映射')
  eq(categoryFromTitle('完全无关的标题'), null, '无关标题返回 null')
  eq(normalizePriority('高'), 'high', '优先级中文→存储值')
  eq(normalizePriority('low'), 'low', '优先级英文原样')
  eq(normalizePriority('urgent', null), null, '未知优先级返回 null(可判空)')
  eq(normalizeEvidence('待确认'), 'unconfirmed', '证据中文→存储值')
  eq(normalizeEvidence('inferred'), 'inferred', '证据英文原样')
  eq(normalizeStatus('进行中'), '进行中', '状态词保留')
  eq(normalizeStatus('瞎写的'), null, '未知状态→null')
  eq(normalizeTime('时间未知'), null, '“时间未知”→null')
  eq(normalizeTime('事件:2026-10-15'), '事件:2026-10-15', '时间原样保留')
  eq(PRIORITIES, ['high', 'medium', 'low'], '优先级词表')
  eq(PRIORITY_RANK.high > PRIORITY_RANK.medium && PRIORITY_RANK.medium > PRIORITY_RANK.low, true, '排序权重高>中>低')
}

console.log('[A2] parseArchive：围栏剥离 / 分类 / 标签 / 无标签列表 / workspace 前缀 / notes')
{
  const r = parseArchive(ARCHIVE)
  eq(r.entries.length, 7, '解析出 7 条（代码块外说明与完整性声明都不算条目）')
  eq(r.entries.map((e) => e.ref), ['n6', 'n7', 'n8', 'n12', 'n16', 'n17', 'n21'], 'ref 是原文 1 基行号')
  eq(r.entries[0].category, 'instructions', '第 1 条分类=instructions')
  eq([r.entries[0].priority, r.entries[0].evidence, r.entries[0].time, r.entries[0].status], ['high', 'explicit', '长期有效', null], '四段标签全部归类')
  eq(r.entries[0].text, '数学推导要保留关键步骤，并解释关键变换的依据。', '标签已剥离，正文原样')
  eq([r.entries[1].priority, r.entries[1].evidence, r.entries[1].time], ['medium', 'inferred', null], '缺时间字段时为 null')
  eq([r.entries[2].priority, r.entries[2].evidence], ['medium', 'inferred'], '无标签列表行按 medium/inferred')
  eq(r.entries[3].category, 'identity', '分类切换生效')
  eq(r.entries[4].category, 'projects', '项目分类')
  eq([r.entries[4].priority, r.entries[4].evidence, r.entries[4].time, r.entries[4].status],
    ['high', 'explicit', '事件:2026-10-15', '进行中'], '事件时间 + 状态同时命中')
  eq(r.entries[5].category, 'projects', 'workspace 条目仍在 projects 分类')
  eq(r.entries[5].scopePath, 'C:\\work\\demo', 'workspace 前缀被还原成 scopePath')
  eq(r.entries[5].text, '该仓库只用 PowerShell 脚本。', 'workspace 前缀不进正文')
  eq(r.entries[6] && r.entries[6].category, 'pending', '第 9 类 = pending')
  eq(r.entries[6] && r.entries[6].evidence, 'unconfirmed', 'pending 分类默认 unconfirmed')
  eq(r.notes.map((n) => n.kind).sort(), ['完整性声明', '待核实事项'].sort(), '说明性段落进 notes')
  ok(r.notes.every((n) => n.text && n.kind), 'notes 带正文')
  ok(r.notes.every((n) => !r.entries.some((e) => e.text.includes(n.text.slice(0, 6)))), 'notes 的正文没有混进条目')
  eq(r.warnings, [], '干净档案零警告')
}

console.log('[A3] parseArchive：无围栏 / 未知标题 / 换行续写 / 分类外条目 / 空输入')
{
  const r = parseArchive('这是一段没有分类的说明\n[高][明示] 第一条就出现')
  eq(r.entries.length, 1, '无分类时：散文被忽略，带标签条目仍解析')
  eq(r.entries[0].category, 'identity', '分类外条目落 identity')
  ok(r.warnings.some((w) => w.includes('说明文字已忽略')), '分类外散文有警告（不静默丢弃）')
  ok(r.warnings.some((w) => w.includes('不在任何分类标题下')), '分类外条目有警告')

  const cont = parseArchive(['### 1. 指令与行为规则', '[高][明示] 前半句', '后半句续写'].join('\n'))
  eq(cont.entries.length, 1, '无标签非列表行视为续写，不新增条目')
  eq(cont.entries[0].text, '前半句 后半句续写', '续写合并进上一条')

  const unknown = parseArchive(['### 42. 不存在的分类', '内容'].join('\n'))
  eq(unknown.entries[0].category, 'identity', '未知序号标题按 identity 兜底')
  ok(unknown.warnings.some((w) => w.includes('无法识别的分类标题')), '未知序号标题有警告')

  eq(parseArchive('').entries, [], '空输入无条目')
  ok(parseArchive('').warnings.length > 0, '空输入有警告（不静默）')
  eq(parseArchive(ARCHIVE).entries.length, parseArchive(ARCHIVE).entries.length, '确定性：同输入两次条数相同')
  eq(parseArchive(ARCHIVE), parseArchive(ARCHIVE), '确定性：同输入两次结果全等')
}

console.log('[A4] renderArchive：结构 / 往返 / workspace 前缀 / 空库')
{
  const parsed = parseArchive(ARCHIVE)
  const entries = parsed.entries.map((draft, i) => ({
    ...draft,
    id: 'pm_test' + i,
    kind: draft.category === 'instructions' ? 'instruction' : 'fact',
    scope: draft.scopePath ? { type: 'workspace', key: '--C-work-demo--', path: draft.scopePath } : { type: 'global' },
    createdAt: '2026-01-0' + (i + 1) + 'T00:00:00.000Z',
    updatedAt: '2026-01-0' + (i + 1) + 'T00:00:00.000Z',
  }))
  const md = renderArchive(entries, { generatedAt: '2026-11-17T20:35:00.000Z', source: 'dsh-personalised' })
  ok(md.startsWith('> ' + ARCHIVE_FORMAT_VERSION), '文首是格式标识行')
  ok(md.includes('生成时间：2026-11-17T20:35:00.000Z') && md.includes('来源：dsh-personalised'), '文首含来源与时间')
  ok(md.includes('### 1. 指令与行为规则') && md.includes('### 2. 身份与背景'), '按分类输出三级标题')
  ok(!md.includes('### 3.') && !md.includes('### 6.'), '空分类不输出标题')
  ok(md.includes('[高][明示][长期有效] 数学推导要保留关键步骤'), '行内标签顺序 = [优先级][证据][时间]')
  ok(md.includes('〔项目:C:\\work\\demo〕该仓库只用 PowerShell 脚本。'), 'workspace 条目带〔项目:path〕前缀')
  ok(md.includes('**完整性声明：**') && md.includes('**待核实事项：**'), '文末附完整性声明与待核实事项')
  ok(md.endsWith('\n') && !md.includes('\r') && !md.startsWith('\uFEFF'), 'LF 结尾、无 CRLF、无 BOM')

  const back = parseArchive(md)
  eq(back.entries.length, entries.length, '往返：条数相同')
  eq(back.notes.length > 0, true, '往返：文末说明仍进 notes')
  const before = entries.map((e) => [e.category, e.priority, e.evidence, e.time, e.status, e.text, e.scopePath || null])
  const after = back.entries.map((e) => [e.category, e.priority, e.evidence, e.time, e.status, e.text, e.scopePath || null])
  eq(after, before, '往返：全部字段一致（含 workspace 前缀还原）')
  eq(renderArchive(entries, { generatedAt: '2026-11-17T20:35:00.000Z' }), md, '渲染字节确定性（同输入两次全等）')

  const empty = renderArchive([], { generatedAt: '2026-11-17T20:35:00.000Z' })
  ok(empty.includes('（暂无条目）'), '空库导出有显式占位（不输出空壳分类）')
  eq(parseArchive(empty).entries, [], '空库导出解析回来仍是空')
}

console.log('[A5] formatEntryLine / applyOps 排序比较器 / renderJson')
{
  eq(formatEntryLine({ priority: 'low', evidence: 'inferred', text: 'a\nb' }), '[低][归纳] a b', '未知时间/状态时省略标签，换行折叠')
  eq(formatEntryLine({ priority: 'high', evidence: 'explicit', time: '时间未知', status: '已完成', text: 'x' }), '[高][明示][已完成] x', '“时间未知”不输出时间标签')
  const sorted = [
    { id: 'b', priority: 'low', createdAt: '2026-01-01T00:00:00.000Z', text: 'low' },
    { id: 'a', priority: 'high', createdAt: '2026-01-02T00:00:00.000Z', text: 'high' },
    { id: 'c', priority: 'medium', createdAt: '2026-01-01T00:00:00.000Z', text: 'medium' },
  ].sort(compareEntriesForRender)
  eq(sorted.map((e) => e.id), ['a', 'c', 'b'], '排序：优先级→createdAt→id')

  const json = renderJson([
    { id: 'pm_a', category: 'identity', priority: 'medium', evidence: 'explicit', text: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
  ], { generatedAt: '2026-11-17T20:35:00.000Z' })
  const payload = JSON.parse(json)
  eq(payload.format, ARCHIVE_FORMAT_VERSION, 'JSON 带格式标识')
  eq(payload.count, 1, 'JSON 带条数')
  eq(payload.categories.length, 9, 'JSON 带九类统计')
  eq(payload.categories.find((c) => c.id === 'identity').count, 1, '分类计数正确')
  ok(json.endsWith('\n'), 'JSON 以换行结尾')
}

console.log('[A6] 纯函数纪律：模块不读盘、不联网、不依赖宿主')
{
  const src = readFileSync(new URL('../../lib/personal/archive-format.js', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/from ['"]node:/.test(code), '无 node: 内置模块导入（纯函数）')
  ok(!/\bfetch\s*\(|require\(['"]https?/.test(code), '无网络调用')
  ok(!src.startsWith('\uFEFF'), '无 BOM')
  assert.equal(typeof parseArchive, 'function')
}

console.log('[A7] 汇总出口 lib/personal/index.js：宿主接线面齐全、无命名冲突')
{
  const functions = [
    'parseArchive', 'renderArchive', 'renderJson', 'formatEntryLine',
    'createProfileStore', 'normalizeEntry', 'deriveKind', 'makeId', 'makeBatchId', 'workspaceKey',
    'tokenize', 'bm25Scores', 'selectRelevant', 'chunkMarkdown', 'selectRelevantChunks',
    'decideLayers', 'renderStableSection', 'renderPersonalContext', 'stableSectionOrder',
    'createImporter', 'findSensitiveTypes', 'buildImportPrompt', 'parseModelJson',
    'makeLlmCall', 'assembleTextBlocks', 'buildUserMessage',
  ]
  const missing = functions.filter((name) => typeof personal[name] !== 'function')
  eq(missing, [], '所有函数导出齐全')
  const constants = [
    'PROMPTS_VERSION', 'EXPORT_PROMPT', 'IMPORT_PROMPT', 'IMPORT_OUTPUT_CONTRACT',
    'CATEGORIES', 'CATEGORY_IDS', 'PRIORITIES', 'EVIDENCE_LEVELS', 'STATUSES',
    'PROFILE_VERSION', 'MAX_BACKUPS', 'MAX_ENTRY_TEXT_CHARS',
    'STABLE_SECTION_NAME', 'PERSONAL_CONTEXT_NAME', 'STABLE_ORDER_PREFIX', 'STABLE_ORDER_SUFFIX',
    'PREVIEW_TTL_MS', 'MAX_EXISTING_CHARS', 'MERGE_THRESHOLD', 'SENSITIVE_PLACEHOLDER',
    'DEFAULT_MAX_TOKENS', 'DEFAULT_PURPOSE',
  ]
  const missingConsts = constants.filter((name) => personal[name] === undefined)
  eq(missingConsts, [], '所有常量导出齐全')
  eq(personal.STABLE_ORDER_PREFIX, 100, 'prefix order = 100')
  eq(personal.STABLE_ORDER_SUFFIX, 10150, 'suffix order = 10150')
  eq(personal.STABLE_SECTION_NAME, 'dsh-personalised:instructions', 'G 层 section 名与 DESIGN 一致')
  eq(personal.PERSONAL_CONTEXT_NAME, 'dsh-personalised:personal', 'P/W 层 context 名与 DESIGN 一致')
  ok(personal.PROMPTS_VERSION >= 1, '提示词版本号可读')
}

console.log('\n[personal-archive] pass=' + pass + ' fail=' + fail)
if (fail) process.exit(1)
console.log('PASS')
