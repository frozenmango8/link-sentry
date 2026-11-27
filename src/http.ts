import { redactUrl } from './target.js'
import type { FetchLike } from './types.js'

const GET_FALLBACK = new Set([400, 401, 403, 404, 405, 406, 501])
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  410: 'Gone',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

export interface HttpCheckOptions {
  timeoutMs: number
  retries: number
  maxRedirects: number
  maxRetryWaitMs: number
  userAgent: string
  headers: Record<string, string>
  headerHosts: string[]
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
  now: () => number
}

export interface HttpCheckResult {
  status: 'ok' | 'broken' | 'rate_limited' | 'timeout' | 'network'
  message: string
  httpStatus?: number
  method?: 'HEAD' | 'GET'
  attempts: number
  finalUrl?: string
}

type Attempt =
  | {
      type: 'response'
      httpStatus: number
      method: 'HEAD' | 'GET'
      finalUrl: string
      headers: Headers
    }
  | { type: 'timeout' }
  | { type: 'network'; message: string }
  | { type: 'broken'; message: string; httpStatus?: number; finalUrl?: string }

export function statusMessage(code: number): string {
  const reason = REASONS[code]
  return reason ? `${code} ${reason}` : String(code)
}

export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1000)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

export function retryDelayMs(
  attempt: number,
  retryAfter: string | null | undefined,
  options: { maxRetryWaitMs: number; random: () => number; now: () => number },
): number {
  const header = parseRetryAfter(retryAfter, options.now())
  if (header !== undefined) return Math.min(options.maxRetryWaitMs, header)
  const exponential = 500 * 2 ** attempt
  const jitter = Math.floor(options.random() * 250)
  return Math.min(options.maxRetryWaitMs, exponential + jitter)
}

export function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some((pattern) => {
    const expected = pattern.toLowerCase()
    if (expected.startsWith('*.')) {
      const rest = expected.slice(2)
      return host === rest || host.endsWith(`.${rest}`)
    }
    return host === expected
  })
}

export async function checkUrl(url: string, options: HttpCheckOptions): Promise<HttpCheckResult> {
  const attempts = options.retries + 1
  let lastNetwork = 'network error'

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await once(url, options)
    if (result.type === 'timeout') {
      if (attempt < attempts) {
        await options.sleep(retryDelayMs(attempt - 1, null, options))
        continue
      }
      return {
        status: 'timeout',
        message: `timed out after ${options.timeoutMs}ms (${attempt} ${noun(attempt)})`,
        attempts: attempt,
      }
    }
    if (result.type === 'network') {
      lastNetwork = result.message
      if (attempt < attempts) {
        await options.sleep(retryDelayMs(attempt - 1, null, options))
        continue
      }
      return {
        status: 'network',
        message: `${lastNetwork} (${attempt} ${noun(attempt)})`,
        attempts: attempt,
      }
    }
    if (result.type === 'broken') {
      return {
        status: 'broken',
        message: result.message,
        httpStatus: result.httpStatus,
        attempts: attempt,
        finalUrl: result.finalUrl,
      }
    }

    if (isSuccess(result.httpStatus)) {
      return {
        status: 'ok',
        message: statusMessage(result.httpStatus),
        httpStatus: result.httpStatus,
        method: result.method,
        attempts: attempt,
        finalUrl: result.finalUrl,
      }
    }

    if (RETRY_STATUSES.has(result.httpStatus) && attempt < attempts) {
      const header = result.httpStatus === 429 ? result.headers.get('retry-after') : null
      await options.sleep(retryDelayMs(attempt - 1, header, options))
      continue
    }

    if (result.httpStatus === 429) {
      return {
        status: 'rate_limited',
        message: `${statusMessage(429)} after ${attempt} ${noun(attempt)}`,
        httpStatus: 429,
        method: result.method,
        attempts: attempt,
        finalUrl: result.finalUrl,
      }
    }

    return {
      status: 'broken',
      message: statusMessage(result.httpStatus),
      httpStatus: result.httpStatus,
      method: result.method,
      attempts: attempt,
      finalUrl: result.finalUrl,
    }
  }

  return { status: 'network', message: lastNetwork, attempts }
}

