/**
 * relevance.js —— 个人记忆 / 旧 MEMORY.md 的相关性检索（BM25-lite，纯函数）。
 *
 * 用在两处（DESIGN §2）：
 *   1. P/W 层：`selectRelevant()` 从个人画像里按与当前用户消息的相关性取 top-K；
 *   2. 旧 user-memory 的 `relevant` 注入模式：`selectRelevantChunks()` 从 MEMORY.md 里取相关段落。
 *
 * 为什么自己写而不用向量模型：注入路径必须**同步、确定、零网络**（同一请求两次 text() 要逐字节一致）。
 * BM25-lite 足够区分“这句话在讲项目 A”与“在讲天气”，且相同输入永远得到相同排序。
 *
 * 分词：拉丁词小写整词 + CJK 单字/双字 gram，两者都去停用词。
 * 打分：BM25（k1=1.2, b=0.75, idf = ln(1 + (N-df+0.5)/(df+0.5))）。
 *
 * 退化规则（见 `selectRelevantChunks`）：query 为空或全无命中时**绝不返回空串**，
 * 而是保留标题 + 高优先级段 + 头部截断 —— 宁可少给，不可把用户记忆整体丢掉。
 */
import { PRIORITY_RANK, normalizePriority } from './archive-format.js'

const LATIN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'be', 'been',
  'for', 'on', 'with', 'as', 'by', 'at', 'from', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'do', 'does', 'did',
  'not', 'no', 'yes', 'but', 'if', 'then', 'than', 'so', 'such', 'can', 'could', 'should', 'would',
  'will', 'may', 'might', 'have', 'has', 'had', 'user', 'users',
])
const CJK_STOP_CHARS = new Set('的了和是在有我你他她它这那也就都而及与或等中上下对不很会一个我们你们他们'
  .split(''))
const CJK_STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '一个', '一种', '可以', '可能', '如果',
  '因为', '所以', '但是', '然后', '以及', '进行', '需要', '应该', '已经', '就是', '还是', '或者', '什么',
  '怎么', '为什', '没有', '不是', '不会', '不能', '自己', '这样', '那样',
])
const LATIN_RE = /[a-z0-9][a-z0-9+#_]*/g
const CJK_RE = /[\u4e00-\u9fff]+/g
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** 高优先级段落的关键词（退化截取时先保住这些段）。 */
const HIGH_PRIORITY_RE = /规则|约束|要求|必须|禁止|注意|偏好|约定|指令|rule|require|must|constraint|important|prefer/i

/** 截断标记（显式，不静默丢内容）。 */
export const TRUNCATE_MARK = '…（已截断）'

/**
 * 分词：拉丁词小写整词 + CJK 单字/双字 gram，去停用词。
 * @param {string} text 待分词文本
 * @returns {string[]} token 列表（保留重复，供词频计算）
 */
export function tokenize(text) {
  const out = []
  const source = String(text == null ? '' : text).toLowerCase()
  const latinSource = source.replace(/[-._/\\]/g, ' ')
  for (const match of latinSource.matchAll(LATIN_RE)) {
    const word = match[0]
    if (word.length < 2 && !/\d/.test(word)) continue
    if (LATIN_STOPWORDS.has(word)) continue
    out.push(word)
  }
  for (const match of source.matchAll(CJK_RE)) {
    const run = match[0]
    for (let i = 0; i < run.length; i += 1) {
      const ch = run[i]
      if (!CJK_STOP_CHARS.has(ch)) out.push(ch)
      if (i + 1 < run.length) {
        const bigram = run.slice(i, i + 2)
        if (CJK_STOP_BIGRAMS.has(bigram)) continue
        if (CJK_STOP_CHARS.has(bigram[0]) || CJK_STOP_CHARS.has(bigram[1])) continue
        out.push(bigram)
      }
    }
  }
  return out
}

/**
 * BM25-lite 打分。
 * @param {string[]|string} queryTokens 查询 token 或原始查询文本
 * @param {Array<string[]|string>} docs 文档 token 列表或原文
 * @param {{k1?:number, b?:number}} [options]
 * @returns {number[]} 与 docs 等长的分数（未归一化）
 */
export function bm25Scores(queryTokens, docs, options = {}) {
  const opt = options || {}
  const k1 = Number.isFinite(Number(opt.k1)) ? Number(opt.k1) : 1.2
  const b = Number.isFinite(Number(opt.b)) ? Number(opt.b) : 0.75
  const tokenLists = (Array.isArray(docs) ? docs : []).map((doc) => (Array.isArray(doc) ? doc : tokenize(doc)))
  const n = tokenLists.length
  if (!n) return []
  const df = new Map()
  const tfs = tokenLists.map((tokens) => {
    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)
    for (const token of tf.keys()) df.set(token, (df.get(token) || 0) + 1)
    return tf
  })
  const avgLen = tokenLists.reduce((sum, tokens) => sum + tokens.length, 0) / n || 1
  const query = Array.isArray(queryTokens) ? queryTokens : tokenize(queryTokens)
  const unique = [...new Set(query)]
  return tokenLists.map((tokens, index) => {
    const tf = tfs[index]
    const len = tokens.length || 1
    let score = 0
    for (const term of unique) {
      const freq = tf.get(term) || 0
      if (!freq) continue
      const docFreq = df.get(term) || 0
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5))
      score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (len / avgLen)))
    }
    return score
  })
}

