/**
 * llm-call.js —— 用宿主 `ctx.llm` 发一次**非流式**补全（导入向导的「模型处理」用）。
 *
 * 宿主契约（DSH 0.2.2-rc.3，见 docs/personalised/research-dsh-rc3-api.md §3）：
 *
 *     const call = await ctx.llm.prepareCall({ provider, model, maxTokens }, signal)
 *     for await (const chunk of call.stream({ ...call.config, messages, system, purpose, signal })) …
 *
 * 本模块**不 import `@deepseek-ai/*`**（插件运行期没有那些模块的解析保证）：
 * 手写等价于 `BlockAssembler` 的文本块汇总逻辑 —— 只关心 text 块，
 * `block-end` 到达时以它为准，delta-only 协议则用累积的 text-delta。
 *
 * 失败处理：
 *   - finish.reason = {kind:'error'|'aborted'} → 抛错（带 `failure.code`）；
 *   - 调用方给的 timeoutMs 到点 → 抛 `code='TIMEOUT'`；
 *   - finish = max-tokens 不是错误，但会带一条 warning（结果可能被截断）。
 *
 * 返回 `{ text, finish, warnings, provider, model, usage, elapsedMs }`；
 * `provider/model` 缺失、prompt 为空这类**调用方错误直接抛**，由路由映射成 400。
 */

/** 默认输出上限（导入档案整理一般需要完整 JSON，给足额度）。 */
export const DEFAULT_MAX_TOKENS = 8192

/** 默认请求用途（宿主把未知 purpose 当未知用途处理，不会拦截）。 */
export const DEFAULT_PURPOSE = 'dsh-personalised-import'

const EMPTY_FINISH = Object.freeze({ kind: 'stop' })

/**
 * 把任意文本包装成宿主接受的一条 user 消息。
 * 手工构造 `RequestUserInput` 形状（role + content），不需要 `createUserMessage`。
 * @param {string} text
 * @returns {{role:'user', content:{type:'text', text:string}[]}}
 */
export function buildUserMessage(text) {
  return { role: 'user', content: [{ type: 'text', text: String(text == null ? '' : text) }] }
}

/**
 * 汇总流式 chunk 中的文本块（`BlockAssembler` 的等价最小实现）。
 *
 * @param {Iterable<object>} chunks 宿主 `StreamChunk` 序列
 * @returns {{text:string, finish:object, usage:object|null, blockCount:number}}
 */
export function assembleTextBlocks(chunks) {
  const partials = new Map()
  const order = []
  let finish = EMPTY_FINISH
  let usage = null

  function ensure(index, blockType) {
    let partial = partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', block: null }
      partials.set(index, partial)
      order.push(index)
    }
    return partial
  }

  for (const chunk of chunks || []) {
    if (!chunk || typeof chunk !== 'object') continue
    switch (chunk.type) {
      case 'block-start':
        ensure(chunk.index, chunk.blockType)
        break
      case 'text-delta': {
        const partial = ensure(chunk.index, 'text')
        if (!partial.block) partial.text += String(chunk.text == null ? '' : chunk.text)
        break
      }
      case 'reasoning-delta': {
        const partial = ensure(chunk.index, 'reasoning')
        if (!partial.block) partial.text += String(chunk.text == null ? '' : chunk.text)
        break
      }
      case 'tool-call-delta':
        ensure(chunk.index, 'tool-call')
        break
      case 'block-end': {
        if (!chunk.block || typeof chunk.block !== 'object') break
        const partial = ensure(chunk.index, chunk.block.type)
        // 第一次 block-end 为准；后续重复关闭忽略（与 BlockAssembler 一致）
        if (!partial.block) partial.block = chunk.block
        break
      }
      case 'usage':
        if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason : EMPTY_FINISH
        break
      default:
        break
    }
  }

  const texts = []
  let blockCount = 0
  for (const index of order) {
    const partial = partials.get(index)
    const block = partial.block
      || (partial.blockType === 'text' ? { type: 'text', text: partial.text }
        : partial.blockType === 'reasoning' ? { type: 'reasoning', text: partial.text } : null)
    if (!block) continue
    if (block.type !== 'text') continue
    const text = String(block.text == null ? '' : block.text)
    if (!text) continue
    texts.push(text)
    blockCount += 1
  }
  return { text: texts.join('\n'), finish, usage, blockCount }
}

/** 组合调用方 signal 与超时；返回可控 deadline。 */
function createDeadline(externalSignal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  let timer = null
  const onExternalAbort = () => {
    try { controller.abort(externalSignal.reason) } catch (_) { controller.abort() }
  }
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    if (externalSignal.aborted) onExternalAbort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      const reason = new Error('llm-call timeout')
      reason.code = 'TIMEOUT'
      try { controller.abort(reason) } catch (_) { controller.abort() }
    }, timeoutMs)
    // 故意不 unref：unref 后若进程里没有别的句柄，计时器不会触发，请求就永远不超时。
    // 调用结束的 finally 一定会 clearTimeout，不会留悬挂定时器。
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer)
      if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    },
  }
}

