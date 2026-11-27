import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { checkUrl, type HttpCheckOptions } from '../src/http.js'

let server: Server | undefined

afterEach(async () => {
  if (!server) return
  const current = server
  server = undefined
  await new Promise<void>((resolve) => {
    current.closeAllConnections?.()
    current.close(() => resolve())
  })
})

async function listen(
  handler: (url: string, method: string, hits: number) => { status: number; headers?: Record<string, string>; body?: string } | 'stall',
): Promise<string> {
  const hits = new Map<string, number>()
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    const count = (hits.get(url) ?? 0) + 1
    hits.set(url, count)
    const result = handler(url, request.method ?? 'GET', count)
    if (result === 'stall') return
    response.writeHead(result.status, result.headers)
    response.end(result.body ?? '')
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function liveOptions(extra: Partial<HttpCheckOptions> = {}): HttpCheckOptions {
  return {
    timeoutMs: 1000,
    retries: 2,
    maxRedirects: 5,
    maxRetryWaitMs: 15_000,
    userAgent: 'link-sentry-test',
    headers: {},
    headerHosts: [],
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: () => 0,
    now: () => Date.now(),
    ...extra,
  }
}

describe('checkUrl against a local server', () => {
  it('uses GET when HEAD is not allowed and follows a redirect', async () => {
    const base = await listen((url, method) => {
      if (url === '/head-no' && method === 'HEAD') return { status: 405 }
      if (url === '/head-no') return { status: 200, body: 'ok' }
      if (url === '/go') return { status: 302, headers: { location: '/landed' } }
      if (url === '/missing') return { status: 404 }
      return { status: 200, body: 'landed' }
    })
    const settings = liveOptions()
    expect(await checkUrl(`${base}/head-no`, settings)).toMatchObject({ status: 'ok', method: 'GET' })
    expect(await checkUrl(`${base}/go`, settings)).toMatchObject({
      status: 'ok',
      finalUrl: `${base}/landed`,
    })
    expect(await checkUrl(`${base}/missing`, settings)).toMatchObject({ status: 'broken', httpStatus: 404 })
  })

  it('recovers from 429 when Retry-After is zero', async () => {
    const base = await listen((_url, _method, hits) => {
      if (hits < 3) return { status: 429, headers: { 'retry-after': '0' } }
      return { status: 200, body: 'ok' }
    })
    const result = await checkUrl(`${base}/rate`, liveOptions())
    expect(result.status).toBe('ok')
    expect(result.attempts).toBe(3)
  })

  it('reports a timeout when the server never answers', async () => {
    const base = await listen(() => 'stall')
    const result = await checkUrl(`${base}/stall`, liveOptions({ timeoutMs: 150, retries: 0 }))
    expect(result.status).toBe('timeout')
  })
})
