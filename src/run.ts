import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { glob } from 'tinyglobby'
import { fragmentMatches, suggestAnchor, anchorsFromHtmlDocument, type AnchorIndex } from './anchors.js'
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_EXCLUDES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RETRY_WAIT_MS,
  DEFAULT_PATTERNS,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  DOC_EXTENSIONS,
  MAX_FILE_BYTES,
  README_NAMES,
} from './constants.js'
import { extractMarkdown } from './extract.js'
import { checkUrl, errorMessage, type HttpCheckResult } from './http.js'
import { compileIgnore, isIgnored } from './ignore.js'
import { mapPool } from './pool.js'
import { summarize } from './report.js'
import {
  classifyTarget,
  displayTarget,
  redactUrl,
  relativePosix,
  resolveLocalPath,
  safeDecode,
} from './target.js'
import type { CheckOptions, FetchLike, FileError, LinkResult, Report } from './types.js'
import { UsageError } from './types.js'
import { defaultUserAgent, packageVersion } from './version.js'

interface SourceFile {
  absolute: string
  relative: string
  anchors: AnchorIndex
  links: ReturnType<typeof extractMarkdown>['links']
}

type DocLoad = AnchorIndex | 'missing' | 'not-doc' | 'error'

export async function checkLinks(input: CheckOptions = {}): Promise<Report> {
  const started = performance.now()
  const cwd = path.resolve(input.cwd ?? process.cwd())
  const root = path.resolve(cwd, input.root ?? '.')
  const patterns = input.patterns && input.patterns.length > 0 ? input.patterns : DEFAULT_PATTERNS
  const allowRateLimit = input.allowRateLimit ?? false
  const skipExternal = input.skipExternal ?? false
  const skipAnchors = input.skipAnchors ?? false
  const skipImages = input.skipImages ?? false
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = input.retries ?? DEFAULT_RETRIES
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const maxRetryWaitMs = input.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS
  assertInteger('concurrency', concurrency, 1)
  assertInteger('timeout', timeoutMs, 1)
  assertInteger('retries', retries, 0)
  assertInteger('maxRedirects', maxRedirects, 0)
  assertInteger('maxRetryWait', maxRetryWaitMs, 0)

  const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis)
  if (typeof fetchImpl !== 'function') {
    throw new UsageError('global fetch is not available; use Node.js 20 or newer')
  }
  const headers = input.headers ?? {}
  validateHeaders(headers)
  const userAgent = input.userAgent?.trim() || defaultUserAgent()
  if (/[\r\n]/.test(userAgent)) throw new UsageError('user agent must be a single line')

  const exclude = [
    ...(input.noDefaultExcludes ? [] : DEFAULT_EXCLUDES),
    ...(input.exclude ?? []),
  ]
  const matchers = compileIgnore(input.ignore ?? [])
  const files = await expand(patterns, cwd, exclude)
  if (files.length === 0 && !input.allowEmpty) {
    throw new UsageError(
      `No Markdown files matched ${patterns.map((pattern) => JSON.stringify(pattern)).join(', ')}. Pass --allow-empty if that is expected.`,
    )
  }

  const errors: FileError[] = []
  const sources = new Map<string, SourceFile>()
  const relativeFiles: string[] = []

  for (const file of files) {
    const relative = relativePosix(cwd, file) || path.basename(file)
    relativeFiles.push(relative)
    try {
      const info = await stat(file)
      if (info.size > MAX_FILE_BYTES) {
        errors.push({ file: relative, message: `file is larger than ${MAX_FILE_BYTES} bytes` })
        continue
      }
      const text = await readFile(file, 'utf8')
      const extracted = extractMarkdown(text)
      sources.set(file, { absolute: file, relative, anchors: extracted.anchors, links: extracted.links })
    } catch (error) {
      errors.push({ file: relative, message: `could not read or parse: ${errorMessage(error)}` })
    }
  }

  const docCache = new Map<string, Promise<DocLoad>>()
  const loadDoc = (absolute: string): Promise<DocLoad> => {
    const key = path.resolve(absolute)
    const cached = docCache.get(key)
    if (cached) return cached
    const pending = readDoc(key, sources)
    docCache.set(key, pending)
    return pending
  }

  const results: LinkResult[] = []
  const jobs: { index: number; href: string; key: string }[] = []

  for (const source of sources.values()) {
    for (const link of source.links) {
      if (skipImages && link.kind === 'image') continue
      const base = {
        file: source.relative,
        line: link.line,
        column: link.column,
        kind: link.kind,
        target: link.unresolvedLabel ? `[${link.unresolvedLabel}]` : displayTarget(link.raw),
      }
      if (link.unresolvedLabel) {
        results.push({
          ...base,
          status: 'broken',
          message: `unresolved reference [${link.unresolvedLabel}]`,
        })
        continue
      }
      if (isIgnored(link.raw, matchers)) {
        results.push({ ...base, status: 'ignored', message: 'matched an ignore pattern' })
        continue
      }

      const classified = classifyTarget(link.raw)
      if (classified.kind === 'invalid') {
        results.push({ ...base, status: 'broken', message: classified.message })
        continue
      }
      if (classified.kind === 'skip') {
        results.push({ ...base, status: 'skipped', message: classified.reason })
        continue
      }
      if (classified.kind === 'external') {
        if (isIgnored(classified.href, matchers) || isIgnored(classified.dedupeKey, matchers)) {
          results.push({ ...base, status: 'ignored', message: 'matched an ignore pattern' })
          continue
        }
        if (skipExternal) {
          results.push({ ...base, status: 'skipped', message: 'external checks disabled' })
          continue
        }
        const index = results.length
        results.push({ ...base, status: 'ok', message: '' })
        jobs.push({ index, href: classified.href, key: classified.dedupeKey })
        continue
      }

      const local = await checkLocal({
        fromFile: source.absolute,
        urlPath: classified.path,
        fragment: classified.fragment,
        root,
        cwd,
        skipAnchors,
        loadDoc,
      })
      results.push({ ...base, status: local.status, message: local.message })
    }
  }

  const unique = new Map<string, string>()
  for (const job of jobs) unique.set(job.key, job.href)
  const checked = new Map<string, HttpCheckResult>()
  await mapPool([...unique.entries()], concurrency, async ([key, href]) => {
    const outcome = await checkUrl(href, {
      timeoutMs,
      retries,
      maxRedirects,
      maxRetryWaitMs,
      userAgent,
      headers,
      headerHosts: input.headerHosts ?? [],
      fetch: fetchImpl as FetchLike,
      sleep: input.sleep ?? delay,
      random: input.random ?? Math.random,
      now: input.now ?? Date.now,
    }).catch((error: unknown) => ({
      status: 'network' as const,
      message: errorMessage(error),
      attempts: 1,
    }))
    checked.set(key, outcome)
  })

  for (const job of jobs) {
    const outcome = checked.get(job.key)
    const current = results[job.index]
    if (!outcome || !current) continue
    const finalUrl = distinctFinal(outcome.finalUrl, current.target)
    results[job.index] = {
      ...current,
      status: outcome.status,
      message: outcome.message,
      httpStatus: outcome.httpStatus,
      method: outcome.method,
      attempts: outcome.attempts,
      finalUrl,
    }
  }

  const { summary, ok } = summarize(results, errors, allowRateLimit)
  return {
    version: 1,
    tool: { name: 'link-sentry', version: packageVersion() },
    ok,
    files: relativeFiles,
    durationMs: Math.round(performance.now() - started),
    summary,
    results,
    errors,
  }
}

