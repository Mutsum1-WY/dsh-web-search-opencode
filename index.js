/**
 * dsh-web-search-opencode — OpenCode Go 网页搜索（第三方 DSH 插件·宿主半）
 *
 * 给 DeepSeek Harness 的 web seam（`ctx.web`）注册搜索提供方 `opencode-go`：
 * 用 OpenCode Go 订阅里的模型执行联网搜索，把结果映射成 web seam 的
 * `WebSearchResult`（url / title / snippet / publishedAt）。
 *
 * 为什么必须独立插件：内置 `@deepseek-ai/dsh-web-search-deepseek` 的请求头写死、
 * 没有自定义 header 的配置项，而 OpenCode Go 网关要求每个请求带稳定的
 * `x-opencode-session`，否则返回 400 MissingSessionID。
 *
 * 第三方插件约束：本文件不 import 任何 `@deepseek-ai/*` 包，只依赖 Node 内置模块。
 *
 * 多模型 + 多协议（2026-10-26 实测）：
 * - 只有部分 Go 模型支持联网搜索，且不同模型在不同协议端点：
 *   · Anthropic Messages（web_search_20250305 服务端工具）：
 *       minimax-m3.1-flash、minimax-m3、claude-haiku-5-5、deepseek-v4-pro、
 *       minimax-m2.5、minimax-m2.7、kimi-k3、kimi-k3.1-pro
 *   · OpenAI Responses（内置 web_search 工具）：grok-4.7
 *   · Google Gemini（google_search 工具 + grounding）：gemini-4-argon
 * - deepseek-v4.1-flash / qwen3.x 实测不支持：网关会静默丢掉 web_search 工具
 *   （Anthropic 和 Responses 两种协议都返回 200 但只有 thinking+text，没有搜索结果）；
 *   gpt-6-luna / gpt-5.6-luna / muse-spark 在本地区域返回 403，未纳入候选。
 * - 默认主模型 `minimax-m3.1-flash`（最快最便宜），候选链按“可用 + 速度”排序，
 *   任一模型失败（含没搜到结果）自动换下一个，全部失败才抛错。
 *
 * 插件形态：宿主行由本包 `cordis.patch.yml` 的 insert 声明（id `web-search-opencode`），
 * 同一 patch 覆盖内置 `web` 行把 `searchProvider` 指到这里；开关是「插件」页里本组合包
 * 的开关（关闭后整层 patch 消失，web 回到内置提供方）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 在 `ctx.web` 里注册的提供方 id（与 cordis.patch.yml 里 web.searchProvider 对应）。 */
const PROVIDER_ID = 'opencode-go'

/** 插件名，供 Loader 诊断。 */
const name = 'web-search-opencode'

/** 本插件只注册搜索提供方，需要 web seam。 */
const inject = ['web']

/** 默认主模型（实测最快最便宜：~3s、10 条来源）。 */
const DEFAULT_MODEL = 'minimax-m3.1-flash'

/**
 * 实测可用的搜索模型与协议。代码里固定协议归属，配置里只写模型 id 即可。
 * 顺序 = 默认候选链顺序（主模型在最前，其余按实测速度排序）。
 */
const SEARCH_MODELS = Object.freeze([
  { id: 'minimax-m3.1-flash', protocol: 'anthropic' },
  { id: 'minimax-m3', protocol: 'anthropic' },
  { id: 'claude-haiku-5-5', protocol: 'anthropic' },
  { id: 'deepseek-v4-pro', protocol: 'anthropic' },
  { id: 'minimax-m2.5', protocol: 'anthropic' },
  { id: 'minimax-m2.7', protocol: 'anthropic' },
  { id: 'kimi-k3', protocol: 'anthropic' },
  { id: 'kimi-k3.1-pro', protocol: 'anthropic' },
  { id: 'grok-4.7', protocol: 'responses' },
  { id: 'gemini-4-argon', protocol: 'gemini' },
])

/** 默认候选链（模型 id 数组）。 */
const SEARCH_MODEL_CHAIN = Object.freeze(SEARCH_MODELS.map((model) => model.id))

