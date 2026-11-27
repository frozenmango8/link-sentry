export type LinkKind = 'link' | 'image'

export type LinkStatus =
  | 'ok'
  | 'broken'
  | 'missing'
  | 'anchor'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'ignored'
  | 'skipped'

export interface LinkResult {
  file: string
  line: number
  column: number
  kind: LinkKind
  target: string
  status: LinkStatus
  message: string
  httpStatus?: number
  method?: 'HEAD' | 'GET'
  attempts?: number
  finalUrl?: string
}

export interface FileError {
  file: string
  message: string
}

export interface Summary {
  total: number
  ok: number
  failed: number
  rateLimited: number
  ignored: number
  skipped: number
}

export interface Report {
  version: 1
  tool: { name: 'link-sentry'; version: string }
  ok: boolean
  files: string[]
  durationMs: number
  summary: Summary
  results: LinkResult[]
  errors: FileError[]
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface CheckOptions {
  patterns?: string[]
  cwd?: string
  root?: string
  concurrency?: number
  timeoutMs?: number
  retries?: number
  maxRedirects?: number
  maxRetryWaitMs?: number
  ignore?: string[]
  exclude?: string[]
  noDefaultExcludes?: boolean
  allowRateLimit?: boolean
  skipExternal?: boolean
  skipAnchors?: boolean
  skipImages?: boolean
  allowEmpty?: boolean
  headers?: Record<string, string>
  headerHosts?: string[]
  userAgent?: string
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export function isHardFailure(status: LinkStatus): boolean {
  return (
    status === 'broken' ||
    status === 'missing' ||
    status === 'anchor' ||
    status === 'timeout' ||
    status === 'network'
  )
}