async function expand(patterns: string[], cwd: string, ignore: string[]): Promise<string[]> {
  let matches: string[]
  try {
    matches = await glob(patterns, {
      cwd,
      absolute: true,
      ignore,
      onlyFiles: true,
      dot: false,
      expandDirectories: false,
    })
  } catch (error) {
    throw new UsageError(`Could not expand patterns: ${errorMessage(error)}`)
  }
  return [...new Set(matches.map((file) => path.resolve(file)))].sort()
}

async function readDoc(file: string, sources: Map<string, SourceFile>): Promise<DocLoad> {
  const resolved = await realpath(file).catch(() => file)
  const known = sources.get(file) ?? sources.get(resolved)
  if (known) return known.anchors
  let info
  try {
    info = await stat(resolved)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return 'missing'
    return 'error'
  }
  if (!info.isFile()) return 'not-doc'
  if (!DOC_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return 'not-doc'
  try {
    const text = await readFile(resolved, 'utf8')
    if (isHtml(resolved)) return anchorsFromHtmlDocument(text)
    return extractMarkdown(text).anchors
  } catch {
    return 'error'
  }
}

async function checkLocal(options: {
  fromFile: string
  urlPath: string
  fragment: string
  root: string
  cwd: string
  skipAnchors: boolean
  loadDoc: (file: string) => Promise<DocLoad>
}): Promise<Pick<LinkResult, 'status' | 'message'>> {
  const target = resolveLocalPath(options.fromFile, options.urlPath, options.root)
  let info
  try {
    info = await stat(target)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return { status: 'missing', message: `file not found: ${show(options.cwd, target)}` }
    return { status: 'broken', message: `cannot read ${show(options.cwd, target)} (${code || 'error'})` }
  }

  let docPath = target
  if (info.isDirectory()) {
    if (options.fragment === '' || options.skipAnchors) {
      return { status: 'ok', message: `directory ${show(options.cwd, target)}` }
    }
    const readme = await findReadme(target)
    if (!readme) {
      return {
        status: 'anchor',
        message: `no README in ${show(options.cwd, target)} to resolve #${safeDecode(options.fragment)}`,
      }
    }
    docPath = readme
  } else if (options.fragment === '' || options.skipAnchors || !isDoc(docPath)) {
    return { status: 'ok', message: 'ok' }
  }

  const loaded = await options.loadDoc(docPath)
  if (loaded === 'missing') return { status: 'missing', message: `file not found: ${show(options.cwd, docPath)}` }
  if (loaded === 'error') return { status: 'broken', message: `could not parse ${show(options.cwd, docPath)}` }
  if (loaded === 'not-doc') return { status: 'ok', message: 'ok' }
  if (fragmentMatches(options.fragment, loaded)) return { status: 'ok', message: 'ok' }

  const decoded = safeDecode(options.fragment)
  const suggestion = suggestAnchor(decoded, loaded.headings)
  const hint = suggestion ? ` (did you mean "${suggestion}"?)` : ''
  return {
    status: 'anchor',
    message: `no heading or anchor "${decoded}" in ${show(options.cwd, docPath)}${hint}`,
  }
}

async function findReadme(directory: string): Promise<string | undefined> {
  for (const name of README_NAMES) {
    const candidate = path.join(directory, name)
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // try the next conventional readme name
    }
  }
  return undefined
}

function isDoc(file: string): boolean {
  return DOC_EXTENSIONS.has(path.extname(file).toLowerCase())
}

function isHtml(file: string): boolean {
  const ext = path.extname(file).toLowerCase()
  return ext === '.html' || ext === '.htm'
}

function show(cwd: string, file: string): string {
  const relative = relativePosix(cwd, file)
  if (!relative || relative.startsWith('../')) return file
  return relative
}

function distinctFinal(finalUrl: string | undefined, target: string): string | undefined {
  if (!finalUrl) return undefined
  const redacted = redactUrl(finalUrl)
  try {
    const final = new URL(redacted)
    const original = new URL(target)
    final.hash = ''
    original.hash = ''
    if (final.href === original.href) return undefined
  } catch {
    if (redacted === target) return undefined
  }
  return redacted
}

function assertInteger(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new UsageError(`${name} must be an integer >= ${minimum}`)
  }
}

function validateHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new UsageError(`Invalid header name "${name}"`)
    if (/[\r\n]/.test(value)) throw new UsageError(`Header "${name}" contains a newline`)
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code)
  return ''
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
