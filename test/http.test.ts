import { describe, expect, it } from 'vitest'
import { checkUrl, parseRetryAfter, retryDelayMs, type HttpCheckOptions } from '../src/http.js'

function options(fetch: HttpCheckOptions['fetch'], extra: Partial<HttpCheckOptions> = {}): HttpCheckOptions & {
  waits: number[]
} {
  const waits: number[] = []
  return {
    timeoutMs: 1000,
    retries: 2,
    maxRedirects: 5,
    maxRetryWaitMs: 15_000,
    userAgent: 'link-sentry-test',
    headers: {},
    headerHosts: [],
    fetch,
    sleep: async (ms: number) => {
      waits.push(ms)
    },
    random: () => 0,
    now: () => 1_700_000_000_000,
    waits,
    ...extra,
  }
}

describe('retry timing', () => {
  it('honors Retry-After seconds and HTTP dates, and caps the wait', () => {
    const now = 1_700_000_000_000
    expect(parseRetryAfter('2', now)).toBe(2000)
    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000)
    expect(parseRetryAfter('nope', now)).toBeUndefined()
    expect(
      retryDelayMs(0, '120', { maxRetryWaitMs: 15_000, random: () => 0, now: () => now }),
    ).toBe(15_000)
    expect(retryDelayMs(1, null, { maxRetryWaitMs: 15_000, random: () => 0, now: () => now })).toBe(1000)
  })
})

