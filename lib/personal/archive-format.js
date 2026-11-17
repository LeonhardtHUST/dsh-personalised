/**
 * archive-format.js —— 个人记忆档案（Markdown）的解析与渲染。
 *
 * 格式与 `lib/personal/prompts.js` 的 EXPORT_PROMPT 一致：
 *
 *     ### 1. 指令与行为规则
 *     [高][明示][长期有效] 内容
 *     [中][归纳][事件:2026-10-15][进行中] 内容
 *     - 无标签行按所在分类导入（medium / inferred）
 *
 * 约定（DESIGN §4）：
 *   - 分类标题匹配 `^#{2,4}\s*(\d+)[.、]?\s*(标题)`，按序号或标题关键词映射到 1..9；
 *   - 行内方括号标签：优先级 / 证据 / 状态 / 其余视为时间；
 *   - 去掉外层 ``` 代码块；完整性声明、待核实事项放进 notes，不作为条目；
 *   - `ref` 是**原始输入文本的 1 基行号**（形如 `n12`），导入器据此把模型输出对回原文。
 *
 * 本模块是纯函数，不读盘、不联网、不认识配置；同时承担个性化数据的**词汇表**
 * （分类 / 优先级 / 证据 / 状态），其他 personal 模块从这里取，避免各写一份。
 */

/** 档案格式版本标识（写进 Markdown 首行与 JSON 的 format 字段）。 */
export const ARCHIVE_FORMAT_VERSION = 'dsh-personalised-archive-v1'

/**
 * 九类档案分类。index 与 EXPORT_PROMPT 的三级标题序号一一对应。
 * @type {ReadonlyArray<{index:number,id:string,zh:string,en:string,keywords:ReadonlyArray<string>}>}
 */
export const CATEGORIES = Object.freeze([
  Object.freeze({ index: 1, id: 'instructions', zh: '指令与行为规则', en: 'Instructions & Behavior Rules', keywords: Object.freeze(['指令', '规则', 'instruction', 'rule']) }),
  Object.freeze({ index: 2, id: 'identity', zh: '身份与背景', en: 'Identity & Background', keywords: Object.freeze(['身份', '背景', 'identity', 'background']) }),
  Object.freeze({ index: 3, id: 'skills', zh: '知识、技能与能力边界', en: 'Knowledge, Skills & Limits', keywords: Object.freeze(['知识', '技能', '能力', 'skill', 'knowledge']) }),
  Object.freeze({ index: 4, id: 'environment', zh: '工作环境与工具', en: 'Work Environment & Tools', keywords: Object.freeze(['环境', '工具', 'environment', 'tool']) }),
  Object.freeze({ index: 5, id: 'projects', zh: '项目与持续性工作', en: 'Projects & Ongoing Work', keywords: Object.freeze(['项目', 'project']) }),
  Object.freeze({ index: 6, id: 'goals', zh: '长期目标与现实约束', en: 'Long-term Goals & Constraints', keywords: Object.freeze(['目标', '约束', 'goal', 'constraint']) }),
  Object.freeze({ index: 7, id: 'preferences', zh: '稳定偏好与协作方式', en: 'Stable Preferences & Collaboration', keywords: Object.freeze(['偏好', '协作', 'preference']) }),
  Object.freeze({ index: 8, id: 'corrections', zh: '纠错与重要负反馈', en: 'Corrections & Negative Feedback', keywords: Object.freeze(['纠错', '负反馈', 'correction', 'feedback']) }),
  Object.freeze({ index: 9, id: 'pending', zh: '待确认与信息缺口', en: 'Pending & Information Gaps', keywords: Object.freeze(['待确认', '信息缺口', 'pending']) }),
])

/** 分类 id 列表，顺序即导出顺序。 */
export const CATEGORY_IDS = Object.freeze(CATEGORIES.map((c) => c.id))

/** 优先级词表（存储值）。 */
export const PRIORITIES = Object.freeze(['high', 'medium', 'low'])

/** 优先级排序权重（数字越大越靠前）。 */
export const PRIORITY_RANK = Object.freeze({ high: 3, medium: 2, low: 1 })

/** 证据级别词表。 */
export const EVIDENCE_LEVELS = Object.freeze(['explicit', 'inferred', 'unconfirmed'])

/** 条目状态词表（与 EXPORT_PROMPT 一致，保留中文原文）。 */
export const STATUSES = Object.freeze(['进行中', '规划中', '已完成', '已暂停', '状态未知'])

