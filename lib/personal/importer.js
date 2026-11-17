/**
 * importer.js —— 跨平台记忆档案的导入器（预览 → 提交 → 撤销）。
 *
 * 契约：docs/personalised/DESIGN.md §5。三种行为：
 *
 *   1. `parse` 模式：纯本地解析档案，与现有记忆做确定性去重；
 *   2. `model` 模式：把 IMPORT_PROMPT + 输出约定 +〈现有记忆〉+〈待导入档案（带 n<行号> 标记）〉
 *      交给用户选定的模型，读它返回的 JSON；输出非法时**降级为 parse 模式**并留 warning；
 *   3. 预览存在内存里（默认 30 分钟），commit 时 previewId 失效返回 410；
 *      提交前自动整库快照，undo(batchId) 用快照还原。
 *
 * 去重规则（parse 模式，确定性）：
 *   - 规范化文本完全相等 → skip；
 *   - 同分类且 token Jaccard ≥ 0.8 → merge（保留较完整正文，作用域不升级）；
 *   - 其余 → add；
 *   - 命中敏感信息（密钥 / 证件 / 银行卡 / 手机号 / 邮箱…）→ skip，正文置占位符。
 *
 * 模型模式的条目也要过同一条敏感信息正则（模型可能没遵守约定）。
 *
 * 本模块不读盘（store 负责）、不联网（llmCall 注入）；所有临时状态只存在内存。
 */
import { parseArchive } from './archive-format.js'
import { IMPORT_OUTPUT_CONTRACT, IMPORT_PROMPT } from './prompts.js'
import { makeBatchId, normalizeEntry, workspaceKey } from './profile-store.js'
import { tokenize } from './relevance.js'

/** 预览默认有效期（DESIGN §5：30 分钟）。 */
export const PREVIEW_TTL_MS = 30 * 60 * 1000

/** 〈现有记忆〉紧凑列表的字符上限。 */
export const MAX_EXISTING_CHARS = 12000

/** 紧凑列表里单条正文的截断长度。 */
export const EXISTING_ITEM_MAX_CHARS = 160

/** 内存里最多保留的预览数（防止反复预览吃内存）。 */
export const MAX_PREVIEWS = 20

/** parse 模式的合并阈值（DESIGN §5：Jaccard ≥ 0.8 且同类）。 */
export const MERGE_THRESHOLD = 0.8

/** 敏感信息被命中后正文的占位符（与 IMPORT_OUTPUT_CONTRACT 一致）。 */
export const SENSITIVE_PLACEHOLDER = '[已省略敏感信息]'

/**
 * 敏感信息正则表。宁可多挡一条，也不把凭据/联系方式写进长期记忆。
 * 注意：不带 /g 标志，`test()` 无 lastIndex 副作用。
 */