describe('checkUrl', () => {
  it('accepts a HEAD 200 and sends a user agent', async () => {
    const seen: { method: string; userAgent: string | null }[] = []
    const settings = options(async (_url, init) => {
      seen.push({
        method: String(init?.method),
        userAgent: new Headers(init?.headers).get('user-agent'),
      })
      return new Response(null, { status: 200 })
    })
    const result = await checkUrl('https://example.com/docs', settings)
    expect(result.status).toBe('ok')
    expect(result.method).toBe('HEAD')
    expect(result.attempts).toBe(1)
    expect(seen).toEqual([{ method: 'HEAD', userAgent: 'link-sentry-test' }])
    expect(settings.waits).toEqual([])
  })

  it('falls back to GET when HEAD is 405 or 404', async () => {
    const methods: string[] = []
    const settings = options(async (url, init) => {
      methods.push(`${init?.method} ${url}`)
      if (init?.method === 'HEAD') return new Response(null, { status: 405 })
      return new Response('ok', { status: 200 })
    })
    const result = await checkUrl('https://example.com/page', settings)
    expect(result).toMatchObject({ status: 'ok', method: 'GET', httpStatus: 200 })
    expect(methods).toEqual(['HEAD https://example.com/page', 'GET https://example.com/page'])
  })

  it('does not retry a GET 404', async () => {
    let calls = 0
    const settings = options(async (_url, init) => {
      calls += 1
      return new Response(null, { status: init?.method === 'HEAD' ? 404 : 404 })
    })
    const result = await checkUrl('https://example.com/missing', settings)
    expect(result).toMatchObject({ status: 'broken', httpStatus: 404, attempts: 1 })
    expect(calls).toBe(2)
    expect(settings.waits).toEqual([])
  })

  it('retries 503 and then succeeds', async () => {
    let calls = 0
    const settings = options(async () => {
      calls += 1
      if (calls < 3) return new Response(null, { status: 503 })
      return new Response(null, { status: 200 })
    })
    const result = await checkUrl('https://example.com/flaky', settings)
    expect(result.status).toBe('ok')
    expect(calls).toBe(3)
    expect(settings.waits).toEqual([500, 1000])
  })

  it('waits for Retry-After on 429 and reports rate_limited when it persists', async () => {
    const settings = options(async () => new Response(null, { status: 429, headers: { 'retry-after': '3' } }))
    const result = await checkUrl('https://example.com/limited', settings)
    expect(result.status).toBe('rate_limited')
    expect(result.httpStatus).toBe(429)
    expect(result.message).toContain('429')
    expect(result.attempts).toBe(3)
    expect(settings.waits).toEqual([3000, 3000])
  })

  it('treats a 429 that recovers as ok', async () => {
    let calls = 0
    const settings = options(async () => {
      calls += 1
      if (calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } })
      return new Response(null, { status: 200 })
    })
    const result = await checkUrl('https://example.com/limited', settings)
    expect(result.status).toBe('ok')
    expect(settings.waits).toEqual([0])
  })

  it('retries timeouts and reports timeout when they persist', async () => {
    const settings = options(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }, { retries: 1 })
    const result = await checkUrl('https://example.com/slow', settings)
    expect(result.status).toBe('timeout')
    expect(result.attempts).toBe(2)
  })

  it('retries when both HEAD and GET fail to connect', async () => {
    let calls = 0
    const settings = options(async () => {
      calls += 1
      if (calls <= 2) throw new TypeError('fetch failed')
      return new Response(null, { status: 200 })
    })
    const result = await checkUrl('https://example.com/reset', settings)
    expect(result.status).toBe('ok')
    expect(result.attempts).toBe(2)
    expect(settings.waits).toEqual([500])
  })

  it('follows redirects, switches 302 from HEAD to GET, and records the final URL', async () => {
    const methods: string[] = []
    const settings = options(async (url, init) => {
      methods.push(`${init?.method} ${url}`)
      if (url.endsWith('/old')) {
        return new Response(null, { status: 302, headers: { location: '/new' } })
      }
      return new Response(null, { status: 200 })
    })
    const result = await checkUrl('https://example.com/old', settings)
    expect(result.status).toBe('ok')
    expect(result.finalUrl).toBe('https://example.com/new')
    expect(methods).toEqual(['HEAD https://example.com/old', 'GET https://example.com/new'])
  })

  it('stops redirect loops and refuses non-http locations', async () => {
    const loop = options(async (url) => {
      const location = url.endsWith('/a') ? '/b' : '/a'
      return new Response(null, { status: 302, headers: { location } })
    })
    expect((await checkUrl('https://example.com/a', loop)).message).toContain('redirect loop')

    const javascript = options(async () => {
      return new Response(null, { status: 302, headers: { location: 'javascript:alert(1)' } })
    })
    expect((await checkUrl('https://example.com/a', javascript)).message).toContain('unsupported protocol')
  })

  it('strips custom headers when a redirect leaves the original host', async () => {
    const seen: { url: string; authorization: string | null }[] = []
    const settings = options(
      async (url, init) => {
        seen.push({ url, authorization: new Headers(init?.headers).get('authorization') })
        if (url === 'https://docs.example/a') {
          return new Response(null, { status: 302, headers: { location: 'https://other.example/b' } })
        }
        return new Response(null, { status: 200 })
      },
      { headers: { Authorization: 'Bearer secret' } },
    )
    const result = await checkUrl('https://docs.example/a', settings)
    expect(result.status).toBe('ok')
    expect(seen).toEqual([
      { url: 'https://docs.example/a', authorization: 'Bearer secret' },
      { url: 'https://other.example/b', authorization: null },
    ])
  })

  it('sends custom headers only to allowed hosts', async () => {
    const seen: string[] = []
    const settings = options(
      async (url, init) => {
        const header = new Headers(init?.headers).get('authorization')
        if (header) seen.push(new URL(url).hostname)
        return new Response(null, { status: 200 })
      },
      { headers: { Authorization: 'Bearer secret' }, headerHosts: ['github.com', '*.github.com'] },
    )
    await checkUrl('https://example.com/a', settings)
    await checkUrl('https://api.github.com/repos', settings)
    expect(seen).toEqual(['api.github.com'])
  })

  it('redacts userinfo from the final URL', async () => {
    const settings = options(async () => new Response(null, { status: 200 }))
    const result = await checkUrl('https://user:secret@example.com/private', settings)
    expect(result.finalUrl ?? '').not.toContain('secret')
    expect(result.status).toBe('ok')
  })
})
