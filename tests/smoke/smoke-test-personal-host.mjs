import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'dsh-personal-host-'))
const home = path.join(root, '.dsh')
const workspace = path.join(root, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(home, 'dsh-auto-memory.json'), JSON.stringify({ memoryRoot: path.join(root, 'memory'), userMemoryDir: path.join(root, 'user'), projectMemoryDir: '.project-memory', customInstructions: 'Reply with concise steps.', customInstructionsPosition: 'suffix', externalSources: {} }), 'utf8')
process.env.DSH_HOME = home

const { apply } = await import('../../lib/index.js')
const tools = []
const routes = []
const sections = []
const contexts = []
const handlers = new Map()
const ctx = {
  get() { return undefined },
  on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
  effect() { return () => {} },
  systemPrompt: {
    section(value) { sections.push(value); return () => {} },
    context(value) { contexts.push(value); return () => {} },
  },
  tools: { register(value) { tools.push(value); return () => {} } },
  webServer: { register(value) { routes.push(value); return () => {} } },
}
apply(ctx, {})
process.on('uncaughtException', () => { process.exitCode = 1 })
await new Promise((resolve) => setTimeout(resolve, 120))

function response() {
  const listeners = new Map()
  return { value: null, status: 200, once(name, handler) { listeners.set(name, handler) }, writeHead(status) { this.status = status }, end(body) { this.value = JSON.parse(body) } }
}
function request(method, url, body) {
  const req = { method, url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }
  if (body !== undefined) req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)) }
  return req
}
async function invokeResponse(pathname, method, body, remote = '127.0.0.1') {
  const route = routes.find((item) => item.path === pathname.split('?')[0])
  if (!route) throw new Error('route missing: ' + pathname)
  const res = response()
  const req = request(method, pathname, body)
  req.socket.remoteAddress = remote
  await route.handler(req, res)
  return res
}
async function invoke(pathname, method, body) {
  return (await invokeResponse(pathname, method, body)).value
}
const prefix = '/api/dsh-auto-memory/personal/'
async function postEntry(entry) {
  const result = await invoke(prefix + 'entries', 'POST', { op: 'upsert', entry })
  if (!result.ok) throw Error(result.error || 'entry failed')
  return result.entry
}

