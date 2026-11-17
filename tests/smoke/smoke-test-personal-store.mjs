/**
 * smoke-test-personal-store —— 个人画像库（profile.json）读写契约。
 *
 * 契约：docs/personalised/DESIGN.md §3。判据重点：
 *   - kind 推导、字段归一化、空白正文拒绝；
 *   - 写入串行化 + 原子写（并发 upsert 全部落盘、进程重开后仍可读）；
 *   - 损坏文件隔离不丢数据（.corrupt-* 里能找到原文，库回落空而不是静默覆盖）；
 *   - 导入批次快照 / 还原 / 备份只留最近 20 份。
 * 纯 Node、零依赖、只用临时目录与虚构数据。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MAX_BACKUPS,
  PROFILE_VERSION,
  createProfileStore,
  deriveKind,
  makeBatchId,
  makeId,
  normalizeEntry,
  workspaceKey,
} from '../../lib/personal/profile-store.js'

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok - ' + name) } else { fail++; console.error('  FAIL - ' + name) } }
const eq = (a, b, name) => {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  ok(ja === jb, name + (ja === jb ? '' : ' got=' + ja + ' want=' + jb))
}
const iso = (s) => new Date(s).toISOString()

const root = mkdtempSync(path.join(tmpdir(), 'personal-store-'))
const fixedNow = Date.parse('2026-11-17T20:35:00.000Z')
const newStore = (name) => createProfileStore({ dir: path.join(root, name), now: () => fixedNow })

try {
  console.log('[S1] deriveKind / makeId / normalizeEntry')
  {
    eq(deriveKind('instructions', 'explicit'), 'instruction', 'instructions → instruction')
    eq(deriveKind('corrections', 'explicit'), 'instruction', 'corrections → instruction')
    eq(deriveKind('pending', 'explicit'), 'pending', 'pending 分类 → pending')
    eq(deriveKind('identity', 'unconfirmed'), 'pending', 'evidence=unconfirmed → pending')
    eq(deriveKind('instructions', 'unconfirmed'), 'pending', '未确认的“指令”也是 pending（安全规则优先，不进 G 层）')
    eq(deriveKind('identity', 'inferred'), 'fact', '其余 → fact')

    const id = makeId(fixedNow)
    ok(/^pm_[a-z0-9]+$/.test(id), 'id 形如 pm_<base36时间><随机>(' + id + ')')
    ok(makeId(fixedNow) !== makeId(fixedNow), '同一毫秒两次生成不撞 id')
    ok(/^batch_/.test(makeBatchId(fixedNow)), '批次 id 形如 batch_*')

    const e = normalizeEntry({
      category: 'instructions',
      priority: '高',
      evidence: '明示',
      time: '时间未知',
      status: '瞎写',
      text: '  优先用中文回答。  ',
      scope: { type: 'workspace', path: 'C:\\work\\demo' },
      source: { type: 'agent' },
      pinned: true,
    }, { now: iso(fixedNow) })
    eq([e.kind, e.category, e.priority, e.evidence], ['instruction', 'instructions', 'high', 'explicit'], '标签归一化 + kind 推导')
    eq([e.time, e.status], [null, null], '时间未知/非法状态归一为 null')
    eq(e.text, '优先用中文回答。', '正文去首尾空白')
    eq(e.scope.key, workspaceKey('C:\\work\\demo'), 'workspace key 与仓库 wsKey 公式一致')
    eq(e.scope.path, 'C:\\work\\demo', 'workspace path 保留')
    eq([e.source.type, e.pinned], ['agent', true], 'source / pinned 保留')
    eq([e.createdAt, e.updatedAt], [iso(fixedNow), iso(fixedNow)], '时间戳补 ISO')
    eq(normalizeEntry({ text: '   ' }), null, '空白正文 → null（不存空记忆）')
    eq(normalizeEntry({ text: 'x', category: '不存在的类' }).category, 'identity', '未知分类落 identity')
    eq(normalizeEntry({ text: 'x', priority: 'URGENT' }).priority, 'medium', '未知优先级落 medium')
    const long = normalizeEntry({ text: 'x'.repeat(9000) })
    ok(long.text.length <= 8000 && long.text.endsWith('…'), '超长正文截断并显式标注省略号')
    const fixedId = normalizeEntry({ id: 'pm_keepme', text: 'x' })
    eq(fixedId.id, 'pm_keepme', '合法 id 保留（供更新用）')
    ok(/^pm_/.test(normalizeEntry({ id: 'weird id', text: 'x' }).id), '非法 id 重新生成')
  }

  console.log('[S2] 首次加载 / upsert / get / list 过滤')
  {
    const dir = path.join(root, 'basic')
    const store = createProfileStore({ dir, now: () => fixedNow })
    const first = await store.load()
    eq([first.ok, first.entries, first.recovered], [true, [], null], '空目录加载为空库且无 recovered')
    eq(existsSync(path.join(dir, 'profile.json')), false, '只读不落盘')

    const add = await store.upsert({
      category: 'identity', evidence: 'explicit', text: '用户是后端工程师。',
    })
    eq(add.ok, true, 'upsert 成功')
    eq(add.entry.createdAt, iso(fixedNow), 'createdAt = 注入时钟')
    const updated = await store.upsert({ id: add.entry.id, text: '用户是资深后端工程师。' })
    eq(updated.entry.createdAt, add.entry.createdAt, '更新保留 createdAt')
    eq(updated.entry.text, '用户是资深后端工程师。', '更新正文生效')

    await store.upsert({ category: 'projects', priority: 'high', text: '项目A 在迁移 rc3。', scope: { type: 'workspace', path: 'C:\\work\\demo' } })
    await store.upsert({ category: 'pending', text: '用户是否换过工作？' })
    await store.upsert({ category: 'instructions', priority: 'high', text: '不要输出长表格。' })

    eq((await store.get(add.entry.id)).text, '用户是资深后端工程师。', 'get 命中')
    eq(await store.get('pm_missing'), null, 'get 未命中返回 null')
    eq((await store.list()).length, 4, 'list 默认全量')
    eq((await store.list({ scope: 'global' })).length, 3, 'scope=global 过滤掉 workspace 条目')
    eq((await store.list({ scope: 'workspace', workspace: workspaceKey('C:\\work\\demo') })).length, 1, 'scope=workspace 按 key 过滤')
    eq((await store.list({ scope: 'workspace', workspace: workspaceKey('C:\\other') })).length, 0, '其他工作区一条都不给')
    eq((await store.list({ category: 'pending' })).length, 1, 'category 过滤')
    eq((await store.list({ kind: 'instruction' })).length, 1, 'kind 过滤')
    eq((await store.list({ kind: 'fact' })).length, 2, 'fact 计数')
    eq((await store.list({ q: 'RC3' })).length, 1, '搜索不区分大小写')
    eq((await store.list({ includePending: false })).length, 3, 'includePending=false 排除待确认')

    const stats = await store.stats()
    eq(stats.total, 4, 'stats 总数')
    eq([stats.byKind.instruction, stats.byKind.fact, stats.byKind.pending], [1, 2, 1], 'stats byKind')
    eq(stats.workspaces.length, 1, 'stats 工作区计数')
    eq(stats.pinned, 0, 'stats pinned')

    const reopened = await createProfileStore({ dir, now: () => fixedNow }).load()
    eq(reopened.entries.length, 4, '新实例重开仍读到 4 条（已落盘）')
    eq(reopened.entries.find((e) => e.category === 'projects').scope.type, 'workspace', 'workspace 作用域持久化')
    const raw = JSON.parse(readFileSync(path.join(dir, 'profile.json'), 'utf8'))
    eq(raw.version, PROFILE_VERSION, 'profile.json 带 version')
    eq(Array.isArray(raw.entries) && raw.entries.length, 4, 'profile.json 带 entries')
  }

  console.log('[S3] 写入串行化：并发 upsert 不丢写、不留半截 JSON')
  {
    const dir = path.join(root, 'concurrent')
    const store = createProfileStore({ dir, now: () => fixedNow })
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      store.upsert({ category: 'preferences', text: '并发条目 ' + i })))
    ok(results.every((r) => r.ok), '12 个并发 upsert 全部返回 ok')
    eq((await createProfileStore({ dir, now: () => fixedNow }).load()).entries.length, 12, '全部落盘（串行化生效）')
    eq(JSON.parse(readFileSync(path.join(dir, 'profile.json'), 'utf8')).entries.length, 12, '磁盘 JSON 完整可解析')
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'))
    eq(leftovers, [], '目录里没有残留 .tmp（原子写清理干净）')
    eq((await store.remove(results.slice(0, 2).map((r) => r.entry.id))).deleted, 2, 'remove 支持批量')
    eq((await store.remove('pm_missing')).missing, ['pm_missing'], 'remove 报告未命中')
    eq((await store.load()).entries.length, 10, 'remove 已落盘')
  }

  console.log('[S4] 快照 / 还原 / 备份保留最近 20 份')
  {
    const dir = path.join(root, 'backup')
    const store = createProfileStore({ dir, now: () => fixedNow })
    const before = await store.load()
    const batchId = 'batch_test0001'
    const snap = await store.snapshot(batchId)
    eq([snap.ok, snap.batchId], [true, batchId], 'snapshot 成功')
    ok(existsSync(path.join(dir, 'backups', batchId + '.json')), '备份文件按 batchId 命名')

    await store.upsert({ category: 'identity', text: '导入期间新增的一条。' })
    eq((await store.load()).entries.length, before.entries.length + 1, '导入后条目增加')
    const undo = await store.restore(batchId)
    eq([undo.ok, undo.restored], [true, before.entries.length], 'restore 回到导入前')
    eq((await createProfileStore({ dir, now: () => fixedNow }).load()).entries.length, before.entries.length, '还原已落盘')
    eq((await store.restore('batch_missing')).ok, false, '不存在的批次还原失败')
    eq((await store.restore('batch_missing')).missing, true, '缺失与损坏可区分（missing=true）')

    for (let i = 0; i < 25; i += 1) {
      await store.snapshot('batch_' + String(i).padStart(3, '0'))
    }
    const backups = readdirSync(path.join(dir, 'backups')).filter((n) => n.endsWith('.json'))
    eq(backups.length, MAX_BACKUPS, '备份只保留最近 ' + MAX_BACKUPS + ' 份')
    ok(!backups.includes('batch_000.json'), '最旧的备份被清理')
    ok(backups.includes('batch_024.json'), '最新的备份保留')
  }

  console.log('[S5] applyOps + 批次标记（导入提交用）')
  {
    const dir = path.join(root, 'apply')
    const store = createProfileStore({ dir, now: () => fixedNow })
    const batchId = 'batch_apply_01'
    const res = await store.applyOps([
      { op: 'add', entry: { category: 'identity', text: '新增：常驻上海。' } },
      { op: 'update', entry: { category: 'identity', text: '新增：常驻上海。', id: 'pm_doesnotexist' } },
    ], { batchId, snapshot: true })
    eq([res.ok, res.added, res.updated], [true, 2, 0], '不存在的 update 目标退化为新增（不静默丢内容）')
    eq((await store.list()).every((e) => e.source.batchId === batchId), true, '批次 id 写进 source.batchId')
    ok(existsSync(path.join(dir, 'backups', batchId + '.json')), 'applyOps 支持先拍快照')
    const target = (await store.list())[0]
    const upd = await store.applyOps([{ op: 'update', entry: { ...target, text: '改过的正文' } }], { batchId: 'batch_apply_02' })
    eq([upd.ok, upd.updated], [true, 1], '更新已存在条目')
    eq((await store.get(target.id)).text, '改过的正文', '更新落盘')
    const del = await store.applyOps([{ op: 'remove', id: target.id }])
    eq([del.ok, del.removed], [true, 1], 'remove 操作生效')
    const bad = await store.applyOps([{ op: 'frobnicate' }, null])
    eq([bad.ok, bad.warnings.length >= 2], [true, true], '未知操作/非对象只给 warning，不抛')
  }

  console.log('[S6] 损坏隔离：坏文件改名留存，数据不丢，库回落空而不是静默覆盖')
  {
    const corruptDir = path.join(root, 'corrupt')
    mkdirSync(corruptDir, { recursive: true })
    const corruptFile = path.join(corruptDir, 'profile.json')
    const original = '{"version":1,"entries":[{"text":"这条数据坏了但必须留存"'
    writeFileSync(corruptFile, original, 'utf8')
    const store = createProfileStore({ dir: corruptDir, now: () => fixedNow })
    const loaded = await store.load()
    eq(loaded.entries, [], '损坏库回落空库')
    ok(loaded.recovered && typeof loaded.recovered.reason === 'string', 'recovered 记录解析失败原因')
    ok(loaded.recovered.quarantined && existsSync(loaded.recovered.quarantined), '坏文件被改名留存（.corrupt-*）')
    eq(readFileSync(loaded.recovered.quarantined, 'utf8'), original, '留存文件内容 = 原坏文件（一个字节没丢）')
    ok(loaded.warnings.some((w) => w.includes('无法解析')), '警告可观测（不静默）')
    const after = await store.upsert({ category: 'identity', text: '重建后的第一条。' })
    eq(after.ok, true, '损坏后仍可写入新库')
    eq((await store.load()).entries.length, 1, '新库可读')
    ok(existsSync(loaded.recovered.quarantined), '再次读写不会碰坏留存的证据文件')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[personal-store] pass=' + pass + ' fail=' + fail)
if (fail) process.exit(1)
console.log('PASS')
