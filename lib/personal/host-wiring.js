import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeTextAtomicPre } from '../config-io.js'
import { withConfigLock } from '../config-lock.js'
import { stripRuntimeIntentPre } from '../intent-clean-safe.js'
import {
  createProfileStore, createImporter, makeLlmCall,
  renderStableSection, renderPersonalContext, decideLayers, stableSectionOrder,
  STABLE_SECTION_NAME, PERSONAL_CONTEXT_NAME,
  renderArchive, renderJson, EXPORT_PROMPT, IMPORT_PROMPT, PROMPTS_VERSION,
} from './index.js'

const digestOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const objectBody = (value) => value && typeof value === 'object' && !Array.isArray(value)
const problem = (statusCode, message) => Object.assign(new Error(message), { statusCode })

export function registerPersonalised(ctx, engine, deps) {
  const { API, dshHome, writeJson, readJsonBody, isLoopbackRequest, forbiddenPanelPayloadPre, panelAllowedHosts, isSubAgentSession, extractSessionMessages } = deps
  let entries = []
  let store
  let importer
  let ready = Promise.resolve()
  let loadError = ''
  let dir = ''
  let disposed = false
  let disposeSection
  let position
  const requestCache = new WeakMap()
  let cacheGeneration = 0

  function changed() {
    cacheGeneration += 1
    if (!disposed && typeof ctx.emit === 'function') ctx.emit('system-prompt/change')
  }

  async function refresh(current = store) {
    const next = await current.list({ includePending: true })
    if (disposed || current !== store) return
    entries = next
    changed()
  }

  function rebuildStore() {
    const nextDir = path.join(engine.userDirOf(), 'personal')
    if (nextDir === dir) return ready
    dir = nextDir
    entries = []
    loadError = ''
    const current = createProfileStore({ dir })
    store = current
    const llm = deps.llm || ctx.llm
    const llmCall = llm && (typeof llm.prepareCall === 'function' || typeof llm.stream === 'function') ? makeLlmCall(llm) : null
    importer = createImporter({ store, llmCall })
    ready = current.load().then(async (loaded) => {
      if (current !== store || disposed) return
      if (loaded.ok === false) throw Error(loaded.error || '画像库加载失败')
      await refresh(current)
    }).catch((error) => {
      if (current === store && !disposed) loadError = String(error.message || error)
    })
    return ready
  }

  function workspaceFor(agent) {
    if (!agent) return ''
    try {
      const workingDirectory = ctx.get && ctx.get('workingDirectory')
      if (workingDirectory && typeof workingDirectory.get === 'function') {
        const value = workingDirectory.get(agent.session)
        if (typeof value === 'string' && value) return value
      }
    } catch (_) {}
    const header = agent.session && agent.session.header
    if (header && header.cwd) return String(header.cwd)
    try {
      const state = engine.stateFor(agent)
      if (state && state.ws) return String(state.ws)
    } catch (_) {}
    return ''
  }

  async function boundWorkspace(sessionId) {
    if (!sessionId) return null
    const paths = await engine.resolvePathsForSession(String(sessionId))
    return paths && paths.ws && paths.wsBound !== false ? { key: engine.wsKey(paths.ws), path: paths.ws } : null
  }

  function queryFor(agent) {
    const messages = extractSessionMessages(agent)
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.role !== 'user' || (message.sourceKind && message.sourceKind !== 'user')) continue
      const clean = stripRuntimeIntentPre(String(message.text || '')).trim()
      if (clean) return clean
    }
    return ''
  }

  function layersFor(agent, query = queryFor(agent), workspace = workspaceFor(agent)) {
    const config = engine.config
    const decision = decideLayers({
      isSubagent: isSubAgentSession(agent),
      isOwnBackground: !!(agent && engine._ownSubagents && engine._ownSubagents.has(agent)),
      policy: config.personalSubagentPolicy,
      applyToSubagents: config.customInstructionsSubagents,
      instructionsEnabled: config.customInstructionsEnabled,
      personalMode: config.personalInjectMode,
    })
    const stable = decision.stable ? renderStableSection({ enabled: config.customInstructionsEnabled, customText: config.customInstructions, entries }) : ''
    const rendered = decision.personal || decision.workspace
      ? renderPersonalContext({ query, entries, wsKey: workspace ? engine.wsKey(workspace) : '', topK: config.personalTopK, budgetChars: config.personalBudgetChars })
      : { personal: '', workspace: '', text: '' }
    return { stable, ...rendered }
  }

  function cachedLayers(context) {
    const agent = context && context.agent
    if (!agent || typeof agent !== 'object') return { stable: '', text: '' }
    const key = String(engine.requestIdPre(agent) || (agent.session && agent.session.id ? 'session:' + agent.session.id : 'agent:' + String(agent.id || 'unknown'))) + ':' + cacheGeneration
    const previous = requestCache.get(agent)
    if (previous && previous.key === key) return previous.value
    const value = layersFor(agent)
    requestCache.set(agent, { key, value })
    return value
  }

  function cachedContext(context) {
    return cachedLayers(context).text
  }

  function registerSection() {
    if (disposeSection) disposeSection()
    position = engine.config.customInstructionsPosition
    disposeSection = ctx.systemPrompt.section({
      name: STABLE_SECTION_NAME,
      order: stableSectionOrder(position),
      interpolate: false,
      text: (context) => cachedLayers(context).stable,
    })
  }

  async function configChanged() {
    if (disposed) return
    await rebuildStore()
    cacheGeneration += 1
    if (position !== engine.config.customInstructionsPosition) registerSection()
    changed()
  }

  const load = rebuildStore()
  registerSection()
  const disposeContext = ctx.systemPrompt.context({ name: PERSONAL_CONTEXT_NAME, order: 9990, text: cachedContext })

  async function available() {
    if (disposed || engine._disposed) throw problem(503, 'personalisation is disposed')
    await rebuildStore()
    if (loadError) throw problem(500, loadError)
  }

  async function mutate(operation) {
    if (engine._settingsMigrationActive) throw problem(409, 'memory migration is in progress; retry after it finishes')
    if (!engine._settingsNoteFlights) engine._settingsNoteFlights = new Set()
    let finish
    const flight = new Promise((resolve) => { finish = resolve })
    engine._settingsNoteFlights.add(flight)
    try {
      await available()
      const current = store
      const result = await operation(current, importer)
      if (result && result.ok === false) throw problem(result.status || 500, result.error || '画像写入失败')
      await refresh(current)
      return result
    } finally {
      engine._settingsNoteFlights.delete(flight)
      finish()
    }
  }

  async function bodyOf(req) {
    let body
    try { body = await readJsonBody(req) } catch (_) { throw problem(400, 'invalid JSON body') }
    if (!objectBody(body)) throw problem(400, 'invalid body')
    return body
  }

  const routeDefinitions = new Map()
  function route(key, method, handler) {
    let definition = routeDefinitions.get(key)
    if (!definition) {
      definition = new Map()
      routeDefinitions.set(key, definition)
    }
    definition.set(method, handler)
  }

  route('personalState', 'GET', async (_req, query) => {
    const config = engine.config
    return {
      ok: true,
      instructions: { enabled: config.customInstructionsEnabled, text: config.customInstructions, position: config.customInstructionsPosition, applyToSubagents: config.customInstructionsSubagents, chars: config.customInstructions.length },
      layers: Object.fromEntries(['personalInjectMode', 'userMemoryInjectMode', 'personalTopK', 'personalBudgetChars', 'personalSubagentPolicy'].map((key) => [key, config[key]])),
      importModel: { provider: config.personalImportProvider || config.subagentProvider || '', model: config.personalImportModel || config.subagentModel || '' },
      stats: await store.stats(),
      workspace: await boundWorkspace(query.get('sessionId')),
      promptsVersion: PROMPTS_VERSION,
    }
  })

  route('personalEntries', 'GET', async (_req, query) => ({
    ok: true,
    entries: await store.list({ scope: query.get('scope'), workspace: query.get('workspace'), category: query.get('category'), kind: query.get('kind'), q: query.get('q') }),
  }))
  route('personalEntries', 'POST', async (req) => {
    const body = await bodyOf(req)
    if (body.op === 'delete') {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.some((id) => typeof id !== 'string' || !id)) throw problem(400, 'ids must be a nonempty string array')
      return mutate((current) => current.remove(body.ids))
    }
    if (body.op !== 'upsert' || !objectBody(body.entry) || typeof body.entry.text !== 'string' || !body.entry.text.trim()) throw problem(400, 'use op=upsert with a nonempty entry')
    return mutate((current) => current.upsert(body.entry))
  })

  route('personalPrompts', 'GET', async () => ({ ok: true, version: PROMPTS_VERSION, exportPrompt: EXPORT_PROMPT, importPrompt: IMPORT_PROMPT }))
  route('personalImportPreview', 'POST', async (req, _query, res) => {
    const controller = new AbortController()
    const abort = () => { try { controller.abort('client disconnected') } catch (_) {} }
    if (req && typeof req.once === 'function') req.once('aborted', abort)
    if (res && typeof res.once === 'function') res.once('close', abort)
    const body = await bodyOf(req)
    if (typeof body.text !== 'string' || !body.text.trim() || !['parse', 'model'].includes(body.mode)) throw problem(400, 'provide text and mode=parse|model')
    const workspace = body.workspace === null ? null : (body.workspace === undefined ? await boundWorkspace(body.sessionId) : body.workspace)
    if (workspace !== null && (!objectBody(workspace) || typeof workspace.path !== 'string' || !workspace.path)) throw problem(400, 'invalid workspace')
    const result = await importer.preview({
      text: body.text,
      mode: body.mode,
      provider: body.provider || engine.config.personalImportProvider || engine.config.subagentProvider || '',
      model: body.model || engine.config.personalImportModel || engine.config.subagentModel || '',
      workspace: workspace ? { key: engine.wsKey(workspace.path), path: workspace.path } : null,
      platform: body.platform,
      scopePreference: body.workspace && objectBody(body.workspace) ? 'workspace' : '',
      timeoutMs: engine.config.personalImportTimeoutMs,
      signal: controller.signal,
    })
    if (!result.ok) throw problem(result.status || 400, result.error)
    return result
  })
  route('personalImportCommit', 'POST', async (req) => {
    const body = await bodyOf(req)
    if (typeof body.previewId !== 'string' || !Array.isArray(body.accept)) throw problem(400, 'provide previewId and accept')
    return mutate((_current, currentImporter) => currentImporter.commit(body))
  })
  route('personalImportUndo', 'POST', async (req) => {
    const body = await bodyOf(req)
    if (typeof body.batchId !== 'string' || !body.batchId) throw problem(400, 'provide batchId')
    return mutate((_current, currentImporter) => currentImporter.undo(body))
  })

  route('personalExport', 'GET', async (_req, query) => {
    const format = query.get('format') || 'md'
    if (!['md', 'json'].includes(format)) throw problem(400, 'format must be md or json')
    const selected = await store.list({ scope: query.get('scope'), workspace: query.get('workspace') })
    return { ok: true, format, filename: 'personal-memory.' + format, content: format === 'json' ? renderJson(selected) : renderArchive(selected) }
  })
  route('personalContextPreview', 'GET', async (_req, query) => {
    const sessionId = query.get('sessionId')
    const agent = sessionId ? engine.agentForSessionId(sessionId) : null
    const workspace = await boundWorkspace(sessionId)
    const rendered = layersFor(agent, query.get('q') || '', workspace ? workspace.path : '')
    return { ok: true, stable: rendered.stable, personal: rendered.personal, workspace: rendered.workspace, chars: { stable: rendered.stable.length, personal: rendered.personal.length, workspace: rendered.workspace.length } }
  })

  async function agentsMd() {
    const file = path.join(dshHome(), 'AGENTS.md')
    try {
      const text = await readFile(file, 'utf8')
      return { ok: true, path: file, exists: true, text, digest: digestOf(text) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { ok: true, path: file, exists: false, text: '', digest: digestOf('') }
    }
  }
  route('personalAgentsMd', 'GET', agentsMd)
  route('personalAgentsMd', 'POST', async (req) => {
    const body = await bodyOf(req)
    if (typeof body.text !== 'string' || typeof body.expectedDigest !== 'string') throw problem(400, 'provide text and expectedDigest')
    return withConfigLock(path.join(dshHome(), 'AGENTS.md'), async () => {
      const previous = await agentsMd()
      if (previous.digest !== body.expectedDigest) throw problem(409, 'AGENTS.md changed; reload before saving')
      const written = await writeTextAtomicPre(previous.path, body.text)
      if (!written.ok) throw problem(500, written.error || 'AGENTS.md write failed')
      return { ok: true, digest: digestOf(body.text) }
    })
  })

  const routes = [...routeDefinitions].map(([key, methods]) => ({
    kind: 'exact',
    path: API[key],
    handler: async (req, res) => {
      if (!isLoopbackRequest(req, panelAllowedHosts)) return writeJson(res, 403, forbiddenPanelPayloadPre(req, panelAllowedHosts))
      const handler = methods.get(req.method || 'GET')
      if (!handler) return writeJson(res, 405, { error: 'method not allowed' })
      try {
        await available()
        const query = new URL(req.url || API[key], 'http://127.0.0.1').searchParams
        writeJson(res, 200, await handler(req, query, res))
      } catch (error) {
        writeJson(res, error.statusCode || 500, { error: String(error.message || error) })
      }
    },
  }))

  async function toolAction(args, exec) {
    const agent = exec && exec.agent
    const action = args.action
    if (!['search', 'add', 'update', 'remove'].includes(action)) throw problem(400, 'unknown action')
    if (action !== 'search' && isSubAgentSession(agent)) throw problem(403, '子代理只读，不能修改个人画像')
    await available()
    const workspace = workspaceFor(agent)
    if (args.scope === 'workspace' && !workspace) throw problem(400, 'session workspace is unknown')
    if (action === 'search') return { ok: true, entries: await store.list({ q: args.query, scope: args.scope, workspace: workspace ? engine.wsKey(workspace) : '' }) }
    if (action === 'remove') {
      if (typeof args.id !== 'string' || !args.id) throw problem(400, 'provide id')
      return mutate((current) => current.remove(args.id))
    }
    if (!objectBody(args.entry)) throw problem(400, 'provide entry')
    let previous = null
    if (action === 'update') {
      if (typeof args.id !== 'string' || !args.id) throw problem(400, 'provide id')
      previous = await store.get(args.id)
      if (!previous) throw problem(404, 'entry not found')
    }
    const entry = { ...previous, ...args.entry, ...(action === 'update' ? { id: args.id } : {}) }
    if (typeof entry.text !== 'string' || !entry.text.trim()) throw problem(400, 'entry text is empty')
    if (action === 'add') {
      delete entry.id
      entry.source = { type: 'agent' }
      entry.evidence = entry.evidence || 'explicit'
    }
    if (args.scope === 'workspace') entry.scope = { type: 'workspace', key: engine.wsKey(workspace), path: workspace }
    else if (args.scope === 'global' || action === 'add') entry.scope = { type: 'global' }
    return mutate((current) => current.upsert(entry))
  }

  const tool = deps.defineTool('memory_profile', '查询或维护结构化个人画像；子代理只读。add 默认记录为用户明示事实，workspace 作用域绑定当前会话工作区。', {
    action: { type: 'string', required: true, enum: ['search', 'add', 'update', 'remove'] },
    query: { type: 'string' },
    entry: { type: 'object' },
    id: { type: 'string' },
    scope: { type: 'string', enum: ['global', 'workspace'] },
  }, async (args, exec) => JSON.stringify(await toolAction(args || {}, exec)))

  function dispose() {
    if (disposed) return
    disposed = true
    if (disposeSection) disposeSection()
    disposeContext()
    entries = []
  }

  return { routes, tools: [tool], configChanged, refresh, ready: load, dispose }
}