function roundScore(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0
}

function priorityRankOf(entry) {
  return PRIORITY_RANK[normalizePriority(entry && entry.priority, 'medium')] || 2
}

function compareCreatedAt(a, b) {
  const ca = String((a && a.createdAt) || '')
  const cb = String((b && b.createdAt) || '')
  if (ca === cb) return 0
  return ca < cb ? -1 : 1
}

/**
 * 从条目里按相关性挑 top-K（pinned 条目无视阈值，仍受预算约束）。
 *
 * 排序：pinned → 分数降序 → 优先级 → createdAt 早→晚 → id 字典序（同分完全确定）。
 * query 为空时按优先级/时间退化排序（不返回空，避免"第一轮没有用户消息就什么都不注入"）。
 *
 * @param {{query?:string, entries?:object[], topK?:number, budgetChars?:number, minScore?:number, includePending?:boolean}} input
 * @returns {{items:{entry:object,score:number,pinned:boolean,chars:number,truncated?:boolean}[], chars:number, considered:number, eligible:number, dropped:number, budgetChars:number}}
 */
export function selectRelevant(input = {}) {
  const src = input || {}
  const entries = Array.isArray(src.entries) ? src.entries : []
  const topK = Number.isFinite(Number(src.topK)) && Number(src.topK) > 0 ? Math.floor(Number(src.topK)) : 8
  // budgetChars 缺省给 1600；显式传 0/负数表示“本轮不注入”，不能回落成默认值
  const rawBudget = src.budgetChars
  const budgetChars = rawBudget == null
    ? 1600
    : (Number.isFinite(Number(rawBudget)) ? Math.max(0, Math.floor(Number(rawBudget))) : 1600)
  const minScore = Number.isFinite(Number(src.minScore)) ? Number(src.minScore) : 0
  const includePending = src.includePending === true

  const candidates = entries.filter((entry) => entry && typeof entry.text === 'string' && entry.text !== ''
    && (includePending || entry.kind !== 'pending'))
  const queryTokens = tokenize(src.query)
  const scores = bm25Scores(queryTokens, candidates.map((entry) => entry.text))
  // query 没有可用 token 时不该用 minScore 把候选全筛掉（那就等于不注入）
  const effectiveMin = queryTokens.length ? minScore : 0

  const eligible = []
  candidates.forEach((entry, index) => {
    const pinned = entry.pinned === true
    const score = roundScore(scores[index])
    if (!pinned && score < effectiveMin) return
    eligible.push({ entry, score, pinned })
  })
  eligible.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    if (left.score !== right.score) return right.score - left.score
    const byPriority = priorityRankOf(right.entry) - priorityRankOf(left.entry)
    if (byPriority) return byPriority
    const byTime = compareCreatedAt(left.entry, right.entry)
    if (byTime) return byTime
    const leftId = String(left.entry.id || '')
    const rightId = String(right.entry.id || '')
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
  })

  // 预算口径：每条按 "- " 前缀（2 字符）+ 正文；条目之间用换行（1 字符）
  const items = []
  let used = 0
  for (const candidate of eligible) {
    if (items.length >= topK) break
    const separator = items.length ? 1 : 0
    const cost = candidate.entry.text.length + 2 + separator
    if (used + cost <= budgetChars) {
      items.push({ ...candidate, chars: cost })
      used += cost
      continue
    }
    if (!items.length && budgetChars >= 16) {
      // 预算连一条都放不下：截断第一条而不是整组丢弃（不然等于静默丢全部信息）
      const room = budgetChars - 2
      const text = truncateText(candidate.entry.text, room)
      if (!text) break
      const truncatedCost = text.length + 2
      items.push({
        entry: { ...candidate.entry, text },
        score: candidate.score,
        pinned: candidate.pinned,
        chars: truncatedCost,
        truncated: true,
      })
      used = truncatedCost
    }
    break
  }

  return {
    items,
    chars: used,
    considered: candidates.length,
    eligible: eligible.length,
    dropped: candidates.length - items.length,
    budgetChars,
  }
}

/**
 * 把 Markdown 切成块：以标题行分段（首个标题前的导语单独成块），超长段再按空行拆分。
 * @param {string} text Markdown 原文
 * @param {{maxChunkChars?:number}} [options]
 * @returns {{heading:string, level:number, text:string, startLine:number}[]}
 */
