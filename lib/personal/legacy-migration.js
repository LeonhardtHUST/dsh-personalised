// Runtime identity changes only; memory paths and persisted schemas stay compatible.
import { openSync, closeSync, readFileSync, lstatSync, fstatSync, constants } from 'node:fs'
import path from 'node:path'
import { withConfigLockSync } from '../config-lock.js'
import { writeTextAtomicPreSync } from '../config-io.js'

export const API_PREFIX = '/api/dsh-personalised'
export const LEGACY_API_PREFIX = '/api/dsh-auto-memory'
export const CONFIG_FILENAME = 'dsh-personalised.json'

// Aliases share the exact handler closure, including guards and POST body reads.
export function compatibleRoutes(routes) {
  return routes.flatMap(route => {
    if (!route.path.startsWith(API_PREFIX + '/')) throw new Error('non-canonical personalised route: ' + route.path)
    return [route, { ...route, path: LEGACY_API_PREFIX + route.path.slice(API_PREFIX.length) }]
  })
}

// An explicitly empty new variable disables the old whitelist (fail closed).
export function panelAllowedHostsSource(env, configured = '') {
  if (env.DSH_PERSONALISED_ALLOWED_HOSTS !== undefined) return env.DSH_PERSONALISED_ALLOWED_HOSTS
  return env.DSH_AUTO_MEMORY_ALLOWED_HOSTS || configured
}

// No quarantine: every source is preserved byte-for-byte on any failure.
export function readConfigStrictSync(file) {
  let before
  try { before = lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (before.isSymbolicLink()) throw new Error('config-file-symlink refused: ' + file)
  if (!before.isFile()) throw new Error('config must be a regular file: ' + file)
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('config file changed during read: ' + file)
    let value
    try { value = JSON.parse(readFileSync(fd, 'utf8')) }
    catch (error) { throw new Error('Invalid configuration ' + file + ': ' + error.message, { cause: error }) }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration: expected JSON object: ' + file)
    return value
  } finally { closeSync(fd) }
}

// Caller and helper use the same canonical lock; nested calls are reentrant.
// Once canonical exists (even {}), legacy files are never consulted again.
export function migrateLegacyConfigSync(file, { writeAtomic = writeTextAtomicPreSync } = {}) {
  return withConfigLockSync(file, () => {
    const current = readConfigStrictSync(file)
    if (current !== null || path.basename(file) !== CONFIG_FILENAME) return current
    const directory = path.dirname(file)
    const normal = readConfigStrictSync(path.join(directory, 'dsh-auto-memory.json'))
    const preview = readConfigStrictSync(path.join(directory, 'dsh-auto-memory-pre.json'))
    if (normal === null && preview === null) return null
    const merged = { ...preview, ...normal }
    const result = writeAtomic(file, JSON.stringify(merged, null, 2))
    if (!result.ok) throw new Error('config migration failed: ' + result.error)
    return merged
  })
}
