/**
 * profile-store.js —— 个人画像库（`<userMemoryDir>/personal/profile.json`）。
 *
 * 设计契约：docs/personalised/DESIGN.md §3。
 *
 *   profile.json  = { version: 1, updatedAt: ISO, entries: [Entry] }
 *   backups/<batchId>.json = 每次导入提交前的整库快照（保留最近 20 个）
 *
 * 纪律：
 *   1. **写入串行化**：同进程内所有读写走一条 promise 队列，绝不交叉写；
 *   2. **原子写**：正文落盘复用 lib/config-io.js 的 `writeTextAtomicPre`（tmp → rename）；
 *   3. **损坏隔离不丢数据**：解析失败先把坏文件改名留存（`.corrupt-<ts>`）再回落空库，
 *      诊断信息通过 `load()` 的 `recovered` 返回，绝不静默把用户数据抹掉；
 *   4. fail-soft：每个方法都返回结构化结果，不抛（参数类型错误除外）。
 *
 * 零运行时依赖：只用 node 内置模块与仓库内 lib/*.js。
 */
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { readJsonQuarantinePreSync, writeTextAtomicPre } from '../config-io.js'
import {
  CATEGORY_IDS,
  compareEntriesForRender,
  normalizeEvidence,
  normalizePriority,
  normalizeStatus,
  normalizeTime,
} from './archive-format.js'

/** profile.json 的结构版本。 */
export const PROFILE_VERSION = 1

/** 备份保留数量（DESIGN §3：最近 20 个）。 */
export const MAX_BACKUPS = 20

/** 单条记忆正文上限（超出截断并显式标注，避免一条记忆吃爆注入预算）。 */
export const MAX_ENTRY_TEXT_CHARS = 8000

/** 条目来源类型。 */
export const SOURCE_TYPES = Object.freeze(['manual', 'import', 'agent'])

/**
 * 由 category + evidence 推导 kind（DESIGN §3）。
 *
 * 安全规则优先于分类：**证据未确认（unconfirmed）一律 pending**，即使分类是指令 ——
 * “待确认信息只保存、不注入”是硬边界，不能让一条未确认的“指令”进 G 层。
 */
export function deriveKind(category, evidence) {
  if (category === 'pending' || normalizeEvidence(evidence, 'inferred') === 'unconfirmed') return 'pending'
  if (category === 'instructions' || category === 'corrections') return 'instruction'
  return 'fact'
}

/**
 * 生成条目 id：`pm_<base36 时间><随机>`。
 * @param {number|string} [now] 毫秒时间戳或可解析时间串（缺省 Date.now()）
 * @returns {string}
 */
