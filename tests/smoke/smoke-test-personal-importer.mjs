/**
 * smoke-test-personal-importer —— 导入器（parse / model 两种模式 + 提交 + 撤销）。
 *
 * 契约：docs/personalised/DESIGN.md §5。
 * 判据重点：
 *   - parse 模式确定性去重（完全重复→skip，Jaccard≥0.8 且同类→merge）、敏感信息→skip；
 *   - model 模式组装 IMPORT_PROMPT + 输出约定 + 〈现有记忆〉+〈待导入档案 n<行号> 标记〉；
 *   - 代码块包裹的 JSON 能解析，非法 JSON 降级 parse 并留 warning；
 *   - merge/conflict 映射到 targetId；commit→undo 整库往返；
 *   - previewId 缺失/过期 → 410 语义。
 * 用临时目录与虚构数据；llmCall 是假函数，不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MAX_EXISTING_CHARS,
  PREVIEW_TTL_MS,
  SENSITIVE_PLACEHOLDER,
  buildImportPrompt,
  createImporter,
  findSensitiveTypes,
  normalizeComparable,
  parseModelJson,
  textSimilarity,
} from '../../lib/personal/importer.js'
import { IMPORT_OUTPUT_CONTRACT, IMPORT_PROMPT } from '../../lib/personal/prompts.js'
import { createProfileStore, workspaceKey } from '../../lib/personal/profile-store.js'
import { renderArchive } from '../../lib/personal/archive-format.js'
import { renderPersonalContext, renderStableSection } from '../../lib/personal/layers.js'

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok - ' + name) } else { fail++; console.error('  FAIL - ' + name) } }
const eq = (a, b, name) => {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  ok(ja === jb, name + (ja === jb ? '' : ' got=' + ja + ' want=' + jb))
}

const root = mkdtempSync(path.join(tmpdir(), 'personal-importer-'))
const WS_PATH = 'C:\\work\\demo'
const WS_KEY = workspaceKey(WS_PATH)

let clock = Date.parse('2026-11-17T20:35:00.000Z')
const now = () => clock
const fixedIso = () => new Date(clock).toISOString()

let storeSeq = 0
function makeStore() {
  storeSeq += 1
  return createProfileStore({ dir: path.join(root, 'store' + storeSeq), now })
}

const PARSE_ARCHIVE = [
  '### 1. 指令与行为规则',
  '[高][明示][长期有效] 回答先给结论。',
  '[低][归纳] 用户偶尔做前端。',
  '### 2. 身份与背景',
  '[中][明示] 用户是后端工程师，长期常驻上海。',
  '- 用户邮箱：foo@example.com',
  '- 用户手机号 13800138000',
  '### 5. 项目与持续性工作',
  '〔项目:' + WS_PATH + '〕本项目用 PowerShell。',
  '',
  '**完整性声明：** 基于本次会话可见的信息。',
].join('\n')

try {
  console.log('[I1] 敏感信息 / 相似度 / JSON 解析等纯辅助')
  {
    ok(findSensitiveTypes('key sk-' + 'a'.repeat(24)).includes('API 密钥'), '识别 API 密钥')
    ok(findSensitiveTypes('邮箱 foo@example.com').includes('邮箱'), '识别邮箱')
    ok(findSensitiveTypes('手机号 13800138000').includes('手机号'), '识别手机号')
    ok(findSensitiveTypes('身份证 11010519491231002X').includes('身份证号'), '识别身份证号')
    ok(findSensitiveTypes('卡号 6222020200112233445').includes('银行卡号'), '识别银行卡号')
    ok(findSensitiveTypes('密码：hunter2hunter2').includes('口令/密钥字段'), '识别口令字段')
    eq(findSensitiveTypes('普通的一条记忆'), [], '普通文本不误报')
    eq(findSensitiveTypes(null), [], 'null 安全')

    ok(normalizeComparable(' 用户，喜欢  简洁！ ') === '用户喜欢简洁', '规范化去掉空白与标点')
    ok(textSimilarity('用户是后端工程师', '用户是后端工程师') === 1, '完全相同 → 1')
    const near = textSimilarity('用户是后端工程师，常驻上海。', '用户是后端工程师，长期常驻上海。')
    ok(near >= 0.8 && near < 1, '近似文本相似度落在 [0.8,1)（' + near.toFixed(3) + '）')
    eq(textSimilarity('项目 A', '天气不错'), 0, '无关文本 → 0')

    eq(parseModelJson('{"entries":[]}').ok, true, '裸 JSON 可解析')
    const fenced = parseModelJson('```json\n{"a":1}\n```')
    ok(fenced.ok && fenced.value.a === 1, '代码块包裹的 JSON 可解析')
    const prose = parseModelJson('好的，结果如下：\n{"b":2}\n以上。')
    ok(prose.ok && prose.value.b === 2, '首尾有散文时取首个 { 到最后一个 }')
    eq(parseModelJson('不是 JSON').ok, false, '非 JSON → 失败（由调用方降级）')
    eq(parseModelJson('[]').ok, false, '顶层数组不接受')
    eq(parseModelJson('').ok, false, '空输出不接受')
  }

  console.log('[I2] parse 模式：去重（skip/merge/add）、敏感跳过、workspace 作用域、报告')
  {
    const store = makeStore()
    const exact = await store.upsert({ category: 'instructions', priority: 'high', evidence: 'explicit', text: '回答先给结论。' })
    const near = await store.upsert({ category: 'identity', priority: 'medium', evidence: 'explicit', text: '用户是后端工程师，常驻上海。' })
    const project = await store.upsert({ category: 'projects', text: '本项目旧记录。', scope: { type: 'workspace', key: WS_KEY, path: WS_PATH } })
    const before = (await store.list()).length

    const importer = createImporter({ store, now, ttlMs: 60000 })
    const preview = await importer.preview({
      text: PARSE_ARCHIVE,
      mode: 'parse',
      workspace: { key: WS_KEY, path: WS_PATH },
      platform: 'chatgpt',
    })
    eq(preview.ok, true, 'preview 成功')
    eq(preview.mode, 'parse', 'mode=parse')
    eq(preview.usedModel, null, '本地解析没有 usedModel')
    ok(/^pv_/.test(preview.previewId), 'previewId 形如 pv_*')
    eq(preview.items.length, 6, '6 条候选')
    const byText = (needle) => preview.items.find((item) => item.entry.text.includes(needle))
    const byReason = (needle) => preview.items.find((item) => item.reason.includes(needle))
    eq(byText('回答先给结论').action, 'skip', '完全重复 → skip')
    eq(byText('回答先给结论').targetId, exact.entry.id, 'skip 仍给出重复目标 id（UI 可展示）')
    eq(byText('长期常驻上海').action, 'merge', '同分类高相似 → merge')
    eq(byText('长期常驻上海').targetId, near.entry.id, 'merge 指向现有条目')
    eq(byText('长期常驻上海').existing.id, near.entry.id, 'merge 带回现有条目快照')
    eq(byReason('邮箱').action, 'skip', '邮箱条目 → skip')
    eq(byReason('邮箱').entry.text, SENSITIVE_PLACEHOLDER, '敏感条目正文替换成占位符（不回显原值）')
    ok(byReason('邮箱').reason.includes('邮箱'), 'skip 原因写明敏感类型')
    eq(byReason('手机号').action, 'skip', '手机号条目 → skip')
    eq(byText('偶尔做前端').action, 'add', '低优先级指令 → add')
    eq(byText('偶尔做前端').entry.kind, 'instruction', '低优先级指令 kind=instruction（P 层按相关性注入）')
    eq(byText('PowerShell').action, 'add', 'workspace 条目 → add')
    eq(byText('PowerShell').entry.scope.type, 'workspace', '〔项目:path〕还原成 workspace 作用域')
    eq(byText('PowerShell').entry.scope.key, WS_KEY, '作用域 key 与本机 wsKey 一致')
    eq(byText('PowerShell').entry.source.type, 'import', '来源标记 import')
    eq(byText('PowerShell').entry.source.platform, 'chatgpt', '平台透传')
    ok(preview.report.summary.includes('新增 2') && preview.report.summary.includes('合并 1') && preview.report.summary.includes('跳过 3'),
      '报告统计与 action 一致（' + preview.report.summary + '）')
    ok(preview.report.notes.some((note) => note.includes('完整性声明')), '档案说明性段落进 report.notes')
    eq((await store.list()).length, before, 'preview 不写库')
    eq(preview.warnings, [], '干净档案零 warning')
    eq(byText('PowerShell').entry.id.startsWith('pm_'), true, 'preview 条目已有稳定 id（提交直接沿用）')
    eq(project.entry.scope.key, WS_KEY, '（夹具）项目条目作用域正确')
  }

  console.log('[I3] model 模式：提示词组装 / 代码块 JSON / action-target 映射')
  {
    const store = makeStore()
    const existingInstruction = await store.upsert({
      category: 'instructions', priority: 'high', evidence: 'explicit', text: '回答先给结论。',
    })
    const existingProject = await store.upsert({
      category: 'projects', text: '本项目旧记录。', scope: { type: 'workspace', key: WS_KEY, path: WS_PATH },
    })
    const existingIdentity = await store.upsert({ category: 'identity', text: '用户是后端工程师。' })
    const calls = []
    const modelJson = {
      entries: [
        { ref: 'n2', category: 'instructions', priority: 'high', evidence: 'explicit', text: '回答先给结论，再给推导。', scope: 'global', action: 'add', target: null, reason: '新增' },
        { ref: 'n9', category: 'projects', priority: 'medium', evidence: 'inferred', text: '本项目改用 PowerShell 7。', scope: 'workspace', action: 'merge', target: existingProject.entry.id, reason: '合并项目约定' },
        { ref: 'n2', category: 'identity', priority: 'medium', evidence: 'unconfirmed', text: '用户可能换过工作。', scope: 'global', action: 'conflict', target: existingIdentity.entry.id, reason: '冲突待确认' },
        { ref: 'n4', category: 'projects', text: SENSITIVE_PLACEHOLDER, action: 'skip', reason: '重复' },
      ],
      report: { summary: '模型整理完成', merged: '1 条合并', conflicts: '1 条冲突', omissions: '无' },
    }
    const llmCall = async (options) => {
      calls.push(options)
      return { text: '```json\n' + JSON.stringify(modelJson) + '\n```', warnings: [] }
    }
    const importer = createImporter({ store, llmCall, now, ttlMs: 60000 })
    const preview = await importer.preview({
      text: PARSE_ARCHIVE,
      mode: 'model',
      provider: 'deepseek',
      model: 'deepseek-v4',
      workspace: { key: WS_KEY, path: WS_PATH },
    })
    eq(preview.ok, true, 'model 模式 preview 成功')
    eq(preview.mode, 'model', 'mode=model')
    eq(preview.usedModel, { provider: 'deepseek', model: 'deepseek-v4' }, 'usedModel 回显')
    eq(calls.length, 1, 'llmCall 调用一次')
    eq(calls[0].provider + '/' + calls[0].model, 'deepseek/deepseek-v4', 'provider/model 透传')
    eq(calls[0].system, IMPORT_PROMPT, 'system = IMPORT_PROMPT')
    eq(calls[0].purpose, 'dsh-personalised-import', 'purpose 声明用途')
    ok(calls[0].prompt.includes(IMPORT_OUTPUT_CONTRACT.slice(0, 20)), 'prompt 含输出约定')
    ok(calls[0].prompt.includes('## 现有记忆（id|category|text）'), 'prompt 含现有记忆小节')
    ok(calls[0].prompt.includes(existingProject.entry.id + '|projects|本项目旧记录。'), '现有记忆是 id|category|text 紧凑列表')
    ok(/n2\|\[高\]\[明示\]\[长期有效\] 回答先给结论。/.test(calls[0].prompt), '待导入档案行首有 n<行号> 标记')
    ok(preview.promptSize === undefined, '（不把大 prompt 回显到响应里）')

    eq(preview.items.length, 4, '模型 4 条全部映射')
    const [addItem, mergeItem, conflictItem, skipItem] = preview.items
    eq([addItem.action, addItem.targetId], ['add', null], 'add 无 target')
    eq([mergeItem.action, mergeItem.targetId], ['merge', existingProject.entry.id], 'merge 指向现有 id')
    eq(mergeItem.existing.text, '本项目旧记录。', 'merge 带回现有条目')
    eq([conflictItem.action, conflictItem.targetId], ['conflict', existingIdentity.entry.id], 'conflict 指向现有 id')
    eq([skipItem.action, skipItem.targetId], ['skip', null], 'skip 保持 skip')
    eq(addItem.ref, 'n2', 'ref 回填到条目（可溯源）')
    eq(mergeItem.entry.scope.type, 'workspace', '模型要求 workspace → 落到目标工作区')
    eq(mergeItem.entry.scope.key, WS_KEY, 'workspace key 正确')
    eq(preview.report.summary, '模型整理完成', '模型 report.summary 透传')
    eq(preview.report.conflicts, '1 条冲突', '模型 report.conflicts 透传')
    eq(preview.report.notes.length, 1, '档案说明性段落进 report.notes')
    ok(!preview.report.notes[0].includes('**'), '说明性段落文本已清洗（无 Markdown 星号）')
  }

  console.log('[I4] model 模式：非法 JSON 降级 parse + warning；调用失败 502；无模型 400')
  {
    const store = makeStore()
    await store.upsert({ category: 'identity', text: '用户是后端工程师。' })
    const badLlm = async () => '抱歉，我无法输出 JSON。'
    const importer = createImporter({ store, llmCall: badLlm, now })
    const preview = await importer.preview({
      text: PARSE_ARCHIVE, mode: 'model', provider: 'p', model: 'm', workspace: { key: WS_KEY, path: WS_PATH },
    })
    eq(preview.ok, true, '降级后仍然返回可用预览')
    eq(preview.mode, 'parse', '降级后 mode=parse')
    eq(preview.usedModel, { provider: 'p', model: 'm' }, 'usedModel 仍记录实际调用过的模型')
    ok(preview.warnings.some((w) => w.includes('不是合法 JSON') && w.includes('降级')), 'warning 说明降级原因')
    ok(preview.items.some((item) => item.action === 'skip'), '降级后走 parse 去重（仍能识别重复）')

    const failLlm = async () => { const e = new Error('密钥无效'); e.code = 'AUTH'; throw e }
    const failImporter = createImporter({ store, llmCall: failLlm, now })
    const failed = await failImporter.preview({ text: PARSE_ARCHIVE, mode: 'model', provider: 'p', model: 'm' })
    eq([failed.ok, failed.status, failed.code], [false, 502, 'AUTH'], '模型调用失败 → 502 + 原错误码')

    const parseOnly = createImporter({ store, now })
    eq((await parseOnly.preview({ text: PARSE_ARCHIVE, mode: 'model', provider: 'p', model: 'm' })).status, 400, '没配 llmCall 时 model 模式 400')
    eq((await parseOnly.preview({ text: PARSE_ARCHIVE, mode: 'model' })).status, 400, '缺 provider/model 时 400')
    eq((await parseOnly.preview({ text: '   ' })).status, 400, '空档案 400')
  }

  console.log('[I5] commit：默认接受 add/merge、edits 覆盖、conflict 需显式接受、快照与撤销')
  {
    const store = makeStore()
    const seeded = await store.upsert({ category: 'projects', text: '本项目旧记录。', scope: { type: 'workspace', key: WS_KEY, path: WS_PATH } })
    const identitySeed = await store.upsert({ category: 'identity', text: '用户是后端工程师。' })
    const before = (await store.list()).length

    const llmCall = async () => ({
      text: JSON.stringify({
        entries: [
          { ref: 'n2', category: 'identity', priority: 'high', text: '用户是资深后端工程师。', action: 'add', scope: 'global' },
          { ref: 'n9', category: 'projects', text: '本项目改用 PowerShell 7。', action: 'merge', target: seeded.entry.id, scope: 'workspace' },
          { ref: 'n5', category: 'identity', evidence: 'unconfirmed', text: '用户可能换过工作。', action: 'conflict', target: identitySeed.entry.id },
        ],
        report: { summary: 's', merged: 'm', conflicts: 'c', omissions: 'o' },
      }),
    })
    const importer = createImporter({ store, llmCall, now, ttlMs: 60000 })
    const preview = await importer.preview({ text: PARSE_ARCHIVE, mode: 'model', provider: 'p', model: 'm', workspace: { key: WS_KEY, path: WS_PATH } })
    eq(preview.items.map((item) => item.action), ['add', 'merge', 'conflict'], '三条候选动作')

    const committed = await importer.commit({
      previewId: preview.previewId,
      edits: { t1: { text: '编辑后的第一条。' } },
    })
    eq(committed.ok, true, 'commit 成功')
    ok(/^batch_/.test(committed.batchId), 'batchId 形如 batch_*')
    eq([committed.added, committed.merged, committed.skipped], [1, 1, 1], '默认接受 add/merge，conflict 计为跳过')
    const after = await store.list()
    eq(after.length, before + 1, '只新增 1 条（merge 是更新不是新增）')
    eq(after.find((entry) => entry.text === '编辑后的第一条。').id.length > 0, true, 'edits 覆盖生效')
    eq(after.find((entry) => entry.id === seeded.entry.id).text, '本项目改用 PowerShell 7。', 'merge 更新目标条目')
    eq(after.find((entry) => entry.id === seeded.entry.id).scope.key, WS_KEY, 'merge 保留目标作用域（不升级为 global）')
    const touched = after.filter((entry) => entry.id === seeded.entry.id || entry.text === '编辑后的第一条。')
    ok(touched.length === 2 && touched.every((entry) => entry.source.batchId === committed.batchId), '批次 id 写进被导入条目的 source.batchId')
    eq(importer.previewCount(), 0, '提交后预览被消费（不能重复提交）')
    eq((await importer.commit({ previewId: preview.previewId })).status, 410, '重复提交 → 410')

    const undone = await importer.undo({ batchId: committed.batchId })
    eq([undone.ok, undone.restored], [true, before], 'undo 恢复到导入前条数')
    eq((await store.list()).length, before, '撤销后库回到导入前')
    eq((await importer.undo({ batchId: 'batch_missing' })).status, 404, '不存在的批次 → 404')
    eq((await importer.undo({})).status, 400, '缺 batchId → 400')

    // conflict 显式接受 → 作为新增保留（不覆盖现有事实）
    const preview2 = await importer.preview({ text: PARSE_ARCHIVE, mode: 'model', provider: 'p', model: 'm' })
    const conflictTemp = preview2.items.find((item) => item.action === 'conflict')
    const accepted = await importer.commit({ previewId: preview2.previewId, accept: [conflictTemp.tempId, 't999'] })
    eq([accepted.ok, accepted.added, accepted.merged], [true, 1, 0], '显式接受 conflict → 作为新增保留')
    ok(accepted.warnings.some((warning) => warning.includes('t999')), '未知 accept id 有 warning（不静默忽略）')
    ok((await store.list()).some((entry) => entry.text === '用户可能换过工作。'), '冲突条目入库且不影响原条目')
  }

  console.log('[I6] previewId 过期 410 / workspace 降级 warning / 现有记忆列表截断')
  {
    const store = makeStore()
    const importer = createImporter({ store, now, ttlMs: 1000 })
    const preview = await importer.preview({ text: PARSE_ARCHIVE, mode: 'parse' })
    clock += 1500
    eq((await importer.commit({ previewId: preview.previewId })).status, 410, '超过 ttl 的预览提交 → 410')
    eq(importer.previewCount(), 0, '过期预览被清理')
    clock = Date.parse('2026-11-17T20:35:00.000Z')

    // 模型要求 workspace 但本次导入没有绑定工作区 → 降级 global + warning
    const llmCall = async () => ({ text: JSON.stringify({ entries: [{ ref: 'n2', category: 'projects', text: '只属于某项目', action: 'add', scope: 'workspace' }] }) })
    const modelImporter = createImporter({ store, llmCall, now })
    const degraded = await modelImporter.preview({ text: PARSE_ARCHIVE, mode: 'model', provider: 'p', model: 'm' })
    eq(degraded.items[0].entry.scope.type, 'global', '没有工作区时 workspace 条目降级 global')
    ok(degraded.warnings.some((w) => w.includes('降级为全局')), '降级有 warning')

    // 现有记忆超过上限时给出省略说明，而不是悄悄截断
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: 'pm_seed' + i, category: 'identity', text: '现有记忆第 ' + i + ' 条，用来撑爆紧凑列表。',
    }))
    const prompt = buildImportPrompt(many, PARSE_ARCHIVE)
    ok(prompt.includes('另有') && prompt.includes('未列出'), '超过 ' + MAX_EXISTING_CHARS + ' 字符时显式说明省略条数')
    ok(prompt.length > 1000, 'prompt 非空且包含档案')
    eq(PREVIEW_TTL_MS, 30 * 60 * 1000, '缺省预览有效期 30 分钟')
  }

  console.log('[I7] 端到端：导出 → 再导入（不重复）、分层渲染各取所需')
  {
    const store = makeStore()
    await store.upsert({ category: 'instructions', priority: 'high', evidence: 'explicit', text: '回答先给结论。' })
    await store.upsert({ category: 'projects', text: '本项目用 PowerShell 脚本。', scope: { type: 'workspace', key: WS_KEY, path: WS_PATH } })
    const entries = await store.list()
    const md = renderArchive(entries, { generatedAt: fixedIso() })
    const importer = createImporter({ store, now })
    const preview = await importer.preview({ text: md, mode: 'parse', workspace: { key: WS_KEY, path: WS_PATH } })
    eq(preview.ok, true, '导出的档案能被自己重新导入')
    eq(preview.items.length, 2, '两条记忆都解析回来（说明性段落不计）')
    eq(preview.items.map((item) => item.action), ['skip', 'skip'], '导出再导入不会重复新增（识别为完全重复）')
    eq(preview.items[1].entry.scope.type, 'workspace', 'workspace 作用域随〔项目:path〕往返保留')

    const stable = renderStableSection({ enabled: true, customText: '', entries })
    ok(stable.includes('回答先给结论'), 'G 层含高优先级指令')
    ok(!stable.includes('PowerShell'), 'G 层不含项目条目')
    const ctx = renderPersonalContext({ query: 'PowerShell 脚本', entries, wsKey: WS_KEY })
    ok(ctx.text.includes('PowerShell') && !ctx.text.includes('回答先给结论'), 'P/W 层只给相关项目条目，不重复 G 层指令')
    ok(ctx.text.includes('<workspace_memory>') && !ctx.text.includes('<personal_memory>'), '只有项目条目时只出 workspace_memory 段')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[personal-importer] pass=' + pass + ' fail=' + fail)
if (fail) process.exit(1)
console.log('PASS')
