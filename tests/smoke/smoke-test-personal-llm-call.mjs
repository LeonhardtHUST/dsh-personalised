/**
 * smoke-test-personal-llm-call —— 用宿主 ctx.llm 做一次补全的适配层（不 import @deepseek-ai/*）。
 *
 * 契约：docs/personalised/research-dsh-rc3-api.md §3.2（prepareCall → call.stream → BlockAssembler）。
 * 用假 llm 流验证：消息/系统提示词/用途透传、文本块汇总、finish error/aborted 抛错、
 * 超时 AbortSignal、无 prepareCall 时退化 llm.stream。纯 Node、零依赖、不联网。
 */
import { assembleTextBlocks, buildUserMessage, DEFAULT_MAX_TOKENS, DEFAULT_PURPOSE, makeLlmCall } from '../../lib/personal/llm-call.js'

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok - ' + name) } else { fail++; console.error('  FAIL - ' + name) } }
const eq = (a, b, name) => {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  ok(ja === jb, name + (ja === jb ? '' : ' got=' + ja + ' want=' + jb))
}
const rejects = async (promise, name, check) => {
  try {
    await promise
    fail++
    console.error('  FAIL - ' + name + '（本应拒绝，实际成功）')
  } catch (e) {
    const detail = check ? check(e) : true
    ok(detail === true, name + (detail === true ? '' : '（' + detail + '）'))
  }
}

/** 造一段标准文本流。 */
async function* textStream(texts, finish = { kind: 'stop' }) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (const text of texts) yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: texts.join('') } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
  yield { type: 'finish', reason: finish }
}

/** 记录调用的假 llm。 */
function fakeLlm(options = {}) {
  const calls = { prepare: [], stream: [] }
  const llm = {
    async prepareCall(config, signal) {
      calls.prepare.push({ config, signal })
      if (options.prepareError) throw options.prepareError
      return {
        config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens, temperature: 0 },
        stream(request) {
          calls.stream.push(request)
          return options.stream ? options.stream(request) : textStream(['{"entries":[]}'])
        },
      }
    },
  }
  if (options.withRawStream) {
    llm.stream = (request) => {
      calls.stream.push(request)
      return textStream(['raw-stream-ok'])
    }
  }
  return { llm, calls }
}

