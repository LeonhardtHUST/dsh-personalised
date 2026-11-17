/**
 * smoke-test-personal-relevance —— 相关性检索（分词 / BM25-lite / 预算 / Markdown 段落截取）。
 *
 * 契约：docs/personalised/DESIGN.md §2（P/W 层按相关性注入、旧 MEMORY.md 的 relevant 模式）。
 * 判据重点：pending 永不入候选、pinned 无视阈值、同分排序确定、预算硬约束、
 *           **query 为空或无命中时绝不返回空串**（否则用户记忆整体静默消失）。
 * 纯 Node、零依赖、零网络。
 */
import { readFileSync } from 'node:fs'
import {
  bm25Scores,
  chunkMarkdown,
  selectRelevant,
  selectRelevantChunks,
  tokenize,
} from '../../lib/personal/relevance.js'

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok - ' + name) } else { fail++; console.error('  FAIL - ' + name) } }
const eq = (a, b, name) => {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  ok(ja === jb, name + (ja === jb ? '' : ' got=' + ja + ' want=' + jb))
}

const mk = (id, text, extra = {}) => ({
  id,
  kind: 'fact',
  category: 'identity',
  priority: 'medium',
  text,
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const ENTRIES = [
  mk('pm_a', '项目 A 使用 DeepSeek Harness 与 PowerShell 脚本，目标迁移到 rc3。', { category: 'projects', priority: 'high' }),
  mk('pm_b', '用户住在上海，喜欢清淡饮食。'),
  mk('pm_c', '项目 A 的截止时间还没确认。', { kind: 'pending', category: 'pending' }),
  mk('pm_d', '回答时先给结论，再给推导。', { kind: 'instruction', priority: 'low' }),
]

console.log('[R1] tokenize：拉丁整词小写 / CJK 单字+双字 gram / 去停用词')
{
  const latin = tokenize('DeepSeek Harness dsh-personalised RC3')
  ok(latin.includes('deepseek') && latin.includes('harness'), '拉丁词小写整词')
  ok(latin.includes('dsh') && latin.includes('personalised'), '连字符拆成两个词')
  ok(latin.includes('rc3'), '数字字母混合词保留')
  ok(!latin.includes('the') && !latin.includes('user'), '拉丁停用词被去掉')
  const cjk = tokenize('用户的偏好')
  ok(cjk.includes('偏好'), 'CJK 双字 gram 命中“偏好”')
  ok(!cjk.includes('的'), 'CJK 停用单字被去掉')
  ok(tokenize('我们').length === 0, '全停用词的 CJK 串切出 0 个 token')
  eq(tokenize(''), [], '空文本零 token')
  eq(tokenize(null), [], 'null 零 token')
  eq(tokenize('用户偏好').slice(0, 3), ['用', '用户', '户'], 'CJK 按单字/双字交替产出（首字先出）')
}

console.log('[R2] bm25Scores：相关文档分更高、空输入安全')
{
  const docs = ['项目 A 要迁移到 rc3', '今天天气不错', '项目 B 与项目 A 都改用 PowerShell']
  const scores = bm25Scores(tokenize('项目 rc3'), docs)
  eq(scores.length, docs.length, '分数与文档数等长')
  ok(scores[0] > scores[2] && scores[0] > scores[1], '命中更多关键词的文档分最高')
  ok(scores[1] === 0, '完全无关文档 0 分')
  eq(bm25Scores([], docs), [0, 0, 0], '空查询全 0 分（不产生 NaN）')
  eq(bm25Scores('x', []), [], '空文档集合返回空数组')
  eq(bm25Scores(tokenize('a b'), ['a', 'a']), bm25Scores(tokenize('a b'), ['a', 'a']), '打分确定')
}

console.log('[R3] selectRelevant：相关性排序 / pending 排除 / 预算 / topK / 确定性')
{
  const hit = selectRelevant({ query: '项目 A 迁移', entries: ENTRIES, topK: 8, budgetChars: 1600 })
  eq(hit.items[0].entry.id, 'pm_a', '最相关条目排第一')
  ok(!hit.items.some((item) => item.entry.id === 'pm_c'), 'pending 条目永不入候选（即使查询命中）')
  eq(hit.considered, 3, 'considered = 非 pending 候选数')
  ok(hit.chars <= 1600, '总字符不超预算')
  eq(hit.items.reduce((s, item) => s + item.chars, 0), hit.chars, 'chars 账与实际条成本一致')

  const top1 = selectRelevant({ query: '项目 A 迁移', entries: ENTRIES, topK: 1, budgetChars: 1600 })
  eq(top1.items.length, 1, 'topK=1 只给一条')
  eq(top1.dropped, 2, 'dropped = 候选 - 入选')
  const tiny = selectRelevant({ query: '项目 A 迁移', entries: ENTRIES, topK: 8, budgetChars: 24 })
  eq(tiny.items.length, 1, '预算极小时仍保留一条（不整组丢弃）')
  ok(tiny.items[0].truncated === true && tiny.chars <= 24, '该条被显式标注截断且不超预算')

  eq(selectRelevant({ query: '项目 A 迁移', entries: ENTRIES, budgetChars: 0 }).items, [], 'budgetChars=0 显式表示本轮不注入（不回落默认值）')
  const filtered = selectRelevant({ query: '项目 A 迁移', entries: ENTRIES, minScore: 999 })
  eq(filtered.items, [], 'minScore 高于所有分数 → 无相关条目')
  const noQuery = selectRelevant({ query: '', entries: ENTRIES, minScore: 999 })
  ok(noQuery.items.length > 0, 'query 为空时忽略 minScore（退化排序而不是不注入）')
  eq(noQuery.items[0].entry.id, 'pm_a', '退化排序按优先级：high 在前')
  eq(noQuery.items.map((item) => item.entry.id), ['pm_a', 'pm_b', 'pm_d'], '退化排序稳定（高→中→低）')

  const pinnedEntries = ENTRIES.map((entry) => (entry.id === 'pm_b' ? { ...entry, pinned: true, text: '与主题无关但已置顶' } : entry))
  const pinned = selectRelevant({ query: '项目 A', entries: pinnedEntries, minScore: 999 })
  eq(pinned.items.map((item) => item.entry.id), ['pm_b'], 'pinned 条目无视相关性阈值')

  const dual = [
    mk('pm_z', '同样内容', { createdAt: '2026-02-01T00:00:00.000Z' }),
    mk('pm_y', '同样内容', { createdAt: '2026-01-01T00:00:00.000Z' }),
    mk('pm_x', '同样内容', { priority: 'high' }),
  ]
  const tie = selectRelevant({ query: '同样内容', entries: dual })
  eq(tie.items.map((item) => item.entry.id), ['pm_x', 'pm_y', 'pm_z'], '同分排序：优先级→createdAt→id')

  eq(selectRelevant({ query: '项目 A 迁移', entries: ENTRIES }), selectRelevant({ query: '项目 A 迁移', entries: ENTRIES }), '同输入两次结果全等')
  eq(selectRelevant({ entries: [] }).items, [], '空条目集合返回空')
  eq(selectRelevant({ entries: [null, { text: '' }] }).items, [], '畸形条目被过滤')
}

console.log('[R4] chunkMarkdown：标题分段 / 导语 / 超长段拆分')
{
  const md = ['导语一行。', '', '## 用户规则', '- 用中文回答', '', '## 2026-08-14', '今天修了注入顺序。', '', '### 子标题', '细节若干。'].join('\n')
  const chunks = chunkMarkdown(md)
  eq(chunks.map((c) => c.heading), ['', '用户规则', '2026-08-14', '子标题'], '按标题切块，首个标题前是导语块')
  ok(chunks[0].text.includes('导语一行'), '导语块正文')
  eq(chunks[1].level, 2, '记录标题层级')
  eq(chunks[2].startLine, 6, '记录起始行号')
  eq(chunks.map((c) => c.text).join('\n\n').includes('细节若干'), true, '所有正文都被保留')

  const long = '## 长段\n' + Array.from({ length: 12 }, (_, i) => '第' + i + '段结论句，长度够触发拆分。').join('\n\n')
  const split = chunkMarkdown(long, { maxChunkChars: 60 })
  ok(split.length > 1, '超长段按空行拆分（' + split.length + ' 块）')
  ok(split.every((c) => c.text.length <= 60 + 40), '拆分后每块接近上限')
  eq(chunkMarkdown(md), chunkMarkdown(md), '切块确定')
  eq(chunkMarkdown(''), [], '空文本零块')
}

console.log('[R5] selectRelevantChunks：命中只给相关段 / 预算 / 空查询退化不返回空')
{
  const md = [
    '# 用户记忆',
    '',
    '## 用户规则',
    '- 必须用中文回答，不要输出长表格。',
    '',
    '## 2026-08-14',
    '今天处理了个人记忆导入的细节，顺便修了天气查询脚本。',
    '',
    '## 项目 A',
    '项目 A 正在从旧版迁移到 rc3，使用 PowerShell 与 Node 26。',
  ].join('\n')

  const hit = selectRelevantChunks(md, '项目 A 迁移 rc3', 400)
  ok(hit.includes('项目 A 正在从旧版迁移'), '命中段被选中')
  ok(!hit.includes('天气查询'), '无关段不入选')
  ok(hit.length <= 400, '不超预算')

  const empty = selectRelevantChunks(md, '', 200)
  ok(empty.length > 0, 'query 为空时仍返回内容（绝不返回空串）')
  ok(empty.includes('用户规则'), '退化时先保高优先级段（规则）')
  ok(empty.includes('必须用中文回答'), '高优先级段不是空壳（正文也在）')
  ok(empty.length <= 200, '退化截取同样受预算约束')

  const noHit = selectRelevantChunks(md, '量子计算 区块链', 120)
  ok(noHit.length > 0, 'query 全无命中时仍返回内容')
  ok(noHit.length <= 120, '无命中退化受预算约束')

  const tiny = selectRelevantChunks(md, '', 40)
  ok(tiny.length > 0 && tiny.length <= 40, '极小预算也保留头部（不返回空）')
  eq(selectRelevantChunks(md, '项目 A', 0), '', '预算 0 → 空串（调用方明确要求不注入）')
  eq(selectRelevantChunks('', '项目 A', 400), '', '空原文 → 空串')
  eq(selectRelevantChunks(md, '项目 A 迁移 rc3', 400), hit, '同输入两次结果全等')

  const hugeSingle = '## 超长段\n' + '很长的内容。'.repeat(200)
  const head = selectRelevantChunks(hugeSingle, '', 100)
  ok(head.length <= 100 && head.startsWith('## 超长段'), '单段超预算时保留标题并头部截断')
  ok(head.includes('已截断'), '截断有显式标记（不静默丢尾巴）')
}

console.log('[R6] 纯函数纪律')
{
  const src = readFileSync(new URL('../../lib/personal/relevance.js', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/from ['"]node:/.test(code), '不读盘/不依赖 node 内置')
  ok(!/\bfetch\s*\(|Date\.now|Math\.random/.test(code), '无网络、无时钟、无随机（结果可复现）')
  ok(!src.startsWith('\uFEFF'), '无 BOM')
}

console.log('\n[personal-relevance] pass=' + pass + ' fail=' + fail)
if (fail) process.exit(1)
console.log('PASS')
