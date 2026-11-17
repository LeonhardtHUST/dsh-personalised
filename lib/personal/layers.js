/**
 * layers.js —— 三层上下文（G/P/W）的**注入决策**与**文本渲染**。
 *
 * 契约：docs/personalised/DESIGN.md §2。
 *
 *   G 全局指令：自定义 instructions + `kind=instruction`、`scope=global`、非 low、非 pending 的条目，
 *               渲染成字节稳定的 systemPrompt.section 文本（不含日期/计数/工作区）。
 *   P 个人记忆：`kind=fact` 的 global 条目（外加 low 优先级指令），按与最新用户消息的相关性取 top-K。
 *   W 项目记忆：`scope.workspace && scope.key === 当前 wsKey` 的条目，与 P 共用一份字符预算。
 *
 * 硬规则：
 *   - pending（待确认）条目**永不出现**；
 *   - 别的 wsKey 的条目**永不出现**；
 *   - 同一输入两次渲染**逐字节一致**（宿主每个请求会调用 text() 两次，两次必须相同）。
 *
 * 本模块不读盘、不联网、不认识配置；所有开关由入参给出。
 */
import {
  PRIORITY_RANK,
  compareEntriesForRender,
  normalizePriority,
} from './archive-format.js'
import { selectRelevant } from './relevance.js'

/** G 层 systemPrompt.section 名（宿主的稳定段标识）。 */
export const STABLE_SECTION_NAME = 'dsh-personalised:instructions'

/** P/W 层 systemPrompt.context 名。 */
export const PERSONAL_CONTEXT_NAME = 'dsh-personalised:personal'

/** `customInstructionsPosition='prefix'` 的 order：人格前缀（0）之后、策略段（500+）之前。 */
export const STABLE_ORDER_PREFIX = 100

/** `customInstructionsPosition='suffix'` 的 order：工具与策略段之后、人格后缀（10200）之前。 */
export const STABLE_ORDER_SUFFIX = 10150

/** G 层文本标题（固定，保证字节稳定；段落为空时整段消失）。 */
export const STABLE_SECTION_TITLE = '## 个性化指令（dsh-personalised）'

/** 子代理策略枚举（DESIGN §6）。 */
export const SUBAGENT_POLICIES = Object.freeze(['instructions', 'none', 'all'])

/** P/W 注入模式枚举。 */
export const PERSONAL_MODES = Object.freeze(['relevant', 'off'])

/**
 * 计算 G 层 section 的 order。
 * @param {'prefix'|'suffix'|string} position `customInstructionsPosition`
 * @returns {number}
 */
export function stableSectionOrder(position) {
  return String(position) === 'suffix' ? STABLE_ORDER_SUFFIX : STABLE_ORDER_PREFIX
}

/**
 * 决定本次模型请求要注入哪几层（宿主在 text(context) 里调用）。
 *
 * @param {object} input
 * @param {boolean} [input.isSubagent] 当前 agent 是否是子代理
 * @param {boolean} [input.isOwnBackground] 是否本插件自己 spawn 的后台子代理（一律不给 P/W）
 * @param {'instructions'|'none'|'all'} [input.policy] `personalSubagentPolicy`
 * @param {boolean} [input.applyToSubagents] `customInstructionsSubagents`
 * @param {boolean} [input.instructionsEnabled] `customInstructionsEnabled`
 * @param {'relevant'|'off'} [input.personalMode] `personalInjectMode`
 * @returns {{stable:boolean, personal:boolean, workspace:boolean}}
 */
export function decideLayers(input = {}) {
  const src = input || {}
  const policy = SUBAGENT_POLICIES.includes(src.policy) ? src.policy : 'instructions'
  const mode = src.personalMode === 'off' ? 'off' : 'relevant'
  const instructionsEnabled = src.instructionsEnabled !== false
  const applyToSubagents = src.applyToSubagents !== false

  if (src.isSubagent === true) {
    if (policy === 'none') return { stable: false, personal: false, workspace: false }
    const stable = instructionsEnabled && applyToSubagents
    const personalAllow = policy === 'all' && mode === 'relevant' && src.isOwnBackground !== true
    return { stable, personal: personalAllow, workspace: personalAllow }
  }
  const personalAllow = mode === 'relevant'
  return { stable: instructionsEnabled, personal: personalAllow, workspace: personalAllow }
}

/** 单行化（G/P/W 每条一行，避免换行把层级结构弄乱）。 */
function oneLine(text) {
  return String(text == null ? '' : text).replace(/\s*\n\s*/g, ' ').trim()
}

/** 去重用的规范化文本。 */
function dedupeKey(text) {
  return oneLine(text).toLowerCase()
}

/**
 * 条目是否“待确认、不得注入”。
 * 以 kind 为准，但 evidence=unconfirmed 也一律挡住（防宿主传入未归一化的条目）。
 */
function isPendingEntry(entry) {
  if (!entry) return true
  if (entry.kind === 'pending') return true
  return String(entry.evidence == null ? '' : entry.evidence).trim() === 'unconfirmed'
}