console.log('[L0] 装配器：文本块 / delta-only / block-end 优先 / reasoning 不计入')
{
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '前半' },
    { type: 'text-delta', index: 0, text: '后半' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '前半后半' } },
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: '思考过程' },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: '思考过程' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const r = assembleTextBlocks(chunks)
  eq(r.text, '前半后半', '只汇总 text 块')
  eq(r.blockCount, 1, 'reasoning 不计入 blockCount')
  eq(r.finish, { kind: 'stop' }, 'finish 透传')
  eq(r.usage, null, '没有 usage chunk 时为 null')

  const deltaOnly = assembleTextBlocks([
    { type: 'text-delta', index: 0, text: 'a' },
    { type: 'text-delta', index: 0, text: 'b' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  eq(deltaOnly.text, 'ab', 'delta-only 协议也能汇总')
  eq(deltaOnly.finish, { kind: 'max-tokens' }, 'delta-only 的 finish 透传')

  const authoritative = assembleTextBlocks([
    { type: 'text-delta', index: 0, text: '流式' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '权威块' } },
    { type: 'text-delta', index: 0, text: '迟到 delta 应被忽略' },
  ])
  eq(authoritative.text, '权威块', 'block-end 之后到达的 delta 被忽略')

  const multi = assembleTextBlocks([
    { type: 'text-delta', index: 0, text: '一' },
    { type: 'text-delta', index: 1, text: '二' },
  ])
  eq(multi.text, '一\n二', '多块按流顺序以换行拼接')
  eq(assembleTextBlocks([]).text, '', '空流 → 空文本')
  eq(assembleTextBlocks([null, { type: 'unknown' }]).text, '', '畸形 chunk 被忽略')
}

console.log('[L1] makeLlmCall：prepareCall → stream 的请求形状')
{
  const { llm, calls } = fakeLlm({ stream: () => textStream(['{"ok":true}']) })
  const call = makeLlmCall(llm)
  const res = await call({ provider: 'deepseek', model: 'deepseek-v4', system: '你是整理器', prompt: '请整理' })
  eq(res.text, '{"ok":true}', '返回汇总后的文本')
  eq(res.provider + '/' + res.model, 'deepseek/deepseek-v4', '返回 route 身份')
  eq(res.finish, { kind: 'stop' }, '返回 finish')
  eq(res.warnings, [], '正常结束无 warning')
  eq(res.usage, { inputTokens: 10, outputTokens: 20 }, 'usage 透传')
  ok(res.elapsedMs >= 0, '返回耗时')

  eq(calls.prepare.length, 1, 'prepareCall 调用一次')
  eq(calls.prepare[0].config, { provider: 'deepseek', model: 'deepseek-v4', maxTokens: DEFAULT_MAX_TOKENS }, 'prepareCall 收到 provider/model/maxTokens')
  const request = calls.stream[0]
  eq(request.purpose, DEFAULT_PURPOSE, 'purpose 透传')
  eq(request.system, '你是整理器', 'system 透传')
  eq(request.temperature, 0, 'call.config 的字段原样展开（含适配器默认值）')
  eq(request.messages, [{ role: 'user', content: [{ type: 'text', text: '请整理' }] }], '消息形状 = RequestUserInput')
  ok(request.signal instanceof AbortSignal, 'signal 透传')

  const noSystem = fakeLlm({ stream: () => textStream(['x']) })
  await makeLlmCall(noSystem.llm)({ provider: 'p', model: 'm', prompt: 'x', maxTokens: 256, purpose: 'custom-purpose' })
  eq(noSystem.calls.stream[0].maxTokens, 256, 'maxTokens 经 call.config 原样下发（与 prepareCall 一致，否则 INVALID_PREPARED_CALL）')
  eq(noSystem.calls.stream[0].system, undefined, '空 system 不下发')
  eq(noSystem.calls.stream[0].purpose, 'custom-purpose', '自定义 purpose 可覆盖')
  eq(noSystem.calls.prepare[0].config.maxTokens, 256, '自定义 maxTokens 传到 prepareCall')
}

console.log('[L2] finish error / aborted 抛错；max-tokens 只给 warning')
{
  const errorLlm = fakeLlm({ stream: () => textStream(['部分'], { kind: 'error', failure: { code: 'AUTH', message: '密钥无效' } }) })
  await rejects(makeLlmCall(errorLlm.llm)({ provider: 'p', model: 'm', prompt: 'x' }), 'finish=error 抛错', (e) => (
    e.code === 'AUTH' && e.message.includes('密钥无效') ? true : 'code=' + e.code + ' msg=' + e.message))

  const abortLlm = fakeLlm({ stream: () => textStream([], { kind: 'aborted', failure: { code: 'ABORTED', message: '调用方取消' } }) })
  await rejects(makeLlmCall(abortLlm.llm)({ provider: 'p', model: 'm', prompt: 'x' }), 'finish=aborted 抛错', (e) => (
    e.code === 'ABORTED' ? true : 'code=' + e.code))

  const maxLlm = fakeLlm({ stream: () => textStream(['截断'], { kind: 'max-tokens' }) })
  const maxRes = await makeLlmCall(maxLlm.llm)({ provider: 'p', model: 'm', prompt: 'x' })
  eq(maxRes.text, '截断', 'max-tokens 仍返回已产出的文本')
  ok(maxRes.warnings.some((w) => w.includes('maxTokens')), 'max-tokens 带 warning（不静默）')
}

console.log('[L3] 超时 AbortSignal / 外部取消 / 无 prepareCall 退化 llm.stream / 参数校验')
{
  const slow = {
    async prepareCall() {
      return {
        config: { provider: 'p', model: 'm' },
        async *stream(request) {
          yield { type: 'text-delta', index: 0, text: '开始' }
          await new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true })
          })
        },
      }
    },
  }
  const startedAt = Date.now()
  await rejects(makeLlmCall(slow)({ provider: 'p', model: 'm', prompt: 'x', timeoutMs: 40 }), '超时抛 TIMEOUT', (e) => (
    e.code === 'TIMEOUT' && e.message.includes('40') ? true : 'code=' + e.code + ' msg=' + e.message))
  ok(Date.now() - startedAt < 2000, '超时在 timeoutMs 后很快返回（不挂死）')

  const controller = new AbortController()
  const external = {
    async prepareCall(config, signal) {
      return {
        config: { provider: 'p', model: 'm' },
        async *stream(request) {
          request.signal.addEventListener('abort', () => {})
          yield { type: 'text-delta', index: 0, text: 'x' }
          await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
        },
      }
    },
  }
  const pending = makeLlmCall(external)({ provider: 'p', model: 'm', prompt: 'x', signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await rejects(pending, '外部 signal 取消也会及时返回', () => true)

  const { llm: rawLlm, calls: rawCalls } = fakeLlm({ withRawStream: true })
  delete rawLlm.prepareCall
  const rawRes = await makeLlmCall(rawLlm)({ provider: 'p', model: 'm', prompt: 'x', system: 'sys' })
  eq(rawRes.text, 'raw-stream-ok', '无 prepareCall 时退化 llm.stream 并可读文本')
  eq(rawCalls.stream[0].provider, 'p', '退化路径自己填 provider')
  eq(rawCalls.stream[0].system, 'sys', '退化路径自己填 system')

  await rejects(makeLlmCall(fakeLlm().llm)({ provider: 'p', prompt: 'x' }), '缺 model 直接拒绝', (e) => e.message.includes('provider 与 model'))
  await rejects(makeLlmCall(fakeLlm().llm)({ provider: 'p', model: 'm', prompt: '   ' }), '空 prompt 直接拒绝', (e) => e.message.includes('prompt'))
  let threw = null
  try { makeLlmCall({}) } catch (e) { threw = e }
  ok(threw && threw.message.includes('prepareCall'), 'llm 缺能力时构造期就抛错')

  const badStream = { prepareCall: async () => ({ config: {}, stream: () => 42 }) }
  await rejects(makeLlmCall(badStream)({ provider: 'p', model: 'm', prompt: 'x' }), 'stream() 返回不可迭代对象 → 抛错', (e) => e.message.includes('可迭代'))

  const prepFail = fakeLlm({ prepareError: new Error('NO_ADAPTER') })
  await rejects(makeLlmCall(prepFail.llm)({ provider: 'p', model: 'm', prompt: 'x' }), 'prepareCall 失败原样上抛', (e) => e.message === 'NO_ADAPTER')
}

console.log('[L4] 纯辅助：buildUserMessage / 不 import @deepseek-ai')
{
  eq(buildUserMessage('hi'), { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'user 消息形状')
  eq(buildUserMessage(null).content[0].text, '', 'null 文本安全')
}

console.log('\n[personal-llm-call] pass=' + pass + ' fail=' + fail)
if (fail) process.exit(1)
console.log('PASS')