async function iterateStream(streamOrPromise) {
  const stream = streamOrPromise && typeof streamOrPromise.then === 'function'
    ? await streamOrPromise
    : streamOrPromise
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') return stream
  if (stream && typeof stream[Symbol.iterator] === 'function') return stream
  throw new Error('llm-call: stream() 没有返回可迭代的 chunk 流')
}

/**
 * 用宿主 llm 服务造一个 `llmCall(options) => Promise<result>`。
 *
 * options：`{provider, model, prompt, system?, maxTokens?, purpose?, timeoutMs?, signal?}`
 * 缺 `prepareCall` 时退化用 `llm.stream`（省掉默认值补齐与前置校验）。
 *
 * @param {object} llm 宿主 `ctx.llm`
 * @returns {(options:object) => Promise<{text:string,finish:object,warnings:string[],provider:string,model:string,usage:object|null,elapsedMs:number}>}
 */
export function makeLlmCall(llm) {
  if (!llm || typeof llm !== 'object') throw new Error('makeLlmCall: 需要 ctx.llm')
  const canPrepare = typeof llm.prepareCall === 'function'
  const canStream = typeof llm.stream === 'function'
  if (!canPrepare && !canStream) throw new Error('makeLlmCall: llm 既没有 prepareCall 也没有 stream')

  return async function llmCall(options = {}) {
    const opt = options || {}
    const provider = opt.provider == null ? '' : String(opt.provider).trim()
    const model = opt.model == null ? '' : String(opt.model).trim()
    if (!provider || !model) throw new Error('llm-call: 需要 provider 与 model')
    const prompt = String(opt.prompt == null ? '' : opt.prompt)
    if (!prompt.trim()) throw new Error('llm-call: prompt 为空')
    const maxTokens = Number.isFinite(Number(opt.maxTokens)) && Number(opt.maxTokens) > 0
      ? Math.floor(Number(opt.maxTokens))
      : DEFAULT_MAX_TOKENS
    const purpose = opt.purpose == null || String(opt.purpose).trim() === ''
      ? DEFAULT_PURPOSE
      : String(opt.purpose).trim()
    const timeoutMs = Number.isFinite(Number(opt.timeoutMs)) && Number(opt.timeoutMs) > 0
      ? Math.floor(Number(opt.timeoutMs))
      : 0
    const system = opt.system == null ? '' : String(opt.system)
    const deadline = createDeadline(opt.signal, timeoutMs)
    const startedAt = Date.now()

    try {
      const messages = [buildUserMessage(prompt)]
      let stream
      if (canPrepare) {
        const call = await llm.prepareCall({ provider, model, maxTokens }, deadline.signal)
        if (!call || typeof call.stream !== 'function') throw new Error('llm-call: prepareCall 返回值缺少 stream()')
        const request = {
          ...(call.config && typeof call.config === 'object' ? call.config : {}),
          messages,
          purpose,
          signal: deadline.signal,
        }
        if (system.trim()) request.system = system
        stream = await iterateStream(call.stream(request))
      } else {
        const request = { provider, model, maxTokens, messages, purpose, signal: deadline.signal }
        if (system.trim()) request.system = system
        stream = await iterateStream(llm.stream(request))
      }

      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      const assembled = assembleTextBlocks(chunks)
      const finishKind = assembled.finish && assembled.finish.kind
      if (finishKind === 'error' || finishKind === 'aborted') {
        const failure = assembled.finish.failure && typeof assembled.finish.failure === 'object'
          ? assembled.finish.failure
          : {}
        const error = new Error(String(failure.message || (finishKind === 'aborted' ? '模型请求已取消' : '模型请求失败')))
        error.code = String(failure.code || (finishKind === 'aborted' ? 'ABORTED' : 'LLM_ERROR'))
        error.failure = failure
        error.finish = assembled.finish
        throw error
      }
      const warnings = []
      if (finishKind === 'max-tokens') warnings.push('模型输出达到 maxTokens 上限（' + maxTokens + '），结果可能不完整')
      return {
        text: assembled.text,
        finish: assembled.finish,
        warnings,
        provider,
        model,
        usage: assembled.usage,
        elapsedMs: Date.now() - startedAt,
      }
    } catch (e) {
      if (deadline.timedOut()) {
        const error = new Error('模型请求超时（' + timeoutMs + 'ms）')
        error.code = 'TIMEOUT'
        error.cause = e
        throw error
      }
      throw e
    } finally {
      deadline.dispose()
    }
  }
}