export function makeId(now) {
  const ms = Number.isFinite(Number(now)) ? Math.floor(Number(now)) : Date.parse(String(now == null ? '' : now))
  const t = Number.isFinite(ms) ? ms : Date.now()
  return 'pm_' + t.toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 生成导入批次 id：`batch_<base36 时间><随机>`。批量备份文件名即用它。
 * @param {number|string} [now]
 * @returns {string}
 */
export function makeBatchId(now) {
  const ms = Number.isFinite(Number(now)) ? Math.floor(Number(now)) : Date.parse(String(now == null ? '' : now))
  const t = Number.isFinite(ms) ? ms : Date.now()
  return 'batch_' + t.toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * 工作区隔离键。与 `lib/index.js` 的 `wsKey()` 保持同一公式（'--' + 路径替换 + '--'），
 * 这样画像库的 workspace 作用域与既有的项目记忆目录一一对应。
 * @param {string} wsPath 工作区绝对路径
 * @returns {string}
 */
export function workspaceKey(wsPath) {
  return '--' + String(wsPath == null ? '' : wsPath).replace(/[\\/:*?"<>|]/g, '-') + '--'
}

function isIsoLike(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
}

function clampText(text) {
  let out = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim()
  if (out.length > MAX_ENTRY_TEXT_CHARS) out = out.slice(0, MAX_ENTRY_TEXT_CHARS - 1) + '…'
  return out
}

function normalizeSource(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const type = SOURCE_TYPES.includes(src.type) ? src.type : 'manual'
  const out = { type }
  if (src.platform != null && String(src.platform).trim()) out.platform = String(src.platform).trim()
  if (src.batchId != null && String(src.batchId).trim()) out.batchId = String(src.batchId).trim()
  return out
}

function normalizeScope(raw) {
  const scope = raw && typeof raw === 'object' ? raw : {}
  if (scope.type === 'workspace' && (scope.key || scope.path)) {
    const key = scope.key != null && String(scope.key).trim()
      ? String(scope.key).trim()
      : workspaceKey(scope.path)
    const wsPath = scope.path != null && String(scope.path).trim() ? String(scope.path).trim() : key
    return { type: 'workspace', key, path: wsPath }
  }
  return { type: 'global' }
}

function cloneEntry(entry) {
  return {
    ...entry,
    scope: { ...entry.scope },
    source: { ...entry.source },
  }
}

/**
 * 归一化一条 Entry：字段校验、缺省补齐、kind 重新推导。
 * 空正文返回 null（调用方据此拒绝写入，而不是存一条空记忆）。
 *
 * @param {object} raw 原始条目（可来自 UI / Agent 工具 / 导入器）
 * @param {{now?: string}} [options] now 为 ISO 时间串（缺省当前时间）
 * @returns {object|null}
 */
export function normalizeEntry(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return null
  const nowIso = isIsoLike(options && options.now) ? options.now : new Date().toISOString()
  const text = clampText(raw.text)
  if (!text) return null
  const category = CATEGORY_IDS.includes(raw.category) ? raw.category : 'identity'
  const evidence = normalizeEvidence(raw.evidence, 'inferred') || 'inferred'
  const createdAt = isIsoLike(raw.createdAt) ? raw.createdAt : nowIso
  const updatedAt = isIsoLike(raw.updatedAt) ? raw.updatedAt : nowIso
  return {
    id: raw.id != null && /^pm_[A-Za-z0-9]+$/.test(String(raw.id)) ? String(raw.id) : makeId(createdAt),
    kind: deriveKind(category, evidence),
    category,
    priority: normalizePriority(raw.priority, 'medium') || 'medium',
    evidence,
    time: normalizeTime(raw.time),
    status: normalizeStatus(raw.status),
    text,
    scope: normalizeScope(raw.scope),
    source: normalizeSource(raw.source),
    pinned: raw.pinned === true,
    createdAt,
    updatedAt,
  }
}

/** 把磁盘上的任意形状收敛成 profile；返回 {profile, warnings}。 */function coerceProfile(value, nowIso) {
  const warnings = []
  const rawEntries = value && Array.isArray(value.entries) ? value.entries : []
  if (!value || !Array.isArray(value.entries)) warnings.push('profile.json 结构异常（缺少 entries 数组），已按空库处理')
  const entries = []
  const seen = new Set()
  for (const raw of rawEntries) {
    const entry = normalizeEntry(raw, { now: nowIso })
    if (!entry) { warnings.push('丢弃一条空正文条目'); continue }
    const id = seen.has(entry.id) ? makeId(entry.createdAt) : entry.id
    seen.add(id)
    entries.push({ ...entry, id })
  }
  return { profile: { version: PROFILE_VERSION, updatedAt: nowIso, entries }, warnings }
}

/**
 * 创建画像库。所有方法异步、串行、fail-soft。
 *
 * @param {{dir: string, now?: () => (number|string)}} options
 *   dir：`<userMemoryDir>/personal`；now：可注入时钟（测试与确定性导入用）
 * @returns {object} 见各方法的 JSDoc
 */
export function createProfileStore(options) {
  const opt = options || {}
  if (!opt.dir || typeof opt.dir !== 'string') throw new Error('createProfileStore: 需要 dir')
  const dir = opt.dir
  const profilePath = path.join(dir, 'profile.json')
  const backupDir = path.join(dir, 'backups')
  const nowFn = typeof opt.now === 'function' ? opt.now : () => Date.now()

  let profile = null
  let lastLoad = { warnings: [], recovered: null }
  let queue = Promise.resolve()

  function nowMs() {
    const value = nowFn()
    const ms = typeof value === 'number' ? value : Date.parse(String(value == null ? '' : value))
    return Number.isFinite(ms) ? ms : Date.now()
  }

  function nowIso() {
    return new Date(nowMs()).toISOString()
  }

  /** 队列：所有读写串行，避免交错写坏 profile.json。 */
  function enqueue(job) {
    const run = queue.then(job, job)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  function ensureLoaded() {
    if (profile) return
    const now = nowIso()
    const read = readJsonQuarantinePreSync(profilePath)
    if (read.ok) {
      const coerced = coerceProfile(read.value, now)
      profile = coerced.profile
      lastLoad = { warnings: coerced.warnings, recovered: null }
      return
    }
    if (read.missing) {
      profile = { version: PROFILE_VERSION, updatedAt: now, entries: [] }
      lastLoad = { warnings: [], recovered: null }
      return
    }
    // 损坏：坏文件已被改名留存（readJsonQuarantinePreSync），这里只回落空库并留痕
    profile = { version: PROFILE_VERSION, updatedAt: now, entries: [] }
    const recovered = { reason: read.reason || 'read failed', quarantined: read.quarantined || '' }
    lastLoad = { warnings: ['profile.json 无法解析，已隔离为 ' + (recovered.quarantined || '(未留存)') + '：' + recovered.reason], recovered }
  }

  async function persist() {
    profile.updatedAt = nowIso()
    const text = JSON.stringify({ version: PROFILE_VERSION, updatedAt: profile.updatedAt, entries: profile.entries }, null, 2) + '\n'
    return writeTextAtomicPre(profilePath, text)
  }

  function pruneBackups() {
    try {
      const files = readdirSync(backupDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const full = path.join(backupDir, name)
          let mtime = 0
          try { mtime = statSync(full).mtimeMs } catch (_) { mtime = 0 }
          return { name, full, mtime }
        })
        .sort((a, b) => (a.mtime - b.mtime) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      while (files.length > MAX_BACKUPS) {
        const oldest = files.shift()
        try { rmSync(oldest.full, { force: true }) } catch (_) { /* 清理失败不影响导入 */ }
      }
    } catch (_) {
      // backups 目录还不存在或不可读：下一次写入会创建，不算错误
    }
  }

  function readBackup(batchId) {
    const safe = String(batchId == null ? '' : batchId).replace(/[^A-Za-z0-9._-]/g, '_')
    const file = path.join(backupDir, safe + '.json')
    try {
      const raw = readFileSync(file, 'utf8')
      return { ok: true, file, value: JSON.parse(raw) }
    } catch (e) {
      const missing = e && e.code === 'ENOENT'
      return { ok: false, file, missing, error: String((e && e.message) || e) }
    }
  }

  /**
   * 读库（损坏则隔离并回落空库）。
   * @returns {Promise<{ok:boolean, entries:object[], updatedAt:string, warnings:string[], recovered:object|null}>}
   */
  async function load() {
    return enqueue(() => {
      profile = null // 每次显式 load 都重读磁盘，便于跨进程/外部改动可见
      ensureLoaded()
      return {
        ok: true,
        entries: profile.entries.map(cloneEntry),
        updatedAt: profile.updatedAt,
        warnings: lastLoad.warnings.slice(),
        recovered: lastLoad.recovered,
      }
    })
  }

  /**
   * 列出条目（按优先级→createdAt→id 排序，结果确定）。
   * @param {{scope?:'all'|'global'|'workspace', workspace?:string, category?:string, kind?:string, q?:string, includePending?:boolean}} [filter]
   * @returns {Promise<object[]>}
   */
  async function list(filter) {
    return enqueue(() => {
      ensureLoaded()
      const f = filter || {}
      const scope = f.scope === 'global' || f.scope === 'workspace' ? f.scope : 'all'
      const wsKey = f.workspace != null ? String(f.workspace) : ''
      const q = String(f.q == null ? '' : f.q).trim().toLowerCase()
      const includePending = f.includePending !== false
      return profile.entries
        .filter((entry) => {
          if (!includePending && entry.kind === 'pending') return false
          if (scope === 'global' && entry.scope.type !== 'global') return false
          if (scope === 'workspace' && (entry.scope.type !== 'workspace' || (wsKey && entry.scope.key !== wsKey))) return false
          if (f.category && entry.category !== f.category) return false
          if (f.kind && entry.kind !== f.kind) return false
          if (f.pinned === true && entry.pinned !== true) return false
          if (q && !entry.text.toLowerCase().includes(q)) return false
          return true
        })
        .sort(compareEntriesForRender)
        .map(cloneEntry)
    })
  }

  /**
   * 按 id 取一条。
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async function get(id) {
    return enqueue(() => {
      ensureLoaded()
      const hit = profile.entries.find((entry) => entry.id === String(id))
      return hit ? cloneEntry(hit) : null
    })
  }

  /**
   * 新增或更新一条。已有 id 时保留 createdAt；正文为空拒绝写入。
   * @param {object} raw
   * @returns {Promise<{ok:boolean, entry?:object, error?:string}>}
   */
  async function upsert(raw) {
    return enqueue(async () => {
      ensureLoaded()
      const now = nowIso()
      const normalized = normalizeEntry(raw, { now })
      if (!normalized) return { ok: false, error: '条目正文为空' }
      const index = profile.entries.findIndex((entry) => entry.id === normalized.id)
      let saved
      if (index >= 0) {
        const before = profile.entries[index]
        saved = { ...normalized, createdAt: before.createdAt, updatedAt: now }
        profile.entries[index] = saved
      } else {
        saved = { ...normalized, createdAt: now, updatedAt: now }
        profile.entries.push(saved)
      }
      const write = await persist()
      if (!write.ok) return { ok: false, error: write.error || '写入 profile.json 失败' }
      return { ok: true, entry: cloneEntry(saved) }
    })
  }

  /**
   * 删除若干条目。
   * @param {string|string[]} ids
   * @returns {Promise<{ok:boolean, deleted:number, missing:string[], error?:string}>}
   */
  async function remove(ids) {
    return enqueue(async () => {
      ensureLoaded()
      const wanted = (Array.isArray(ids) ? ids : [ids]).map(String)
      const missing = []
      let deleted = 0
      for (const id of wanted) {
        const index = profile.entries.findIndex((entry) => entry.id === id)
        if (index < 0) { missing.push(id); continue }
        profile.entries.splice(index, 1)
        deleted += 1
      }
      if (!deleted) return { ok: true, deleted: 0, missing }
      const write = await persist()
      if (!write.ok) return { ok: false, deleted: 0, missing, error: write.error || '写入 profile.json 失败' }
      return { ok: true, deleted, missing }
    })
  }

  /**
   * 写一份整库快照到 backups/<batchId>.json，并只保留最近 20 份。
   * @param {string} [batchId] 缺省自动生成
   * @returns {Promise<{ok:boolean, batchId:string, path?:string, error?:string}>}
   */
  async function snapshot(batchId) {
    return enqueue(async () => {
      ensureLoaded()
      const id = batchId != null && String(batchId).trim() ? String(batchId).trim() : makeBatchId(nowMs())
      const safe = id.replace(/[^A-Za-z0-9._-]/g, '_')
      const file = path.join(backupDir, safe + '.json')
      const payload = {
        batchId: id,
        createdAt: nowIso(),
        version: PROFILE_VERSION,
        entries: profile.entries,
      }
      const write = await writeTextAtomicPre(file, JSON.stringify(payload, null, 2) + '\n')
      if (!write.ok) return { ok: false, batchId: id, error: write.error || '写入备份失败' }
      pruneBackups()
      return { ok: true, batchId: id, path: file }
    })
  }

  /**
   * 用 batchId 对应的备份整库还原（导入撤销）。
   * @param {string} batchId
   * @returns {Promise<{ok:boolean, restored?:number, missing?:boolean, error?:string}>}
   */
  async function restore(batchId) {
    return enqueue(async () => {
      const read = readBackup(batchId)
      if (!read.ok) {
        return { ok: false, missing: read.missing === true, error: read.missing ? '备份不存在：' + String(batchId) : read.error }
      }
      const now = nowIso()
      const coerced = coerceProfile(read.value, now)
      profile = coerced.profile
      const write = await persist()
      if (!write.ok) return { ok: false, error: write.error || '写入 profile.json 失败' }
      return { ok: true, restored: profile.entries.length }
    })
  }

  /**
   * 批量应用写操作（导入提交用）：可选先拍快照，再一次落盘。
   *
   * ops 元素形如 `{op:'add', entry}` / `{op:'update', entry}` / `{op:'merge', entry}` / `{op:'remove', id}`。
   * 给了 batchId 时会给新增/更新条目打上 `source.batchId`。
   *
   * @param {object[]} ops
   * @param {{batchId?:string, snapshot?:boolean}} [options]
   * @returns {Promise<{ok:boolean, added:number, updated:number, removed:number, batchId:string|null, warnings:string[], error?:string}>}
   */
  async function applyOps(ops, options = {}) {
    return enqueue(async () => {
      ensureLoaded()
      const list = Array.isArray(ops) ? ops : []
      const batchId = options && options.batchId != null ? String(options.batchId) : null
      const wantSnapshot = options && options.snapshot === true && batchId
      const now = nowIso()
      const warnings = []
      if (wantSnapshot) {
        const safe = batchId.replace(/[^A-Za-z0-9._-]/g, '_')
        const snap = await writeTextAtomicPre(path.join(backupDir, safe + '.json'), JSON.stringify({
          batchId,
          createdAt: now,
          version: PROFILE_VERSION,
          entries: profile.entries,
        }, null, 2) + '\n')
        if (!snap.ok) return { ok: false, added: 0, updated: 0, removed: 0, batchId, warnings, error: snap.error || '写入备份失败' }
        pruneBackups()
      }
      let added = 0
      let updated = 0
      let removed = 0
      for (const op of list) {
        if (!op || typeof op !== 'object') { warnings.push('忽略非对象操作'); continue }
        const kind = String(op.op || '')
        if (kind === 'remove') {
          const index = profile.entries.findIndex((entry) => entry.id === String(op.id))
          if (index < 0) { warnings.push('删除目标不存在：' + String(op.id)); continue }
          profile.entries.splice(index, 1)
          removed += 1
          continue
        }
        if (kind !== 'add' && kind !== 'update' && kind !== 'merge') { warnings.push('忽略未知操作：' + kind); continue }
        const normalized = normalizeEntry(op.entry, { now })
        if (!normalized) { warnings.push('忽略空正文条目'); continue }
        const entry = batchId ? { ...normalized, source: { ...normalized.source, batchId } } : normalized
        const index = profile.entries.findIndex((item) => item.id === entry.id)
        if (index >= 0) {
          const before = profile.entries[index]
          profile.entries[index] = { ...entry, createdAt: before.createdAt, updatedAt: now }
          updated += 1
        } else {
          profile.entries.push({ ...entry, createdAt: entry.createdAt || now, updatedAt: now })
          added += 1
        }
      }
      if (!added && !updated && !removed) return { ok: true, added: 0, updated: 0, removed: 0, batchId, warnings }
      const write = await persist()
      if (!write.ok) return { ok: false, added: 0, updated: 0, removed: 0, batchId, warnings, error: write.error || '写入 profile.json 失败' }
      return { ok: true, added, updated, removed, batchId, warnings }
    })
  }

  /**
   * 统计（供 personalState 路由）。
   * @returns {Promise<{total:number, byKind:object, byCategory:object, workspaces:{key:string,path:string,count:number}[], pending:number, pinned:number}>}
   */
  async function stats() {
    return enqueue(() => {
      ensureLoaded()
      const byKind = { instruction: 0, fact: 0, pending: 0 }
      const byCategory = Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0]))
      const workspaces = new Map()
      let pinned = 0
      for (const entry of profile.entries) {
        byKind[entry.kind] = (byKind[entry.kind] || 0) + 1
        byCategory[entry.category] = (byCategory[entry.category] || 0) + 1
        if (entry.pinned) pinned += 1
        if (entry.scope.type === 'workspace') {
          const key = entry.scope.key
          const hit = workspaces.get(key) || { key, path: entry.scope.path, count: 0 }
          hit.count += 1
          workspaces.set(key, hit)
        }
      }
      return {
        total: profile.entries.length,
        byKind,
        byCategory,
        workspaces: [...workspaces.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
        pending: byKind.pending || 0,
        pinned,
      }
    })
  }

  return {
    dir,
    profilePath,
    backupDir,
    load,
    list,
    get,
    upsert,
    remove,
    snapshot,
    restore,
    applyOps,
    stats,
  }
}