const SENSITIVE_RULES = Object.freeze([
  { type: '私钥', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { type: 'API 密钥', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/ },
  { type: '口令/密钥字段', re: /(?:密码|口令|password|passwd|secret|token|api[_-]?key|access[_-]?key|私钥|密钥)\s*[:=：]\s*\S{6,}/i },
  { type: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { type: '银行卡号', re: /(?<!\d)\d{16,19}(?!\d)/ },
  { type: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { type: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
])

/**
 * 找出文本里的敏感信息类型。
 * @param {string} text
 * @returns {string[]} 命中的类型名（去重，按正则表顺序）
 */
export function findSensitiveTypes(text) {
  const source = String(text == null ? '' : text)
  const hits = []
  for (const rule of SENSITIVE_RULES) {
    if (rule.re.test(source) && !hits.includes(rule.type)) hits.push(rule.type)
  }
  return hits
}

/**
 * 去重比较用的规范化文本：小写、去掉空白与标点/符号。
 * @param {string} text
 * @returns {string}
 */
export function normalizeComparable(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * token 集合的 Jaccard 相似度（0..1）。
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function textSimilarity(left, right) {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/** 给档案每行加 `n<行号>|` 引用标记，供模型在 ref 字段回填。 */
function annotateArchive(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => (line.trim() ? 'n' + (index + 1) + '|' + line : line))
    .join('\n')
}

/** 现有记忆的紧凑列表（id|category|text），最多 maxChars 字符。 */
function compactExisting(entries, maxChars) {
  const lines = []
  let used = 0
  let omitted = 0
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const text = String(entry.text == null ? '' : entry.text).replace(/\s*\n\s*/g, ' ').slice(0, EXISTING_ITEM_MAX_CHARS)
    const line = String(entry.id) + '|' + String(entry.category) + '|' + text
    if (used + line.length + 1 > maxChars) { omitted += 1; continue }
    lines.push(line)
    used += line.length + 1
  }
  return { text: lines.length ? lines.join('\n') : '（暂无现有记忆）', omitted, count: lines.length }
}

/**
 * 组装模型模式的完整 user prompt（导出供测试与诊断）。
 * @param {object[]} existing 现有记忆条目
 * @param {string} archiveText 待导入档案原文
 * @param {{maxExistingChars?:number}} [options]
 * @returns {string}
 */
export function buildImportPrompt(existing, archiveText, options = {}) {
  const maxExistingChars = Number.isFinite(Number(options && options.maxExistingChars)) && Number(options.maxExistingChars) > 0
    ? Math.floor(Number(options.maxExistingChars))
    : MAX_EXISTING_CHARS
  const compact = compactExisting(Array.isArray(existing) ? existing : [], maxExistingChars)
  const lines = [
    IMPORT_OUTPUT_CONTRACT,
    '',
    '## 现有记忆（id|category|text）',
    compact.text,
  ]
  if (compact.omitted > 0) lines.push('（另有 ' + compact.omitted + ' 条现有记忆因长度限制未列出，不要臆造它们的内容）')
  lines.push('', '## 待导入档案（行首 n<行号>| 是引用标记，请填入对应条目的 ref 字段）', annotateArchive(archiveText))
  return lines.join('\n')
}

/**
 * 稳健解析模型输出里的 JSON：剥代码块、取首个 `{` 到最后一个 `}`。
 * @param {string} raw 模型原始输出
 * @returns {{ok:boolean, value?:object, error?:string}}
 */
export function parseModelJson(raw) {
  let text = String(raw == null ? '' : raw).trim()
  if (!text) return { ok: false, error: '模型输出为空' }
  text = text.replace(/^\uFEFF/, '')
  const fenced = text.match(/^```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) text = text.slice(start, end + 1)
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: '模型输出不是 JSON 对象' }
    }
    return { ok: true, value }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function actionCounts(items) {
  const counts = { add: 0, merge: 0, conflict: 0, skip: 0 }
  for (const item of items) {
    const action = item && counts[item.action] !== undefined ? item.action : 'add'
    counts[action] += 1
  }
  return counts
}

function defaultSummary(items, mode) {
  const counts = actionCounts(items)
  return (mode === 'model' ? '模型处理：' : '本地解析：') + '共 ' + items.length + ' 条候选，'
    + '新增 ' + counts.add + '、合并 ' + counts.merge + '、冲突 ' + counts.conflict + '、跳过 ' + counts.skip + '。'
}

function buildReport(rawReport, items, mode, notes) {
  const counts = actionCounts(items)
  const source = rawReport && typeof rawReport === 'object' ? rawReport : {}
  const asText = (value, fallback) => {
    const text = String(value == null ? '' : value).trim()
    return text || fallback
  }
  return {
    summary: asText(source.summary, defaultSummary(items, mode)),
    merged: asText(source.merged, counts.merge ? counts.merge + ' 条与现有记忆合并' : '无'),
    conflicts: asText(source.conflicts, counts.conflict ? counts.conflict + ' 条与现有记忆冲突，未自动覆盖' : '无'),
    omissions: asText(source.omissions, notes && notes.length
      ? '档案说明性段落：' + notes.map((note) => note.kind).join('、')
      : '无'),
    notes: (Array.isArray(notes) ? notes : []).map((note) => '[' + note.kind + '] ' + String(note.text || '').trim()),
  }
}

function scopeForDraft(draft, workspace, warnings) {
  if (draft && draft.scopePreference === 'workspace') {
    if (!workspace) {
      warnings.push('档案指定了项目作用域，但本次导入没有绑定工作区，已降级为全局记忆')
      return { type: 'global' }
    }
    return { type: 'workspace', key: workspace.key, path: workspace.path }
  }
  if (draft && draft.scopePath) {
    if (workspace && workspace.path === draft.scopePath) {
      return { type: 'workspace', key: workspace.key, path: workspace.path }
    }
    return { type: 'workspace', key: workspaceKey(draft.scopePath), path: draft.scopePath }
  }
  return { type: 'global' }
}

function baseEntryFromDraft(draft, options) {
  const source = { type: 'import' }
  if (options.platform) source.platform = options.platform
  return {
    category: draft.category,
    priority: draft.priority,
    evidence: draft.evidence,
    time: draft.time,
    status: draft.status,
    text: draft.text,
    scope: options.scope,
    source,
  }
}

/** parse 模式的候选清单（含与现有记忆的确定性去重）。 */
function buildParseItems({ parsed, existing, workspace, platform, nowIso, warnings }) {
  const existingCompact = existing.map((entry) => ({
    entry,
    normalized: normalizeComparable(entry.text),
    tokens: tokenize(entry.text),
  }))
  const items = []
  const usedTempIds = new Set()

  parsed.entries.forEach((draft, index) => {
    const tempId = 't' + (index + 1)
    if (usedTempIds.has(tempId)) return
    usedTempIds.add(tempId)
    const scope = scopeForDraft(draft, workspace, warnings)
    if (!draft.text || !draft.text.trim()) {
      warnings.push('档案 ' + draft.ref + '：正文为空，已跳过')
      return
    }
    const sensitive = findSensitiveTypes(draft.text)
    if (sensitive.length) {
      items.push({
        tempId,
        action: 'skip',
        entry: normalizeEntry(baseEntryFromDraft({ ...draft, text: SENSITIVE_PLACEHOLDER }, { scope, platform }), { now: nowIso }),
        targetId: null,
        existing: null,
        ref: draft.ref,
        reason: '含敏感信息（' + sensitive.join('、') + '），不写入长期记忆',
      })
      return
    }

    const normalized = normalizeComparable(draft.text)
    let exact = null
    for (const candidate of existingCompact) {
      if (candidate.normalized && candidate.normalized === normalized) { exact = candidate; break }
    }
    if (exact) {
      items.push({
        tempId,
        action: 'skip',
        entry: normalizeEntry(baseEntryFromDraft(draft, { scope, platform }), { now: nowIso }),
        targetId: exact.entry.id,
        existing: exact.entry,
        ref: draft.ref,
        reason: '与现有记忆规范化文本完全重复',
      })
      return
    }

    let best = null
    for (const candidate of existingCompact) {
      if (candidate.entry.category !== draft.category) continue
      const similarity = textSimilarity(draft.text, candidate.entry.text)
      // +1e-9：0.8 恰好命中时避免浮点误差把它判成 0.7999999999999999
      if (similarity + 1e-9 < MERGE_THRESHOLD) continue
      if (!best || similarity > best.similarity) best = { candidate, similarity }
    }
    if (best) {
      const keepLonger = best.candidate.entry.text.length >= draft.text.length
      items.push({
        tempId,
        action: 'merge',
        entry: normalizeEntry(baseEntryFromDraft({
          ...draft,
          text: keepLonger ? best.candidate.entry.text : draft.text,
        }, { scope: best.candidate.entry.scope || scope, platform }), { now: nowIso }),
        targetId: best.candidate.entry.id,
        existing: best.candidate.entry,
        ref: draft.ref,
        reason: '与现有条目同分类且相似度 ' + Math.round(best.similarity * 100) + '%，按合并处理（作用域不升级）',
      })
      return
    }

    const entry = normalizeEntry(baseEntryFromDraft(draft, { scope, platform }), { now: nowIso })
    if (!entry) {
      warnings.push('档案 ' + draft.ref + '：归一化失败，已跳过')
      return
    }
    items.push({
      tempId,
      action: 'add',
      entry,
      targetId: null,
      existing: null,
      ref: draft.ref,
      reason: '新增（本地解析）',
    })
  })
  return items
}

/** 模型模式的候选清单（含 ref 回填、action/target 校验、敏感信息复核）。 */
function buildModelItems({ value, parsed, existing, workspace, platform, nowIso, warnings }) {
  const byRef = new Map(parsed.entries.map((draft) => [draft.ref, draft]))
  const existingById = new Map(existing.map((entry) => [entry.id, entry]))
  const rawList = Array.isArray(value && value.entries) ? value.entries : []
  if (!rawList.length) warnings.push('模型没有返回任何条目')
  const items = []

  rawList.forEach((raw, index) => {
    const tempId = 't' + (index + 1)
    if (!raw || typeof raw !== 'object') {
      warnings.push('模型第 ' + (index + 1) + ' 条不是对象，已跳过')
      return
    }
    const refText = raw.ref == null ? '' : String(raw.ref).trim()
    const refMatch = refText.match(/(\d+)/)
    const ref = refMatch ? 'n' + refMatch[1] : ''
    const draft = ref ? byRef.get(ref) : null
    if (ref && !draft) warnings.push('模型引用了不存在的档案行号 ' + ref + '，该条按模型给出的内容处理')

    let action = ['add', 'merge', 'conflict', 'skip'].includes(raw.action) ? raw.action : 'add'
    if (!['add', 'merge', 'conflict', 'skip'].includes(raw.action)) {
      warnings.push('模型第 ' + (index + 1) + ' 条的 action 无法识别，按 add 处理')
    }
    const targetText = raw.target == null ? '' : String(raw.target).trim()
    let target = targetText ? existingById.get(targetText) : null
    if ((action === 'merge' || action === 'conflict') && !target) {
      if (targetText) warnings.push('模型第 ' + (index + 1) + ' 条的 target=' + targetText + ' 不存在，已降级为新增')
      action = 'add'
      target = null
    }

    const category = String(raw.category || '').trim()
    const text = String(raw.text == null ? '' : raw.text).trim()
      || (draft && draft.text) || ''
    if (!text) {
      warnings.push('模型第 ' + (index + 1) + ' 条正文为空，已跳过')
      return
    }

    const sensitive = findSensitiveTypes(text)
    if (sensitive.length && action !== 'skip') {
      warnings.push('模型第 ' + (index + 1) + ' 条含敏感信息（' + sensitive.join('、') + '），已强制跳过')
      action = 'skip'
      target = null
    }

    let scope
    if (raw.scope === 'workspace') {
      if (workspace) scope = { type: 'workspace', key: workspace.key, path: workspace.path }
      else {
        warnings.push('模型第 ' + (index + 1) + ' 条要求项目作用域，但本次导入没有绑定工作区，已降级为全局')
        scope = { type: 'global' }
      }
    } else if ((raw.scope == null || raw.scope === '') && draft && draft.scopePath) {
      scope = scopeForDraft(draft, workspace, warnings)
    } else {
      scope = { type: 'global' }
    }

    const mergedFromDraft = {
      category: category || (draft && draft.category) || 'identity',
      priority: raw.priority != null ? raw.priority : (draft && draft.priority),
      evidence: raw.evidence != null ? raw.evidence : (draft && draft.evidence),
      time: raw.time != null ? raw.time : (draft && draft.time),
      status: raw.status != null ? raw.status : (draft && draft.status),
      text: action === 'skip' ? SENSITIVE_PLACEHOLDER : text,
    }
    const entry = normalizeEntry(baseEntryFromDraft(mergedFromDraft, { scope, platform }), { now: nowIso })
    if (!entry) {
      warnings.push('模型第 ' + (index + 1) + ' 条归一化失败，已跳过')
      return
    }
    const reason = sensitive.length && action === 'skip'
      ? '含敏感信息（' + sensitive.join('、') + '），不写入长期记忆'
      : String(raw.reason == null ? '' : raw.reason).trim() || ('模型判定 ' + action)
    items.push({
      tempId,
      action,
      entry,
      targetId: target ? target.id : null,
      existing: target || null,
      ref: ref || null,
      reason,
    })
  })
  return items
}

function normalizeWorkspace(raw) {
  if (!raw || typeof raw !== 'object') return null
  const wsPath = raw.path != null ? String(raw.path).trim() : ''
  const key = raw.key != null && String(raw.key).trim() ? String(raw.key).trim() : (wsPath ? workspaceKey(wsPath) : '')
  if (!key) return null
  return { key, path: wsPath || key }
}

/**
 * 创建导入器。
 *
 * @param {{store:object, llmCall?:Function, now?:()=>number, ttlMs?:number}} options
 *   store：createProfileStore 的返回值；llmCall：makeLlmCall 的返回值（parse 模式可缺省）
 * @returns {{preview:Function, commit:Function, undo:Function, previewCount:Function}}
 */
export function createImporter(options = {}) {
  const opt = options || {}
  const store = opt.store
  if (!store || typeof store.list !== 'function' || typeof store.applyOps !== 'function') {
    throw new Error('createImporter: 需要 store（createProfileStore 的返回值）')
  }
  const llmCall = typeof opt.llmCall === 'function' ? opt.llmCall : null
  const nowFn = typeof opt.now === 'function' ? opt.now : () => Date.now()
  const ttlMs = Number.isFinite(Number(opt.ttlMs)) && Number(opt.ttlMs) > 0 ? Number(opt.ttlMs) : PREVIEW_TTL_MS
  const previews = new Map()

  function nowMs() {
    const value = nowFn()
    const ms = typeof value === 'number' ? value : Date.parse(String(value == null ? '' : value))
    return Number.isFinite(ms) ? ms : Date.now()
  }

  function nowIso() {
    return new Date(nowMs()).toISOString()
  }

  function makePreviewId() {
    return 'pv_' + nowMs().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  function prunePreviews() {
    const current = nowMs()
    for (const [id, record] of [...previews]) {
      if (current - record.createdAt > ttlMs) previews.delete(id)
    }
    while (previews.size > MAX_PREVIEWS) {
      const oldest = previews.keys().next()
      if (oldest.done) break
      previews.delete(oldest.value)
    }
  }

  async function buildParseResult({ text, workspace, platform, warnings, parsed }) {
    const existing = await store.list({ scope: 'all' })
    const items = buildParseItems({ parsed, existing, workspace, platform, nowIso, warnings })
    return { items, report: buildReport(null, items, 'parse', parsed.notes) }
  }

  /**
   * 生成导入预览（不写库）。
   * @param {{text:string, mode?:'model'|'parse', provider?:string, model?:string, workspace?:object|null,
   *   platform?:string, sessionId?:string, signal?:AbortSignal, timeoutMs?:number, maxTokens?:number}} input
   * @returns {Promise<{ok:boolean, status?:number, error?:string, previewId?:string, mode?:string,
   *   usedModel?:object|null, items?:object[], report?:object, warnings?:string[]}>}
   *   失败时 status：400（参数/模型不可用）、502（模型调用失败）；成功无 status。
   */
  async function preview(input = {}) {
    const src = input || {}
    const text = String(src.text == null ? '' : src.text)
    if (!text.trim()) return { ok: false, status: 400, error: '档案内容为空' }
    const requestedMode = src.mode === 'model' ? 'model' : 'parse'
    const workspace = normalizeWorkspace(src.workspace)
    const platform = src.platform != null && String(src.platform).trim() ? String(src.platform).trim() : ''
    const warnings = []
    const parsed = parseArchive(text)
    for (const warning of parsed.warnings) warnings.push('档案解析：' + warning)

    let mode = requestedMode
    let items = []
    let report = null
    let usedModel = null

    if (requestedMode === 'model') {
      if (!llmCall) return { ok: false, status: 400, error: '未配置用于处理导入的模型' }
      const provider = String(src.provider == null ? '' : src.provider).trim()
      const model = String(src.model == null ? '' : src.model).trim()
      if (!provider || !model) return { ok: false, status: 400, error: '请选择用于处理导入的模型' }
      const existing = await store.list({ scope: 'all' })
      const prompt = buildImportPrompt(existing, text)
      let rawText = ''
      try {
        const raw = await llmCall({
          provider,
          model,
          system: IMPORT_PROMPT,
          prompt,
          maxTokens: src.maxTokens,
          purpose: 'dsh-personalised-import',
          timeoutMs: src.timeoutMs,
          signal: src.signal,
        })
        rawText = typeof raw === 'string' ? raw : String((raw && raw.text) || '')
        if (raw && typeof raw === 'object' && Array.isArray(raw.warnings)) {
          for (const warning of raw.warnings) warnings.push('模型调用：' + warning)
        }
      } catch (e) {
        return {
          ok: false,
          status: 502,
          code: String((e && e.code) || 'LLM_ERROR'),
          error: '模型处理失败：' + String((e && e.message) || e),
        }
      }
      usedModel = { provider, model }
      const json = parseModelJson(rawText)
      if (!json.ok) {
        warnings.push('模型输出不是合法 JSON（' + json.error + '），已降级为本地解析')
        mode = 'parse'
        const fallback = await buildParseResult({ text, workspace, platform, warnings, parsed })
        items = fallback.items
        report = fallback.report
      } else {
        items = buildModelItems({ value: json.value, parsed, existing, workspace, platform, nowIso, warnings })
        report = buildReport(json.value.report, items, 'model', parsed.notes)
      }
    } else {
      const parsedResult = await buildParseResult({ text, workspace, platform, warnings, parsed })
      items = parsedResult.items
      report = parsedResult.report
    }

    prunePreviews()
    const previewId = makePreviewId()
    previews.set(previewId, {
      createdAt: nowMs(),
      mode,
      usedModel,
      items,
      report,
      warnings: warnings.slice(),
      workspace,
      platform,
    })
    return {
      ok: true,
      previewId,
      mode,
      usedModel,
      items,
      report,
      warnings,
    }
  }

  /**
   * 提交预览结果：先整库快照，再批量写入。
   *
   * @param {{previewId:string, accept?:string[], edits?:Object<string,object>}} input
   * @returns {Promise<{ok:boolean, status?:number, error?:string, batchId?:string, added?:number, merged?:number, skipped?:number}>}
   *   previewId 过期/不存在 → status 410。
   */
  async function commit(input = {}) {
    const src = input || {}
    const previewId = String(src.previewId == null ? '' : src.previewId)
    const record = previews.get(previewId)
    if (!record) return { ok: false, status: 410, error: '预览已过期或不存在，请重新预览' }
    if (nowMs() - record.createdAt > ttlMs) {
      previews.delete(previewId)
      return { ok: false, status: 410, error: '预览已过期，请重新预览' }
    }
    const accept = Array.isArray(src.accept) ? new Set(src.accept.map(String)) : null
    const edits = src.edits && typeof src.edits === 'object' ? src.edits : {}
    const batchId = makeBatchId(nowMs())
    const warnings = []
    const ops = []
    let skipped = 0
    if (accept) {
      const known = new Set(record.items.map((item) => item && item.tempId))
      for (const tempId of accept) {
        if (!known.has(tempId)) warnings.push('accept 里的 ' + tempId + ' 不在本次预览中，已忽略')
      }
    }

    for (const item of record.items) {
      if (!item || item.action === 'skip') { skipped += 1; continue }
      if (accept && !accept.has(item.tempId)) { skipped += 1; continue }
      if (!accept && item.action !== 'add' && item.action !== 'merge') { skipped += 1; continue }
      const patch = edits[item.tempId]
      const base = patch && typeof patch === 'object'
        ? { ...item.entry, ...patch, id: item.entry.id, createdAt: item.entry.createdAt }
        : item.entry
      const entry = normalizeEntry(base, { now: nowIso() })
      if (!entry) { warnings.push('条目 ' + item.tempId + ' 的编辑内容无效，已跳过'); skipped += 1; continue }
      if (item.action === 'merge' && item.targetId) {
        // 合并保留目标条目身份与作用域（不得把项目内信息升级成全局）
        ops.push({
          op: 'update',
          entry: {
            ...entry,
            id: item.targetId,
            scope: item.existing ? item.existing.scope : entry.scope,
          },
        })
      } else {
        ops.push({ op: 'add', entry: { ...entry, id: item.entry.id } })
      }
    }

    const snapshot = await store.snapshot(batchId)
    if (!snapshot.ok) return { ok: false, status: 500, error: '无法创建导入前备份：' + (snapshot.error || '未知错误') }
    const applied = await store.applyOps(ops, { batchId, snapshot: false })
    if (!applied.ok) return { ok: false, status: 500, error: applied.error || '写入画像库失败' }
    previews.delete(previewId)
    return {
      ok: true,
      batchId,
      added: applied.added,
      merged: applied.updated,
      skipped,
      warnings: warnings.concat(applied.warnings || []),
    }
  }

  /**
   * 撤销一次导入（用提交前的整库快照还原）。
   * @param {{batchId:string}} input
   * @returns {Promise<{ok:boolean, status?:number, error?:string, restored?:number}>}
   */
  async function undo(input = {}) {
    const batchId = String((input && input.batchId) == null ? '' : input.batchId)
    if (!batchId) return { ok: false, status: 400, error: '缺少 batchId' }
    const restored = await store.restore(batchId)
    if (!restored.ok) {
      return { ok: false, status: restored.missing ? 404 : 500, error: restored.error || '还原失败' }
    }
    return { ok: true, restored: restored.restored }
  }

  /** 当前内存里的预览数（测试/诊断用）。 */
  function previewCount() {
    prunePreviews()
    return previews.size
  }

  return { preview, commit, undo, previewCount }
}