const PRIORITY_ALIASES = Object.freeze({
  高: 'high', high: 'high',
  中: 'medium', medium: 'medium',
  低: 'low', low: 'low',
})
const EVIDENCE_ALIASES = Object.freeze({
  明示: 'explicit', explicit: 'explicit',
  归纳: 'inferred', inferred: 'inferred',
  待确认: 'unconfirmed', unconfirmed: 'unconfirmed',
})
const STATUS_ALIASES = Object.freeze({
  进行中: '进行中',
  规划中: '规划中',
  已完成: '已完成',
  已暂停: '已暂停',
  状态未知: '状态未知',
})
const PRIORITY_ZH = Object.freeze({ high: '高', medium: '中', low: '低' })
const EVIDENCE_ZH = Object.freeze({ explicit: '明示', inferred: '归纳', unconfirmed: '待确认' })

const NOTE_KINDS = ['完整性声明', '待核实事项', '信息缺口']
const NOTE_LINE_RE = /^\*{0,2}(完整性声明|待核实事项|信息缺口)\*{0,2}\s*[：:]\s*\*{0,2}\s*(.*)$/
const HEADING_RE = /^(#{1,6})\s*(.+?)\s*#*\s*$/
const LIST_RE = /^\s*(?:[-*+•]|\d{1,3}[.)、])\s+/
const SEPARATOR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const REF_PREFIX_RE = /^n\d+\s*[|:：]\s*/
const NUMERIC_TITLE_RE = /^(\d{1,2})\s*[.、)．]?\s*/
const PLACEHOLDER_RE = /^_[（(].*[)）]_$/
const WORKSPACE_PREFIX_RE = /^〔项目[:：]\s*([^〕]+)〕\s*/

/**
 * 归一化优先级。
 * @param {*} value 原始值（接受 high/medium/low 与 高/中/低）
 * @param {'high'|'medium'|'low'|null} [fallback] 无法识别时的返回值
 * @returns {'high'|'medium'|'low'|null}
 */
export function normalizePriority(value, fallback = 'medium') {
  const key = String(value == null ? '' : value).trim().toLowerCase()
  const hit = PRIORITY_ALIASES[key] || PRIORITY_ALIASES[String(value == null ? '' : value).trim()]
  return hit || fallback
}

/**
 * 归一化证据级别。
 * @param {*} value 原始值（明示/归纳/待确认 或 explicit/inferred/unconfirmed）
 * @param {'explicit'|'inferred'|'unconfirmed'|null} [fallback]
 * @returns {'explicit'|'inferred'|'unconfirmed'|null}
 */
export function normalizeEvidence(value, fallback = 'inferred') {
  const key = String(value == null ? '' : value).trim().toLowerCase()
  const hit = EVIDENCE_ALIASES[key] || EVIDENCE_ALIASES[String(value == null ? '' : value).trim()]
  return hit || fallback
}

/**
 * 归一化状态词；不认识的值返回 null（状态字段本就允许缺省）。
 * @param {*} value 原始状态词
 * @returns {string|null}
 */
export function normalizeStatus(value) {
  const key = String(value == null ? '' : value).trim()
  return STATUS_ALIASES[key] || null
}

/**
 * 归一化时间字段：`时间未知` 与空值统一成 null，其余保留原文。
 * @param {*} value 原始时间标签
 * @returns {string|null}
 */
export function normalizeTime(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text || text === '时间未知' || text === '未知') return null
  return text
}

/**
 * 由分类标题文本推断分类 id。
 * 先看序号（1..9），再看中英标题与关键词；都无法识别返回 null。
 * @param {string} title 标题文本（可含序号前缀）
 * @returns {string|null}
 */
export function categoryFromTitle(title) {
  const raw = String(title == null ? '' : title).trim()
  if (!raw) return null
  const num = raw.match(NUMERIC_TITLE_RE)
  if (num) {
    const hit = CATEGORIES.find((c) => c.index === Number(num[1]))
    if (hit) return hit.id
  }
  const lower = raw.toLowerCase()
  for (const c of CATEGORIES) {
    if (lower.includes(c.zh.toLowerCase()) || lower.includes(c.en.toLowerCase())) return c.id
    if (c.keywords.some((k) => lower.includes(k.toLowerCase()))) return c.id
  }
  return null
}

/**
 * 条目排序：优先级高→低，其次 createdAt 早→晚，最后 id 字典序。
 * G 层渲染与导出都复用同一比较器，保证字节确定性。
 * @param {object} a 条目
 * @param {object} b 条目
 * @returns {number}
 */