export function chunkMarkdown(text, options = {}) {
  const opt = options || {}
  const maxChunkChars = Number.isFinite(Number(opt.maxChunkChars)) && Number(opt.maxChunkChars) > 0
    ? Math.floor(Number(opt.maxChunkChars))
    : 1200
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
  const chunks = []
  let heading = ''
  let level = 0
  let buffer = []
  let startLine = 1

  function flush() {
    const body = buffer.join('\n').trim()
    if (body) chunks.push({ heading, level, text: body, startLine })
    buffer = []
  }

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(HEADING_RE)
    if (match) {
      if (buffer.length) flush()
      heading = match[2].trim()
      level = match[1].length
      buffer = [lines[i]]
      startLine = i + 1
      continue
    }
    if (!buffer.length) startLine = i + 1
    buffer.push(lines[i])
  }
  flush()

  if (maxChunkChars <= 0) return chunks
  const out = []
  for (const chunk of chunks) {
    if (chunk.text.length <= maxChunkChars) { out.push(chunk); continue }
    const parts = chunk.text.split(/\n\s*\n/)
    let acc = ''
    for (const part of parts) {
      const candidate = acc ? acc + '\n\n' + part : part
      if (candidate.length > maxChunkChars && acc) {
        out.push({ ...chunk, text: acc })
        acc = part
      } else {
        acc = candidate
      }
    }
    if (acc.trim()) out.push({ ...chunk, text: acc.trim() })
  }
  return out
}

/** 显式截断：超长时保留标记，绝不静默丢尾巴。 */
function truncateText(text, max) {
  const source = String(text == null ? '' : text)
  const limit = Math.max(0, Math.floor(Number(max) || 0))
  if (source.length <= limit) return source
  if (limit <= TRUNCATE_MARK.length) return source.slice(0, limit)
  return source.slice(0, limit - TRUNCATE_MARK.length) + TRUNCATE_MARK
}

/**
 * 从 Markdown 里按 query 选相关段落（旧 user-memory 的 `relevant` 注入模式）。
 *
 * 退化设计（**绝不返回空串**，否则用户记忆整体消失）：
 *   - query 为空或全部段落 0 分 → 先保高优先级段（规则/约束/偏好…），再按原文顺序补，
 *     最后按预算头部截断；
 *   - 单段就超预算时直接给该段头部（标题行仍在）。
 *
 * @param {string} text Markdown 原文
 * @param {string} query 当前用户消息
 * @param {number} [budgetChars=1600] 字符预算
 * @param {{maxChunkChars?:number}} [options]
 * @returns {string} 选中段落（按原文顺序拼接），保证长度 ≤ budgetChars
 */
export function selectRelevantChunks(text, query, budgetChars = 1600, options = {}) {
  const source = String(text == null ? '' : text)
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0))
  if (!source.trim() || budget <= 0) return ''
  const chunks = chunkMarkdown(source, options)
  if (!chunks.length) return truncateText(source, budget)

  const queryTokens = tokenize(query)
  if (queryTokens.length) {
    const scores = bm25Scores(queryTokens, chunks.map((chunk) => tokenize(chunk.heading + ' ' + chunk.text)))
    const ranked = chunks
      .map((chunk, index) => ({ chunk, index, score: roundScore(scores[index]) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => (right.score - left.score) || (left.index - right.index))
    if (ranked.length) {
      const chosen = []
      let used = 0
      for (const entry of ranked) {
        const cost = entry.chunk.text.length + (chosen.length ? 2 : 0)
        if (used + cost > budget) continue // 跳过这一块，继续试更小的块（不因为一块超预算就放弃全部）
        chosen.push(entry)
        used += cost
      }
      if (chosen.length) {
        chosen.sort((left, right) => left.index - right.index)
        return truncateText(chosen.map((entry) => entry.chunk.text).join('\n\n'), budget)
      }
    }
  }

  // 退化：保留标题 + 高优先级段 + 头部截断
  const priority = []
  const rest = []
  chunks.forEach((chunk, index) => {
    const high = HIGH_PRIORITY_RE.test(chunk.heading) || HIGH_PRIORITY_RE.test(chunk.text.slice(0, 120))
    if (high) priority.push({ chunk, index })
    else rest.push({ chunk, index })
  })
  const ordered = [...priority, ...rest]
  const chosen = []
  let used = 0
  for (const entry of ordered) {
    if (used >= budget) break
    const cost = entry.chunk.text.length + (chosen.length ? 2 : 0)
    if (used + cost <= budget) {
      chosen.push(entry)
      used += cost
      continue
    }
    if (!chosen.length) return truncateText(entry.chunk.text, budget)
  }
  if (!chosen.length) return truncateText(source, budget)
  chosen.sort((left, right) => left.index - right.index)
  return truncateText(chosen.map((entry) => entry.chunk.text).join('\n\n'), budget)
}