const PROTOCOL_BY_MODEL = new Map(SEARCH_MODELS.map((model) => [model.id, model.protocol]))

const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'
const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/anthropic/v1'
const DEFAULT_RESPONSES_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'
const DEFAULT_GEMINI_BASE_URL = 'https://opencode.ai/inference/go/google/v1beta'
const DEFAULT_API_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MAX_USES = 3
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_PROMPT = 'Perform a web search for the query: {query}'
const USER_AGENT = 'dsh-web-search-opencode/1.1.0'

/** 稳定的 OpenCode 会话 ID 落盘位置（不写进包目录，避免污染安装副本）。 */
function sessionFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'opencode-web-search', 'session-id')
}

/** 与内置 web 提供方同形状的 `WebError`：name/code 稳定，消息可直接展示。 */
class OpenCodeSearchError extends Error {
  constructor(message, code = 'WEB_PROVIDER_ERROR', options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/** Volatile 配置（如有）在运行中是引用对象，读当前值要调用 get()。 */
function readConfigValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/** 取一个稳定的 OpenCode 会话 ID：配置优先，其次持久化文件，最后生成并落盘。 */
function resolveSessionId(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  const file = sessionFile()
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    if (stored.length > 0) return stored
  } catch {
    /* first run */
  }
  const generated = `dsh-websearch-${randomUUID()}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${generated}\n`, 'utf8')
  } catch (error) {
    console.warn(`[web-search-opencode] cannot persist session id: ${String(error)}`)
  }
  return generated
}

/** 把模型 id（或 {id, protocol} 条目）规范成候选条目。 */
function normalizeCandidate(value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    const id = value.trim()
    return { id, protocol: PROTOCOL_BY_MODEL.get(id) ?? 'anthropic' }
  }
  if (value !== null && typeof value === 'object' && typeof value.id === 'string' && value.id.trim().length > 0) {
    const id = value.id.trim()
    const protocol =
      typeof value.protocol === 'string' && ['anthropic', 'responses', 'gemini'].includes(value.protocol)
        ? value.protocol
        : (PROTOCOL_BY_MODEL.get(id) ?? 'anthropic')
    return { id, protocol }
  }
  return undefined
}

/** 组装候选链：配置 models 优先，否则 [主模型, ...默认链去重]。 */
function resolveCandidates(config) {
  const configuredModels = readConfigValue(config.models)
  if (Array.isArray(configuredModels) && configuredModels.length > 0) {
    const seen = new Set()
    const candidates = []
    for (const value of configuredModels) {
      const candidate = normalizeCandidate(value)
      if (candidate === undefined || seen.has(candidate.id)) continue
      seen.add(candidate.id)
      candidates.push(candidate)
    }
    if (candidates.length > 0) return candidates
  }
  const primary = readConfigValue(config.model)
  const primaryId = typeof primary === 'string' && primary.trim().length > 0 ? primary.trim() : DEFAULT_MODEL
  return [normalizeCandidate(primaryId), ...SEARCH_MODELS.filter((model) => model.id !== primaryId)].filter(
    (candidate) => candidate !== undefined,
  )
}

/**
 * 把（补丁层的）配置投影成一次搜索用的选项。每次操作都重读当前条目 config，
 * 所以在 profile patch 里覆盖本行 config 后无需重装，下一次搜索即生效。
 */