async function once(url: string, options: HttpCheckOptions): Promise<Attempt> {
  const head = await request(url, 'HEAD', options)
  if (head.type === 'timeout' || head.type === 'broken') return head
  // Some servers reset the connection on HEAD, or answer 404/405/403 for HEAD
  // only. A GET to the same URL is the compatibility path.
  if (head.type === 'network' || GET_FALLBACK.has(head.httpStatus)) {
    return request(url, 'GET', options)
  }
  return head
}

async function request(
  startUrl: string,
  method: 'HEAD' | 'GET',
  options: HttpCheckOptions,
): Promise<Attempt> {
  let current = startUrl
  let currentMethod = method
  const seen = new Set<string>()
  const origin = hostnameOf(startUrl)

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const key = `${currentMethod} ${current}`
    if (seen.has(key)) {
      return { type: 'broken', message: `redirect loop at ${redactUrl(current)}`, finalUrl: redactUrl(current) }
    }
    seen.add(key)

    let response: Response
    try {
      response = await options.fetch(current, {
        method: currentMethod,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: buildHeaders(current, currentMethod, options, origin),
      })
    } catch (error) {
      if (isTimeout(error)) return { type: 'timeout' }
      return { type: 'network', message: errorMessage(error) }
    }

    await response.body?.cancel().catch(() => undefined)

    if (response.status === 0 || response.type === 'opaqueredirect') {
      return followOpaquely(current, currentMethod, options, origin)
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        return {
          type: 'broken',
          message: `${response.status} redirect with no Location`,
          httpStatus: response.status,
          finalUrl: redactUrl(current),
        }
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return {
          type: 'broken',
          message: `invalid redirect location "${location}"`,
          httpStatus: response.status,
          finalUrl: redactUrl(current),
        }
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return {
          type: 'broken',
          message: `redirect to unsupported protocol ${next.protocol}`,
          httpStatus: response.status,
          finalUrl: redactUrl(current),
        }
      }
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        currentMethod = 'GET'
      }
      current = next.href
      continue
    }

    return {
      type: 'response',
      httpStatus: response.status,
      method: currentMethod,
      finalUrl: redactUrl(current),
      headers: response.headers,
    }
  }

  return {
    type: 'broken',
    message: `too many redirects (max ${options.maxRedirects})`,
    finalUrl: redactUrl(current),
  }
}

async function followOpaquely(
  url: string,
  method: 'HEAD' | 'GET',
  options: HttpCheckOptions,
  origin: string,
): Promise<Attempt> {
  try {
    const response = await options.fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: buildHeaders(url, method, options, origin),
    })
    await response.body?.cancel().catch(() => undefined)
    return {
      type: 'response',
      httpStatus: response.status,
      method,
      finalUrl: redactUrl(response.url || url),
      headers: response.headers,
    }
  } catch (error) {
    if (isTimeout(error)) return { type: 'timeout' }
    return { type: 'network', message: errorMessage(error) }
  }
}

function buildHeaders(
  url: string,
  method: 'HEAD' | 'GET',
  options: HttpCheckOptions,
  origin: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept:
      method === 'GET'
        ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        : '*/*',
    'user-agent': options.userAgent,
  }
  const host = hostnameOf(url)
  const allowed =
    options.headerHosts.length > 0
      ? hostAllowed(host, options.headerHosts)
      : host === origin
  if (allowed) {
    for (const [name, value] of Object.entries(options.headers)) {
      headers[name.toLowerCase()] = value
    }
  }
  if (!headers['user-agent']) headers['user-agent'] = options.userAgent
  return headers
}

function hostnameOf(url: string): string {
  return new URL(url).hostname.toLowerCase()
}

function isSuccess(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false
  const name = String(error.name)
  return name === 'TimeoutError' || name === 'AbortError'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error && cause.message && !error.message.includes(cause.message)) {
      return `${error.message}: ${cause.message}`
    }
    return error.message || error.name
  }
  return String(error)
}

function noun(count: number): string {
  return count === 1 ? 'attempt' : 'attempts'
}