export function compareEntriesForRender(a, b) {
  const pa = PRIORITY_RANK[normalizePriority(a && a.priority, 'medium')] || 2
  const pb = PRIORITY_RANK[normalizePriority(b && b.priority, 'medium')] || 2
  if (pa !== pb) return pb - pa
  const ca = String((a && a.createdAt) || '')
  const cb = String((b && b.createdAt) || '')
  if (ca !== cb) return ca < cb ? -1 : 1
  const ia = String((a && a.id) || '')
  const ib = String((b && b.id) || '')
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

/** 把方括号标签序列归类为 priority/evidence/status/time。 */
function classifyTags(tags) {
  const out = { priority: null, evidence: null, status: null, time: null, timeSeen: false, extra: [] }
  for (const tag of tags) {
    const text = String(tag == null ? '' : tag).trim()
    if (!text) continue
    const priority = normalizePriority(text, null)
    if (priority) { out.priority = priority; continue }
    const evidence = normalizeEvidence(text, null)
    if (evidence) { out.evidence = evidence; continue }
    const status = normalizeStatus(text)
    if (status) { out.status = status; continue }
    if (!out.timeSeen) {
      out.timeSeen = true
      out.time = normalizeTime(text)
    } else {
      // DESIGN §4：其余方括号字段视为 time；多余的同类标签只留第一个
      out.extra.push(text)
    }
  }
  return out
}

/** 若整篇档案包在 ``` 代码块里，返回围栏所在行号（0 基）；无围栏返回 open=-1。 */
function fenceRange(lines) {
  let open = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^```/.test(lines[i].trim())) { open = i; break }
  }
  if (open < 0) return { open: -1, close: -1 }
  let close = -1
  for (let i = lines.length - 1; i > open; i -= 1) {
    if (/^```\s*$/.test(lines[i].trim())) { close = i; break }
  }
  return { open, close }
}

/** 无序号标题是否是说明性段落（完整性声明 / 待核实事项 / 信息缺口）。 */
function noteKindOfTitle(title) {
  const raw = String(title == null ? '' : title).trim()
  for (const kind of NOTE_KINDS) {
    if (raw === kind || raw.startsWith(kind)) return kind
  }
  return null
}

/**
 * 解析档案文本。
 *
 * @param {string} text 档案原文（可含外层代码块、说明性段落）
 * @param {{defaultCategory?: string}} [options] 分类外条目的兜底分类（默认 identity）
 * @returns {{entries: Array<object>, notes: Array<{kind:string,text:string,line:number}>, warnings: string[]}}
 *   entries 为**草稿**（含 ref/line），尚未分配 id、scope、source。
 */