function normalizeOptions(ctx, source) {
  const config = source ?? {}
  const apiKeyEnv =
    typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
      ? config.apiKeyEnv
      : DEFAULT_API_KEY_ENV
  const literalApiKey =
    typeof config.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined
  const promptTemplate =
    typeof config.prompt === 'string' && config.prompt.includes('{query}') ? config.prompt : DEFAULT_PROMPT

  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    apiKeyEnv,
    resolveApiKey: async () => {
      const credentials = ctx.get?.('credentials')
      if (credentials !== undefined && credentials !== null) {
        const resolved = await credentials.resolve(apiKeyEnv)
        if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value
      }
      const ambient = process.env[apiKeyEnv]
      return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
    },
    candidates: resolveCandidates(config),
    fallback: readConfigValue(config.fallback) !== false,
    baseURL: String(readConfigValue(config.baseURL) ?? DEFAULT_BASE_URL).replace(/\/+$/u, ''),
    responsesBaseURL: String(readConfigValue(config.responsesBaseURL) ?? DEFAULT_RESPONSES_BASE_URL).replace(
      /\/+$/u,
      '',
    ),
    geminiBaseURL: String(readConfigValue(config.geminiBaseURL) ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/u, ''),
    apiVersion: readConfigValue(config.apiVersion) ?? DEFAULT_API_VERSION,
    maxTokens: readConfigValue(config.maxTokens) ?? DEFAULT_MAX_TOKENS,
    maxUses: readConfigValue(config.maxUses) ?? DEFAULT_MAX_USES,
    timeoutMs: readConfigValue(config.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    prompt: promptTemplate,
    sessionId: resolveSessionId(readConfigValue(config.sessionId)),
  }
}

function promptFor(options, query) {
  return options.prompt.replaceAll('{query}', String(query ?? ''))
}

function searchAborted(signal) {
  return new OpenCodeSearchError('OpenCode search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : undefined,
  })
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal)
}

async function resolveApiKey(options, signal) {
  throwIfAborted(signal)
  if (options.apiKey !== undefined) return options.apiKey
  let resolved
  try {
    resolved = await options.resolveApiKey()
  } catch (error) {
    if (signal?.aborted === true) throw searchAborted(signal)
    throw new OpenCodeSearchError(`OpenCode search credential resolution failed: ${String(error)}`)
  }
  if (typeof resolved === 'string' && resolved.length > 0) return resolved
  throw new OpenCodeSearchError(
    `OpenCode search has no API key for "${options.apiKeyEnv}"; store it through the credentials service or set a literal "apiKey" in the web-search-opencode row config`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/** 带 x-opencode-session 的请求头；Anthropic 端点额外要 x-api-key 与版本头。 */
function requestHeaders(options, apiKey, protocol) {
  const common = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
    'x-opencode-session': options.sessionId,
  }
  if (protocol !== 'anthropic') return common
  return { ...common, 'x-api-key': apiKey, 'anthropic-version': options.apiVersion }
}

/** 解析非 2xx 响应，尽量取网关给的具体原因。 */
async function upstreamError(response, modelId) {
  let detail = ''
  try {
    const parsed = await response.json()
    const candidate =
      typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error?.message ?? parsed.message ?? parsed.error?.type)
    if (typeof candidate === 'string' && candidate.length > 0) detail = candidate
  } catch {
    /* keep the generic message */
  }
  const suffix = detail.length > 0 ? `: ${detail}` : ''
  return new OpenCodeSearchError(`OpenCode API error (HTTP ${response.status}) for model ${modelId}${suffix}`)
}

function mergeSource(map, url, patch) {
  if (typeof url !== 'string' || url.length === 0) return
  const existing = map.get(url) ?? { url }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null && value !== '' && existing[key] === undefined) existing[key] = value
  }
  map.set(url, existing)
}

/** 标题：忽略纯数字等无信息量的 annotation title。 */
function usefulTitle(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || /^\d+$/u.test(trimmed)) return undefined
  return trimmed
}

/** Anthropic Messages：web_search_tool_result + text 块 citations。 */
function mapAnthropicResponse(json) {
  const blocks = json.content ?? []
  const resultBlocks = blocks.filter((block) => block.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new OpenCodeSearchError(
      'OpenCode returned no web_search_tool_result blocks; this model did not run the web_search tool',
    )
  }
  const snippets = new Map()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const citation of block.citations ?? []) {
      if (
        citation.url != null &&
        citation.url.length > 0 &&
        citation.cited_text != null &&
        citation.cited_text.length > 0 &&
        !snippets.has(citation.url)
      ) {
        snippets.set(citation.url, citation.cited_text)
      }
    }
  }
  const map = new Map()
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result') continue
      mergeSource(map, item.url, {
        title: usefulTitle(item.title),
        snippet: snippets.get(item.url),
        publishedAt: typeof item.page_age === 'string' && item.page_age.length > 0 ? item.page_age : undefined,
      })
    }
  }
  return { sources: [...map.values()], truncated: false }
}