/**
 * 渲染 G 层文本（`ctx.systemPrompt.section` 的 text）。
 *
 * 过滤：`kind==='instruction'`、`scope.type==='global'`、`priority!=='low'`；排序：
 * priority(high>medium>low) → createdAt → id；输出不含日期、工作区、计数等易变字段。
 * 空内容返回 `''`（宿主会因此整段消失，等于关闭注入）。
 *
 * @param {{enabled?:boolean, customText?:string, entries?:object[]}} [input]
 * @returns {string}
 */
export function renderStableSection(input = {}) {
  const src = input || {}
  if (src.enabled === false) return ''
  const customText = String(src.customText == null ? '' : src.customText).trim()
  const entries = Array.isArray(src.entries) ? src.entries : []
  const rules = entries
    .filter((entry) => entry
      && !isPendingEntry(entry)
      && entry.kind === 'instruction'
      && entry.scope && entry.scope.type === 'global'
      && normalizePriority(entry.priority, 'medium') !== 'low'
      && typeof entry.text === 'string' && entry.text.trim() !== '')
    .slice()
    .sort(compareEntriesForRender)

  const seen = new Set()
  const lines = []
  if (customText) {
    seen.add(dedupeKey(customText))
    lines.push(customText)
  }
  for (const entry of rules) {
    const text = oneLine(entry.text)
    const key = dedupeKey(text)
    if (!text || seen.has(key)) continue
    seen.add(key)
    lines.push('- ' + text)
  }
  if (!lines.length) return ''
  return STABLE_SECTION_TITLE + '\n\n' + lines.join('\n') + '\n'
}

/** 判断条目是否能进 P 层：global 的 fact，或低优先级指令（高/中优先级指令已在 G 层）。 */
function isPersonalCandidate(entry) {
  if (!entry || isPendingEntry(entry)) return false
  const scope = entry.scope || { type: 'global' }
  if (scope.type !== 'global') return false
  if (entry.kind === 'fact') return true
  return entry.kind === 'instruction' && normalizePriority(entry.priority, 'medium') === 'low'
}

/** 判断条目是否能进 W 层：恰好是当前工作区的条目（别的 wsKey 一律不出现）。 */
function isWorkspaceCandidate(entry, wsKey) {
  if (!entry || isPendingEntry(entry)) return false
  if (!wsKey) return false
  const scope = entry.scope || {}
  return scope.type === 'workspace' && scope.key === String(wsKey)
}

function renderItems(items) {
  return (items || []).map((item) => '- ' + oneLine(item.entry && item.entry.text)).filter((line) => line !== '- ').join('\n')
}

/**
 * 渲染 P/W 层文本（`ctx.systemPrompt.context` 的 text）。
 *
 * 预算：P/W 共用 `budgetChars`；两组都有内容时 W 先取一半，剩余给 P（W 更贴近当前工作）。
 * 输出形如：
 *
 *     <personal_memory>
 *     - …
 *     </personal_memory>
 *     <workspace_memory>
 *     - …
 *     </workspace_memory>
 *
 * 两层都为空时 `text === ''`。pending 与跨工作区条目永不出现。
 *
 * @param {{query?:string, entries?:object[], wsKey?:string, topK?:number, budgetChars?:number}} [input]
 * @returns {{personal:string, workspace:string, text:string, counts:{personal:number, workspace:number}}}
 */
export function renderPersonalContext(input = {}) {
  const src = input || {}
  const entries = Array.isArray(src.entries) ? src.entries : []
  const wsKey = src.wsKey == null ? '' : String(src.wsKey)
  const topK = Number.isFinite(Number(src.topK)) && Number(src.topK) > 0 ? Math.floor(Number(src.topK)) : 8
  const rawBudget = src.budgetChars
  const budgetChars = rawBudget == null
    ? 1600
    : (Number.isFinite(Number(rawBudget)) ? Math.max(0, Math.floor(Number(rawBudget))) : 1600)

  const personalCandidates = entries.filter(isPersonalCandidate)
  const workspaceCandidates = entries.filter((entry) => isWorkspaceCandidate(entry, wsKey))
  const both = personalCandidates.length > 0 && workspaceCandidates.length > 0
  const wsBudget = both ? Math.max(1, Math.floor(budgetChars / 2)) : budgetChars

  const workspacePick = budgetChars > 0
    ? selectRelevant({ query: src.query, entries: workspaceCandidates, topK, budgetChars: wsBudget })
    : { items: [], chars: 0 }
  const personalBudget = Math.max(0, budgetChars - workspacePick.chars)
  const personalPick = personalBudget > 0
    ? selectRelevant({ query: src.query, entries: personalCandidates, topK, budgetChars: personalBudget })
    : { items: [] }

  const personal = renderItems(personalPick.items)
  const workspace = renderItems(workspacePick.items)
  const parts = []
  if (personal) parts.push('<personal_memory>\n' + personal + '\n</personal_memory>')
  if (workspace) parts.push('<workspace_memory>\n' + workspace + '\n</workspace_memory>')
  return {
    personal,
    workspace,
    text: parts.join('\n'),
    counts: { personal: personalPick.items.length, workspace: workspacePick.items.length },
  }
}

/** G 层条目的排序权重（导出供宿主/测试核对，避免各处重写）。 */
export function stableEntryRank(entry) {
  return PRIORITY_RANK[normalizePriority(entry && entry.priority, 'medium')] || 2
}