export function parseArchive(text, options = {}) {
  const raw = String(text == null ? '' : text)
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const defaultCategory = CATEGORY_IDS.includes(options && options.defaultCategory)
    ? options.defaultCategory
    : 'identity'
  const entries = []
  const notes = []
  const warnings = []
  const fence = fenceRange(lines)
  let current = null
  let inNote = false
  let note = null
  let lastEntry = null
  const noteIndex = Object.create(null)

  /** 记一条说明性段落；同类多行合并成一条 note。 */
  function pushNoteLine(kind, text, lineNo) {
    let target = noteIndex[kind]
    if (!target) {
      target = { kind, text: '', line: lineNo }
      noteIndex[kind] = target
      notes.push(target)
    }
    note = target
    inNote = true
    lastEntry = null
    const body = String(text == null ? '' : text).trim()
    if (body) target.text = target.text ? target.text + '\n' + body : body
  }

  function startNote(kind, lineNo) {
    pushNoteLine(kind, '', lineNo)
  }

  function appendNote(text) {
    if (!note || !text) return
    note.text = note.text ? note.text + '\n' + text : text
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    if (SEPARATOR_RE.test(trimmed)) { lastEntry = null; continue }
    // 导出档案的文首说明（`> …`）与空占位行（`_（暂无条目）_`）都不是条目
    if (trimmed.startsWith('>') || PLACEHOLDER_RE.test(trimmed)) continue
    // 有围栏时只解析围栏内；围栏外只承接说明性段落（完整性声明等可能写在围栏外）
    const inside = fence.open < 0 || (i > fence.open && (fence.close < 0 || i < fence.close))
    if (!inside) {
      const outsideNote = trimmed.match(NOTE_LINE_RE)
      if (outsideNote) { pushNoteLine(outsideNote[1], outsideNote[2], lineNo); continue }
      if (inNote && note) { appendNote(trimmed.replace(LIST_RE, '').trim()); continue }
      continue
    }

    const heading = trimmed.match(HEADING_RE)
    if (heading) {
      const title = heading[2].trim()
      const category = categoryFromTitle(title)
      if (category) {
        current = category
        inNote = false
        note = null
        lastEntry = null
        continue
      }
      const noteKind = noteKindOfTitle(title)
      if (noteKind) { startNote(noteKind, lineNo); continue }
      if (NUMERIC_TITLE_RE.test(title)) {
        warnings.push('第 ' + lineNo + ' 行：无法识别的分类标题「' + title + '」，其后条目按 ' + defaultCategory + ' 处理')
        current = defaultCategory
        inNote = false
        note = null
        lastEntry = null
        continue
      }
      // 无序号且不是分类标题：当作分类内小标题，忽略但不切换分类
      lastEntry = null
      if (!current && !inNote) warnings.push('第 ' + lineNo + ' 行：分类之外的标题「' + title + '」已忽略')
      continue
    }

    const noteMatch = trimmed.match(NOTE_LINE_RE)
    if (noteMatch) {
      pushNoteLine(noteMatch[1], noteMatch[2], lineNo)
      continue
    }
    if (inNote && note) {
      appendNote(trimmed.replace(LIST_RE, '').trim())
      continue
    }

    const hadList = LIST_RE.test(trimmed)
    let body = hadList ? trimmed.replace(LIST_RE, '').trim() : trimmed
    const refPrefix = body.match(REF_PREFIX_RE)
    if (refPrefix) body = body.slice(refPrefix[0].length).trim()
    if (!body) continue

    const tags = []
    let rest = body
    while (rest.startsWith('[')) {
      const close = rest.indexOf(']')
      if (close <= 1) break
      tags.push(rest.slice(1, close))
      rest = rest.slice(close + 1).trim()
    }
    const parsedTags = classifyTags(tags)
    const workspaceLine = WORKSPACE_PREFIX_RE.test(body)

    if (!tags.length && !hadList && !workspaceLine && lastEntry && lastEntry.category === (current || lastEntry.category)) {
      // 无列表符、无标签的行：视为上一条的换行续写（模型输出换行时常见）
      lastEntry.text = (lastEntry.text + ' ' + body).trim()
      continue
    }

    if (!current) {
      if (!tags.length && !hadList) {
        // 分类标题之前的散文（例如“以下是从其他平台导出的档案”）不是条目
        warnings.push('第 ' + lineNo + ' 行：分类之外的说明文字已忽略')
        continue
      }
      warnings.push('第 ' + lineNo + ' 行：条目不在任何分类标题下，按 ' + defaultCategory + ' 处理')
      current = defaultCategory
    }
    const category = current
    let entryText = rest.trim()
    if (!entryText) {
      warnings.push('第 ' + lineNo + ' 行：条目内容为空，已跳过')
      lastEntry = null
      continue
    }
    if (parsedTags.extra.length) {
      warnings.push('第 ' + lineNo + ' 行：多余标签 ' + parsedTags.extra.map((t) => '[' + t + ']').join('') + ' 已忽略')
    }
    // 导出时 workspace 条目带 〔项目:<path>〕 前缀；这里还原成 scopePath 供导入器恢复作用域
    let scopePath = null
    const wsPrefix = entryText.match(WORKSPACE_PREFIX_RE)
    if (wsPrefix) {
      scopePath = wsPrefix[1].trim()
      entryText = entryText.slice(wsPrefix[0].length).trim()
      if (!entryText) {
        warnings.push('第 ' + lineNo + ' 行：项目条目的内容为空，已跳过')
        lastEntry = null
        continue
      }
    }
    const draft = {
      ref: 'n' + lineNo,
      line: lineNo,
      category,
      priority: parsedTags.priority || 'medium',
      evidence: parsedTags.evidence || (category === 'pending' ? 'unconfirmed' : 'inferred'),
      time: parsedTags.time == null ? null : parsedTags.time,
      status: parsedTags.status || null,
      text: entryText,
      scopePath,
    }
    entries.push(draft)
    lastEntry = draft
  }

  if (!entries.length) warnings.push('未从档案中解析出任何条目')
  return { entries, notes, warnings }
}