/** OpenAI Responses：web_search_call.action.sources + message 的 url_citation 注解。 */
function mapResponsesResponse(json) {
  const items = json.output ?? []
  const map = new Map()
  for (const item of items) {
    if (item.type !== 'web_search_call') continue
    const sources = item.action?.sources ?? item.sources ?? []
    for (const source of sources) {
      if (source?.type === 'url' || source?.url) mergeSource(map, source.url, {})
    }
  }
  for (const item of items) {
    if (item.type !== 'message') continue
    for (const content of item.content ?? []) {
      if (content.type !== 'output_text') continue
      const text = typeof content.text === 'string' ? content.text : ''
      for (const annotation of content.annotations ?? []) {
        if (annotation.type !== 'url_citation') continue
        const start = annotation.start_index
        const end = annotation.end_index
        const snippet =
          typeof start === 'number' && typeof end === 'number' && end > start ? text.slice(start, end) : undefined
        mergeSource(map, annotation.url, { title: usefulTitle(annotation.title), snippet })
      }
    }
  }
  if (map.size === 0) throw new OpenCodeSearchError('OpenCode Responses search returned no web search sources')
  return { sources: [...map.values()], truncated: false }
}

/** Google Gemini：groundingChunks[].web + groundingSupports[].segment.text。 */
function mapGeminiResponse(json) {
  const candidate = json.candidates?.[0]
  const grounding = candidate?.groundingMetadata
  if (grounding === null || grounding === undefined) {
    throw new OpenCodeSearchError('OpenCode Gemini search returned no grounding metadata (web search did not run)')
  }
  const chunks = grounding.groundingChunks ?? []
  const snippets = new Map()
  for (const support of grounding.groundingSupports ?? []) {
    const text = typeof support.segment?.text === 'string' ? support.segment.text : undefined
    if (text === undefined || text.length === 0) continue
    for (const index of support.groundingChunkIndices ?? []) {
      const key = String(index)
      if (!snippets.has(key)) snippets.set(key, text)
    }
  }
  const map = new Map()
  for (const [index, chunk] of chunks.entries()) {
    const web = chunk?.web
    if (web === undefined || web === null) continue
    mergeSource(map, web.uri, {
      title: usefulTitle(web.title) ?? usefulTitle(web.domain),
      snippet: snippets.get(String(index)),
    })
  }
  if (map.size === 0) throw new OpenCodeSearchError('OpenCode Gemini search returned no web grounding sources')
  return { sources: [...map.values()], truncated: false }
}

/** 各协议的请求体。 */
function anthropicBody(options, modelId, query) {
  return {
    model: modelId,
    max_tokens: options.maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: promptFor(options, query) }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
  }
}

function responsesBody(options, modelId, query) {
  return { model: modelId, input: promptFor(options, query), tools: [{ type: 'web_search' }] }
}

function geminiBody(options, query) {
  return {
    contents: [{ role: 'user', parts: [{ text: promptFor(options, query) }] }],
    tools: [{ google_search: {} }],
  }
}

/** 用某个候选模型跑一次真实搜索，返回 web seam 的搜索结果。 */
async function searchWithModel(modelId, protocol, request, options, apiKey, signal) {
  const headers = requestHeaders(options, apiKey, protocol)
  let endpoint
  let body
  let map
  if (protocol === 'responses') {
    endpoint = `${options.responsesBaseURL}/responses`
    body = responsesBody(options, modelId, request.query)
    map = mapResponsesResponse
  } else if (protocol === 'gemini') {
    endpoint = `${options.geminiBaseURL}/models/${encodeURIComponent(modelId)}:generateContent`
    body = geminiBody(options, request.query)
    map = mapGeminiResponse
  } else {
    endpoint = `${options.baseURL}/messages`
    body = anthropicBody(options, modelId, request.query)
    map = mapAnthropicResponse
  }

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true && signal.reason?.name !== 'TimeoutError') throw searchAborted(signal)
    throw new OpenCodeSearchError(`OpenCode search request failed for model ${modelId}: ${String(error)}`)
  }
  if (!response.ok) throw await upstreamError(response, modelId)

  let json
  try {
    json = await response.json()
  } catch (error) {
    throw new OpenCodeSearchError(`OpenCode returned an unprocessable response body for model ${modelId}: ${String(error)}`)
  }
  return map(json)
}

