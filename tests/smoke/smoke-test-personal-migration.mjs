/**
 * smoke-test-personal-migration —— 旧配置迁移 + 双路由别名契约。
 *
 * 被测模块：lib/personal/legacy-migration.js（纯模块，只吃临时夹具路径）。
 * 判据重点：
 *   - 只有 canonical 配置缺失时才迁移；normal(dsh-auto-memory.json) 覆盖 pre(dsh-auto-memory-pre.json)；
 *   - 旧配置文件**逐字节原样保留**（成功/失败/解析失败都不隔离、不改写）；
 *   - canonical 已存在（哪怕内容是 `{}`）即权威，旧文件不再被读取（旧文件坏了也不抛）；
 *   - 写盘失败抛 `config migration failed:` 且不落 canonical；锁被活主持有时抛 CONFIG_LOCK_BUSY；
 *   - 读侧严格：非法 JSON / 非对象 / 非普通文件 / 符号链接一律拒绝；
 *   - 白名单优先级：DSH_PERSONALISED_ALLOWED_HOSTS（含空串 fail-closed）> 旧变量 > 配置项；
 *   - 路由别名共享同一 handler 闭包，非 canonical 前缀直接拒绝。
 * 纯 Node、零依赖；只用 mkdtemp 夹具与虚构数据，不读真实 DSH_HOME。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  API_PREFIX,
  CONFIG_FILENAME,
  LEGACY_API_PREFIX,
  compatibleRoutes,
  migrateLegacyConfigSync,
  panelAllowedHostsSource,
  readConfigStrictSync,
} from '../../lib/personal/legacy-migration.js'

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok - ' + name) } else { fail++; console.error('  FAIL - ' + name) } }
const eq = (a, b, name) => {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  ok(ja === jb, name + (ja === jb ? '' : ' got=' + ja + ' want=' + jb))
}

/** 临时根取 realpath：lock 的 canonical() 会 realpath，路径一致才能命中夹具锁文件。 */
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-personal-migration-')))
const caseDir = (name) => { const dir = path.join(root, name); mkdirSync(dir, { recursive: true }); return dir }
const readOrNull = (file) => { try { return readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const writeJsonText = (file, value) => writeFileSync(file, JSON.stringify(value), 'utf8')
const entriesOf = (dir) => readdirSync(dir).sort()
const lockArtifacts = (dir) => entriesOf(dir).filter((name) => name.includes('.lock'))
const corruptArtifacts = (dir) => entriesOf(dir).filter((name) => name.includes('.corrupt-'))
const errorOf = (fn) => { try { fn(); return null } catch (e) { return e } }

try {
  console.log('[S1] 常量与路由前缀')
  ok(API_PREFIX === '/api/dsh-personalised', 'canonical API prefix')
  ok(LEGACY_API_PREFIX === '/api/dsh-auto-memory', 'legacy API prefix')
  ok(CONFIG_FILENAME === 'dsh-personalised.json', 'canonical config filename')

  console.log('[S2] 只有旧配置：迁移为 canonical 并原样保留旧字节')
  {
    const dir = caseDir('normal-only')
    const file = path.join(dir, CONFIG_FILENAME)
    const legacyFile = path.join(dir, 'dsh-auto-memory.json')
    const legacyText = '{\n  "memoryRoot": "fixture-memory",\n  "retentionDays": 30\n}'
    writeFileSync(legacyFile, legacyText, 'utf8')
    const merged = migrateLegacyConfigSync(file)
    eq(merged, { memoryRoot: 'fixture-memory', retentionDays: 30 }, 'normal legacy migrated as-is')
    ok(readFileSync(file, 'utf8') === JSON.stringify(merged, null, 2), 'canonical written through the atomic writer')
    ok(readFileSync(legacyFile, 'utf8') === legacyText, 'legacy bytes preserved verbatim')
    ok(lockArtifacts(dir).length === 0, 'no lock artifacts left behind')
    ok(corruptArtifacts(dir).length === 0, 'no quarantine artifacts on success')
  }

  console.log('[S3] normal 优先于 pre，pre 独有键保留')
  {
    const dir = caseDir('pre-priority')
    const file = path.join(dir, CONFIG_FILENAME)
    const normalFile = path.join(dir, 'dsh-auto-memory.json')
    const preFile = path.join(dir, 'dsh-auto-memory-pre.json')
    const normalText = '{"shared":"normal","fromNormal":1}'
    const preText = '{"theme":"dark","fromPreview":true,"shared":"preview"}'
    writeFileSync(normalFile, normalText, 'utf8')
    writeFileSync(preFile, preText, 'utf8')
    const merged = migrateLegacyConfigSync(file)
    ok(merged.theme === 'dark' && merged.fromPreview === true, 'preview-only keys kept')
    ok(merged.shared === 'normal', 'normal overrides preview on the same key')
    ok(merged.fromNormal === 1 && Object.keys(merged).length === 4, 'merged key set is complete')
    ok(readFileSync(file, 'utf8') === JSON.stringify({ theme: 'dark', fromPreview: true, shared: 'normal', fromNormal: 1 }, null, 2), 'merged object written once, stably')
    ok(readFileSync(normalFile, 'utf8') === normalText, 'normal legacy bytes preserved')
    ok(readFileSync(preFile, 'utf8') === preText, 'pre legacy bytes preserved')
    ok(lockArtifacts(dir).length === 0, 'no lock artifacts left behind')
  }

  console.log('[S4] 仅有 pre 配置时也迁移')
  {
    const dir = caseDir('preview-only')
    const file = path.join(dir, CONFIG_FILENAME)
    const preFile = path.join(dir, 'dsh-auto-memory-pre.json')
    const pre = { theme: 'dark', nested: { density: 'compact' } }
    writeJsonText(preFile, pre)
    const merged = migrateLegacyConfigSync(file)
    eq(merged, pre, 'preview-only config migrated')
    ok(readFileSync(file, 'utf8') === JSON.stringify(pre, null, 2), 'canonical content round-trips')
    ok(!existsSync(path.join(dir, 'dsh-auto-memory.json')), 'normal legacy file not created')
  }

  console.log('[S5] 无任何配置时不落盘')
  {
    const dir = caseDir('nothing')
    const file = path.join(dir, CONFIG_FILENAME)
    ok(migrateLegacyConfigSync(file) === null, 'missing config returns null')
    ok(!existsSync(file), 'no canonical file created from nothing')
    ok(lockArtifacts(dir).length === 0, 'no lock artifacts after no-op')
  }

  console.log('[S6] 已存在的空 canonical 即权威（旧文件即使损坏也不读）')
  {
    const dir = caseDir('empty-authoritative')
    const file = path.join(dir, CONFIG_FILENAME)
    const legacyFile = path.join(dir, 'dsh-auto-memory.json')
    const preFile = path.join(dir, 'dsh-auto-memory-pre.json')
    writeFileSync(file, '{}', 'utf8')
    const broken = '{ "legacy": broken'
    writeFileSync(legacyFile, broken, 'utf8')
    writeFileSync(preFile, broken, 'utf8')
    const merged = migrateLegacyConfigSync(file)
    eq(merged, {}, 'existing empty canonical wins')
    ok(readFileSync(file, 'utf8') === '{}', 'canonical bytes untouched')
    ok(readFileSync(legacyFile, 'utf8') === broken && readFileSync(preFile, 'utf8') === broken, 'broken legacy files left untouched')
    ok(corruptArtifacts(dir).length === 0, 'no quarantine when canonical already exists')
  }

  console.log('[S7] 写盘失败：抛错、不落 canonical、旧字节不变')
  {
    const dir = caseDir('write-failure')
    const file = path.join(dir, CONFIG_FILENAME)
    const legacyFile = path.join(dir, 'dsh-auto-memory.json')
    const legacyText = '{"memoryRoot":"fixture-memory"}'
    writeFileSync(legacyFile, legacyText, 'utf8')
    const error = errorOf(() => migrateLegacyConfigSync(file, { writeAtomic: () => ({ ok: false, error: 'ENOENT simulated rename' }) }))
    ok(Boolean(error) && /config migration failed: ENOENT simulated rename/.test(String(error && error.message)), 'failed write surfaces config migration failed')
    ok(!existsSync(file), 'canonical not created on failed write')
    ok(readFileSync(legacyFile, 'utf8') === legacyText, 'legacy bytes preserved on failed write')
    ok(corruptArtifacts(dir).length === 0, 'no quarantine on failed write')
    ok(lockArtifacts(dir).length === 0, 'lock released after failed write')
  }

  console.log('[S8] 旧配置解析失败：拒绝迁移且不隔离')
  {
    const dir = caseDir('invalid-legacy')
    const file = path.join(dir, CONFIG_FILENAME)
    const legacyFile = path.join(dir, 'dsh-auto-memory.json')
    const broken = '{"memoryRoot":'
    writeFileSync(legacyFile, broken, 'utf8')
    const error = errorOf(() => migrateLegacyConfigSync(file))
    ok(Boolean(error) && /Invalid configuration/.test(String(error && error.message)), 'invalid legacy JSON rejected')
    ok(!existsSync(file), 'no canonical written when legacy is invalid')
    ok(readFileSync(legacyFile, 'utf8') === broken, 'invalid legacy kept byte-for-byte')
    ok(corruptArtifacts(dir).length === 0, 'invalid legacy is not quarantined')
  }

  console.log('[S9] readConfigStrictSync 严格读')
  {
    const dir = caseDir('strict-read')
    const file = path.join(dir, 'valid.json')
    ok(readConfigStrictSync(path.join(dir, 'missing.json')) === null, 'missing file reads as null')
    ok(readConfigStrictSync(path.join(dir, 'missing-dir', 'x.json')) === null, 'missing parent reads as null')
    writeJsonText(file, { ok: true })
    eq(readConfigStrictSync(file), { ok: true }, 'valid object accepted')
    writeFileSync(file, '[1,2]', 'utf8')
    ok(/expected JSON object/.test(String(errorOf(() => readConfigStrictSync(file))?.message)), 'array rejected')
    writeFileSync(file, '42', 'utf8')
    ok(/expected JSON object/.test(String(errorOf(() => readConfigStrictSync(file))?.message)), 'scalar rejected')
    writeFileSync(file, '"text"', 'utf8')
    ok(/expected JSON object/.test(String(errorOf(() => readConfigStrictSync(file))?.message)), 'string rejected')
    writeFileSync(file, '{broken', 'utf8')
    ok(/Invalid configuration/.test(String(errorOf(() => readConfigStrictSync(file))?.message)), 'truncated JSON rejected')
    const folder = path.join(dir, 'folder.json')
    mkdirSync(folder)
    ok(/must be a regular file/.test(String(errorOf(() => readConfigStrictSync(folder))?.message)), 'directory rejected')
  }

  console.log('[S10] 符号链接一律拒绝（平台不支持创建则跳过）')
  {
    const dir = caseDir('symlink')
    const target = path.join(dir, 'target.json')
    const link = path.join(dir, CONFIG_FILENAME)
    writeJsonText(target, { memoryRoot: 'fixture-memory' })
    let linkable = true
    try { symlinkSync(target, link, 'file') } catch (_) { linkable = false }
    if (!linkable) {
      console.log('  skip - platform refused to create a file symlink')
    } else {
      ok(lstatSync(link).isSymbolicLink(), 'fixture symlink created')
      ok(/symlink/i.test(String(errorOf(() => readConfigStrictSync(link))?.message)), 'symlinked canonical refused by strict read')
      ok(/symlink/i.test(String(errorOf(() => migrateLegacyConfigSync(link))?.message)), 'symlinked canonical refused by migration lock')
      ok(readFileSync(target, 'utf8') === JSON.stringify({ memoryRoot: 'fixture-memory' }), 'symlink target untouched')
      const legacyDir = caseDir('symlink-legacy')
      const legacyLink = path.join(legacyDir, 'dsh-auto-memory.json')
      const outside = path.join(dir, 'legacy-target.json')
      writeJsonText(outside, { memoryRoot: 'outside' })
      try {
        symlinkSync(outside, legacyLink, 'file')
        ok(/symlink/i.test(String(errorOf(() => migrateLegacyConfigSync(path.join(legacyDir, CONFIG_FILENAME)))?.message)), 'symlinked legacy config refused')
        ok(!existsSync(path.join(legacyDir, CONFIG_FILENAME)), 'no canonical written from symlinked legacy')
      } catch (_) {
        console.log('  skip - platform refused to create the legacy symlink')
      }
    }
  }

  console.log('[S11] 重复调用：canonical 存在后不再读写迁移路径')
  {
    const dir = caseDir('repeat')
    const file = path.join(dir, CONFIG_FILENAME)
    const legacyFile = path.join(dir, 'dsh-auto-memory.json')
    writeJsonText(legacyFile, { memoryRoot: 'fixture-memory', retentionDays: 30 })
    const first = migrateLegacyConfigSync(file)
    const before = readFileSync(file, 'utf8')
    let writes = 0
    const second = migrateLegacyConfigSync(file, { writeAtomic: () => { writes += 1; return { ok: true, path: file } } })
    ok(writes === 0, 'second call performs no write')
    eq(second, first, 'second call returns the same object')
    ok(readFileSync(file, 'utf8') === before, 'canonical bytes stable across calls')
  }

  console.log('[S12] 非 canonical 文件名不迁移')
  {
    const dir = caseDir('other-name')
    const other = path.join(dir, 'settings.json')
    writeJsonText(path.join(dir, 'dsh-auto-memory.json'), { memoryRoot: 'fixture-memory' })
    ok(migrateLegacyConfigSync(other) === null, 'other basename is not migrated')
    ok(!existsSync(other), 'no file written for other basename')
    ok(lockArtifacts(dir).length === 0, 'lock released for other basename')
  }

  console.log('[S13] 配置锁被活主持有：CONFIG_LOCK_BUSY，释放后恢复')
  {
    const dir = caseDir('locked')
    const file = path.join(dir, CONFIG_FILENAME)
    const legacyFile = path.join(dir, 'dsh-auto-memory.json')
    const legacyText = '{"memoryRoot":"fixture-memory"}'
    writeFileSync(legacyFile, legacyText, 'utf8')
    const lockFile = file + '.lock'
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname() }), 'utf8')
    const busy = errorOf(() => migrateLegacyConfigSync(file))
    ok(Boolean(busy) && busy.code === 'CONFIG_LOCK_BUSY', 'live lock owner surfaces CONFIG_LOCK_BUSY')
    ok(!existsSync(file), 'no canonical written while lock is held')
    ok(readFileSync(legacyFile, 'utf8') === legacyText, 'legacy bytes preserved while lock is held')
    ok(!existsSync(lockFile + '.acquire'), 'acquisition gate cleaned up on busy path')
    unlinkSync(lockFile)
    eq(migrateLegacyConfigSync(file), { memoryRoot: 'fixture-memory' }, 'migration succeeds after the lock is released')
    ok(existsSync(file) && lockArtifacts(dir).length === 0, 'canonical written and lock released')
  }

  console.log('[S14] 死主遗留锁可回收')
  {
    const dir = caseDir('dead-lock')
    const file = path.join(dir, CONFIG_FILENAME)
    const legacyFile = path.join(dir, 'dsh-auto-memory.json')
    writeJsonText(legacyFile, { memoryRoot: 'fixture-memory' })
    let deadPid = 0
    for (let candidate = 9000000; candidate < 9000010 && !deadPid; candidate++) {
      try { process.kill(candidate, 0) } catch (e) { if (e.code === 'ESRCH') deadPid = candidate }
    }
    if (!deadPid) {
      console.log('  skip - no provably dead pid available on this platform')
    } else {
      writeFileSync(file + '.lock', JSON.stringify({ pid: deadPid, host: os.hostname() }), 'utf8')
      eq(migrateLegacyConfigSync(file), { memoryRoot: 'fixture-memory' }, 'dead owner lock reclaimed')
      ok(existsSync(file), 'canonical written after reclaim')
      ok(lockArtifacts(dir).length === 0, 'dead lock does not remain')
    }
  }

  console.log('[S15] 白名单优先级')
  ok(panelAllowedHostsSource({}) === '', 'no env / no config falls back to empty (fail closed)')
  ok(panelAllowedHostsSource({}, 'cfg.example') === 'cfg.example', 'configured value used when env is absent')
  ok(panelAllowedHostsSource({ DSH_AUTO_MEMORY_ALLOWED_HOSTS: 'legacy.example' }, 'cfg.example') === 'legacy.example', 'legacy env beats configured value')
  ok(panelAllowedHostsSource({ DSH_PERSONALISED_ALLOWED_HOSTS: 'new.example', DSH_AUTO_MEMORY_ALLOWED_HOSTS: 'legacy.example' }, 'cfg.example') === 'new.example', 'new env beats legacy env')
  ok(panelAllowedHostsSource({ DSH_PERSONALISED_ALLOWED_HOSTS: '', DSH_AUTO_MEMORY_ALLOWED_HOSTS: 'legacy.example' }, 'cfg.example') === '', 'explicit empty new env fails closed')
  ok(panelAllowedHostsSource({ DSH_AUTO_MEMORY_ALLOWED_HOSTS: '' }, 'cfg.example') === 'cfg.example', 'empty legacy env falls back to configured value')
  ok(panelAllowedHostsSource({ DSH_PERSONALISED_ALLOWED_HOSTS: undefined, DSH_AUTO_MEMORY_ALLOWED_HOSTS: 'legacy.example' }) === 'legacy.example', 'undefined new env is treated as unset')

  console.log('[S16] 路由别名共享同一 handler 闭包')
  {
    const handler = async () => 'payload'
    const canonical = { kind: 'exact', score: 3, path: API_PREFIX + '/config', handler }
    const input = [canonical]
    const expanded = compatibleRoutes(input)
    ok(expanded.length === 2, 'one canonical route expands to two aliases')
    ok(expanded[0] === canonical, 'canonical route object passed through unchanged')
    ok(expanded[1].path === LEGACY_API_PREFIX + '/config', 'legacy alias path derived from the canonical suffix')
    ok(expanded[1].handler === handler, 'legacy alias shares the exact handler closure')
    ok(expanded[1].kind === 'exact' && expanded[1].score === 3, 'other route fields are copied')
    ok(input.length === 1 && input[0].path === API_PREFIX + '/config', 'input array is not mutated')
    ok((await expanded[1].handler()) === (await canonical.handler()), 'both aliases invoke the same implementation')

    const deep = compatibleRoutes([{ path: API_PREFIX + '/personal/import/preview', handler }])
    ok(deep[1].path === LEGACY_API_PREFIX + '/personal/import/preview', 'nested route suffix preserved')
    ok(deep[1].handler === handler, 'nested alias shares the handler closure')

    const a = { path: API_PREFIX + '/state', handler }
    const b = { path: API_PREFIX + '/list', handler }
    const pairs = compatibleRoutes([a, b])
    ok(pairs.length === 4 && pairs[0] === a && pairs[2] === b, 'aliases are emitted in canonical order pairs')

    for (const bad of ['/api/other/x', API_PREFIX, API_PREFIX + '-x/y', 'relative/path']) {
      const error = errorOf(() => compatibleRoutes([{ path: bad, handler }]))
      ok(Boolean(error) && /non-canonical/.test(String(error && error.message)), 'non-canonical route refused: ' + bad)
    }
  }

  console.log('')
  if (fail) console.error('personal migration smoke FAILED: ' + pass + ' ok / ' + fail + ' failed')
  else console.log('personal migration smoke passed: legacy/pre merge, byte-preserving migration, atomic write failure, strict read, symlink refusal, lock busy/reclaim, whitelist priority, and shared-handler route aliases')
  if (fail) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