/** 把一条 Entry 渲染成档案单行（内部换行折叠成空格，保证一行一条）。 */
export function formatEntryLine(entry) {
  const e = entry || {}
  const priority = normalizePriority(e.priority, 'medium') || 'medium'
  const evidence = normalizeEvidence(e.evidence, 'inferred') || 'inferred'
  const status = normalizeStatus(e.status)
  const time = normalizeTime(e.time)
  const tags = ['[' + PRIORITY_ZH[priority] + ']', '[' + EVIDENCE_ZH[evidence] + ']']
  if (time) tags.push('[' + time + ']')
  if (status) tags.push('[' + status + ']')
  let text = String(e.text == null ? '' : e.text).replace(/\s*\n\s*/g, ' ').trim()
  const scope = e.scope
  if (scope && scope.type === 'workspace') {
    // DESIGN §4：workspace 条目在内容前加 〔项目:<path>〕
    const label = String(scope.path || scope.key || '')
    text = '〔项目:' + label + '〕' + text
  }
  return tags.join('') + ' ' + text
}

/**
 * 渲染可导入的 Markdown 档案。
 *
 * 输出按 1..9 分类，一行一条；文首一行说明来源与时间，末尾附完整性声明与待核实事项。
 * 产物可被 {@link parseArchive} 往返解析（见 smoke-test-personal-archive）。
 *
 * @param {Array<object>} entries Entry 列表
 * @param {{generatedAt?: string, source?: string}} [options]
 * @returns {string} Markdown 文本
 */
export function renderArchive(entries, options = {}) {
  const opts = options || {}
  const generatedAt = opts.generatedAt != null && String(opts.generatedAt).trim()
    ? String(opts.generatedAt).trim()
    : new Date().toISOString()
  const source = opts.source != null && String(opts.source).trim()
    ? String(opts.source).trim()
    : 'dsh-personalised'
  const sorted = (Array.isArray(entries) ? entries.filter(Boolean) : []).slice().sort(compareEntriesForRender)
  const groups = new Map(CATEGORY_IDS.map((id) => [id, []]))
  for (const entry of sorted) {
    const category = CATEGORY_IDS.includes(entry.category) ? entry.category : 'identity'
    groups.get(category).push(entry)
  }

  const lines = ['> ' + ARCHIVE_FORMAT_VERSION + ' · 生成时间：' + generatedAt + ' · 来源：' + source, '']
  let count = 0
  let pendingCount = 0
  for (const category of CATEGORIES) {
    const list = groups.get(category.id)
    if (!list.length) continue
    lines.push('### ' + category.index + '. ' + category.zh, '')
    for (const entry of list) {
      lines.push(formatEntryLine(entry))
      count += 1
      if (category.id === 'pending') pendingCount += 1
    }
    lines.push('')
  }
  if (!count) lines.push('_（暂无条目）_', '')

  lines.push('---', '')
  lines.push('**完整性声明：** 本档案由 dsh-personalised 从本地个人记忆库导出，共 ' + count + ' 条，按 1–9 分类组织；'
    + '仅包含本地已保存的内容，源平台不可访问、缺少记录或因隐私限制被排除的信息不在其中。')
  lines.push('')
  lines.push('**待核实事项：** 待确认条目 ' + pendingCount + ' 条（第 9 类），导入方不得将其当作已确认事实。')
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
}

/**
 * 渲染 JSON 档案（供导出接口与前端下载）。
 * @param {Array<object>} entries Entry 列表
 * @param {{generatedAt?: string, source?: string}} [options]
 * @returns {string} 格式化后的 JSON 文本（末尾带换行）
 */
export function renderJson(entries, options = {}) {
  const opts = options || {}
  const generatedAt = opts.generatedAt != null && String(opts.generatedAt).trim()
    ? String(opts.generatedAt).trim()
    : new Date().toISOString()
  const source = opts.source != null && String(opts.source).trim()
    ? String(opts.source).trim()
    : 'dsh-personalised'
  const sorted = (Array.isArray(entries) ? entries.filter(Boolean) : []).slice().sort(compareEntriesForRender)
  const payload = {
    format: ARCHIVE_FORMAT_VERSION,
    generatedAt,
    source,
    count: sorted.length,
    categories: CATEGORIES.map((category) => ({
      index: category.index,
      id: category.id,
      title: category.zh,
      count: sorted.filter((entry) => entry.category === category.id).length,
    })),
    entries: sorted,
  }
  return JSON.stringify(payload, null, 2) + '\n'
}