/** 用 OpenCode Go 的联网搜索能力跑一次查询（按候选链自动兜底）。 */
class OpenCodeSearchProvider {
  /** @param {() => object} resolveOptions - 取下一次操作快照的 thunk（配置改动即时生效）。 */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions
    this.id = PROVIDER_ID
  }

  available() {
    const options = this.resolveOptions()
    if (options.candidates.length === 0) return false
    if (!isPositiveInteger(options.maxTokens) || !isPositiveInteger(options.maxUses)) return false
    if (!isPositiveInteger(options.timeoutMs)) return false
    const protocols = new Set(options.candidates.map((candidate) => candidate.protocol))
    if (protocols.has('anthropic') && !URL.canParse(options.baseURL)) return false
    if (protocols.has('responses') && !URL.canParse(options.responsesBaseURL)) return false
    if (protocols.has('gemini') && !URL.canParse(options.geminiBaseURL)) return false
    return true
  }

  async search(request, signal) {
    const options = this.resolveOptions()
    const apiKey = await resolveApiKey(options, signal)
    throwIfAborted(signal)

    const deadline = Date.now() + options.timeoutMs
    const failures = []
    let lastError
    for (const candidate of options.candidates) {
      throwIfAborted(signal)
      const remaining = deadline - Date.now()
      if (remaining <= 500) {
        failures.push(`${candidate.id}: no time left in timeoutMs`)
        break
      }
      const attemptSignal =
        signal === undefined
          ? AbortSignal.timeout(remaining)
          : AbortSignal.any([signal, AbortSignal.timeout(remaining)])
      try {
        const result = await searchWithModel(candidate.id, candidate.protocol, request, options, apiKey, attemptSignal)
        if (result.sources.length > 0) return result
        failures.push(`${candidate.id}: no sources`)
        if (!options.fallback) break
      } catch (error) {
        if (signal?.aborted === true) throw searchAborted(signal)
        if (error instanceof OpenCodeSearchError && error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING') throw error
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${candidate.id}: ${message.length > 240 ? `${message.slice(0, 240)}…` : message}`)
        if (!options.fallback) break
      }
    }
    if (!options.fallback && lastError !== undefined) throw lastError
    const summary = failures.join(' | ')
    throw new OpenCodeSearchError(
      `OpenCode web search failed for every candidate model (${options.candidates.map((c) => c.id).join(', ')}): ${summary.length > 1800 ? `${summary.slice(0, 1800)}…` : summary}`,
    )
  }
}

/**
 * 挂载插件：注册搜索提供方。
 * 每次搜索都从 `ctx.fiber.config`（若 Loader 提供）重新读取配置，因此覆盖本行 config
 * 后立即生效；读不到时回退到 apply 时拿到的这份。
 *
 * @param {object} ctx - cordis 插件上下文。
 * @param {object} [config] - 本行补丁层的 config（无 Config 导出时按原样传入）。
 */
function apply(ctx, config) {
  const current = () => {
    const live = ctx.fiber !== undefined ? ctx.fiber.config : undefined
    return live !== undefined && live !== null ? live : (config ?? {})
  }
  return ctx.web.registerSearchProvider(new OpenCodeSearchProvider(() => normalizeOptions(ctx, current())))
}

export {
  name,
  inject,
  apply,
  PROVIDER_ID,
  SEARCH_MODELS,
  SEARCH_MODEL_CHAIN,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_RESPONSES_BASE_URL,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_API_KEY_ENV,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_USES,
  DEFAULT_TIMEOUT_MS,
  OpenCodeSearchProvider,
  OpenCodeSearchError,
  mapAnthropicResponse,
  mapResponsesResponse,
  mapGeminiResponse,
}