const state = await invoke('/api/dsh-auto-memory/personal/state', 'GET')
if (!state.ok || state.instructions.text !== 'Reply with concise steps.' || state.instructions.position !== 'suffix') throw new Error('personal state contract failed')
const added = await postEntry({ kind: 'fact', category: 'preference', text: 'Use concise verification steps.', pinned: true, scope: { type: 'global' } })
const workspaceEntry = await postEntry({ kind: 'fact', category: 'workflow', text: 'Workspace A verification deployment only.', pinned: true, scope: { type: 'workspace', key: '--' + workspace.replace(/[\\/:*?"<>|]/g, '-') + '--', path: workspace } })
await postEntry({ category: 'pending', evidence: 'unconfirmed', text: 'must never render', scope: { type: 'global' } })
if (!added || !workspaceEntry) throw new Error('personal upsert contract failed')
const agent = { session: { header: { cwd: workspace }, snapshotEvents() { return [{ type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'verification steps' }] } }] } } }
const stable = sections.find((item) => item.name === 'dsh-personalised:instructions')
const personal = contexts.find((item) => item.name === 'dsh-personalised:personal')
if (!stable || !personal || !String(stable.text({ agent })).includes('Reply with concise steps.')) throw new Error('prompt surfaces missing')
if (String(personal.text({ agent })) !== String(personal.text({ agent }))) throw new Error('personal context is not stable')
const profileTool = tools.find((tool) => tool.name === 'memory_profile')
if (!profileTool) throw new Error('memory_profile missing')
const search = JSON.parse(await profileTool.execute({ action: 'search', query: 'verification' }, { agent }))
if (!search.entries.length) throw new Error('memory_profile search failed')
const child = { session: { header: { origin: 'subagent', cwd: workspace } } }
let rejected = false
try { await profileTool.execute({ action: 'add', entry: { kind: 'fact', text: 'child write' } }, { agent: child }) } catch (_) { rejected = true }
if (!rejected) throw new Error('child write was not rejected')
const agents = await invoke('/api/dsh-auto-memory/personal/agents-md', 'GET')
const saved = await invoke('/api/dsh-auto-memory/personal/agents-md', 'POST', { text: '# personal host smoke\n', expectedDigest: agents.digest })
if (!saved.ok || !saved.digest) throw new Error('AGENTS.md optimistic write failed')
let conflict = await invoke('/api/dsh-auto-memory/personal/agents-md', 'POST', { text: 'stale', expectedDigest: agents.digest })
if (!conflict.error) throw new Error('AGENTS.md conflict was not rejected')
const textA = String(personal.text({ agent }))
if (!textA.includes('Workspace A verification deployment only.') || textA.includes('must never render')) throw Error('workspace or pending injection failed')
const agentB = { session: { id: 'b', header: { cwd: path.join(root, 'workspace-b') } } }
if (String(personal.text({ agent: agentB })).includes('Workspace A verification deployment only.')) throw Error('cross-workspace leak')
if (!String(stable.text({ agent: child })).includes('Reply with concise steps.') || personal.text({ agent: child }) !== '') throw Error('default child policy is not instructions-only')
const continued = { session: { header: { cwd: workspace, parentSession: 'old', delegationDepth: 0 } } }
if (!String(personal.text({ agent: continued })).includes('Workspace A verification deployment only.')) throw Error('continued user session was treated as a child')
const prompts = await invoke(prefix + 'prompts', 'GET')
if (!prompts.ok || !prompts.exportPrompt || !prompts.importPrompt || !prompts.version) throw Error('prompts contract failed')
const exported = await invoke(prefix + 'export?format=json', 'GET')
if (!exported.ok || !exported.filename || !JSON.parse(exported.content).entries.length) throw Error('export contract failed')
const contextPreview = await invoke(prefix + 'context-preview?q=verification', 'GET')
if (!contextPreview.ok || !contextPreview.stable || !contextPreview.personal || !contextPreview.chars) throw Error('context preview failed')
const selectedWorkspacePreview = await invoke(prefix + 'import/preview', 'POST', { mode: 'parse', workspace: { key: workspaceEntry.scope.key, path: workspace }, text: '- Workspace selected import verification.' })
if (!selectedWorkspacePreview.ok || selectedWorkspacePreview.items[0].entry.scope.type !== 'workspace') throw Error('explicit workspace import scope failed')
const editedPreview = await invoke(prefix + 'import/preview', 'POST', { mode: 'parse', text: '- Safe imported verification.' })
const editedCommit = await invoke(prefix + 'import/commit', 'POST', { previewId: editedPreview.previewId, accept: editedPreview.items.map((item) => item.tempId), edits: { [editedPreview.items[0].tempId]: { text: 'token: sk-12345678901234567890' } } })
if (!editedCommit.ok || editedCommit.added !== 0 || !editedCommit.warnings.some((warning) => warning.includes('敏感信息'))) throw Error('edited sensitive text was not skipped')

const removed = await invoke(prefix + 'entries', 'POST', { op: 'delete', ids: [workspaceEntry.id] })
if (!removed.ok || removed.deleted !== 1) throw Error('delete failed')
for (const suffix of ['state', 'entries', 'prompts', 'import/preview', 'import/commit', 'import/undo', 'export', 'context-preview', 'agents-md']) {
  const denied = await invokeResponse(prefix + suffix, 'GET', undefined, '203.0.113.20')
  if (denied.status !== 403) throw Error('nonloopback was allowed for ' + suffix)
  const wrongMethod = await invokeResponse(prefix + suffix, 'PATCH')
  if (wrongMethod.status !== 405) throw Error('method guard failed for ' + suffix)
}
for (const suffix of ['entries', 'import/preview', 'import/commit', 'import/undo', 'agents-md']) {
  const invalid = await invokeResponse(prefix + suffix, 'POST', {})
  if (invalid.status !== 400) throw Error('bad body guard failed for ' + suffix + ': ' + invalid.status)
}
const expired = await invokeResponse(prefix + 'import/commit', 'POST', { previewId: 'expired', accept: [] })
if (expired.status !== 410) throw Error('expired preview must be 410')
const missingBackup = await invokeResponse(prefix + 'import/undo', 'POST', { batchId: 'unknown' })
if (missingBackup.status !== 404) throw Error('missing backup must be 404')
const cfgRoute = routes.find((route) => route.path === '/api/dsh-auto-memory/config')
const cfgResponse = response()
await cfgRoute.handler(request('POST', '/config', { personalSubagentPolicy: 'none', customInstructionsPosition: 'prefix' }), cfgResponse)
if (cfgResponse.status !== 200 || stable.text({ agent: { session: { header: { origin: 'subagent', cwd: workspace } } } }) !== '') throw Error('child none policy failed')
const latestSection = sections.filter((item) => item.name === 'dsh-personalised:instructions').at(-1)
if (latestSection.order !== 100) throw Error('section position was not re-registered')
const allResponse = response()
await cfgRoute.handler(request('POST', '/config', { personalSubagentPolicy: 'all' }), allResponse)
const childAll = { session: { id: 'all', header: { origin: 'subagent', cwd: workspace } } }
if (!String(personal.text({ agent: childAll })).includes('Use concise verification steps.')) throw Error('child all policy failed')
rmSync(root, { recursive: true, force: true })
console.log('personal host smoke passed: all route methods/errors, G/PW stability/isolation, import commit/undo, tool guard, section re-registration, and AGENTS.md CAS')
