import path from 'node:path'

const SKIPPED_SCHEMES = new Set([
  'mailto',
  'tel',
  'sms',
  'javascript',
  'data',
  'blob',
  'about',
  'chrome',
  'edge',
  'vscode',
  'file',
])

export type ClassifiedTarget =
  | { kind: 'external'; href: string; dedupeKey: string }
  | { kind: 'local'; path: string; fragment: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'invalid'; message: string }

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function redactUrl(href: string): string {
  try {
    const url = new URL(href)
    if (url.username || url.password) {
      url.username = ''
      url.password = ''
    }
    return url.href
  } catch {
    return href
  }
}

export function displayTarget(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      const absolute = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
      return redactUrl(absolute)
    } catch {
      return trimmed
    }
  }
  return trimmed
}

export function classifyTarget(raw: string): ClassifiedTarget {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'invalid', message: 'empty link' }

  if (trimmed.startsWith('#')) {
    return { kind: 'local', path: '', fragment: trimmed.slice(1) }
  }

  if (trimmed.startsWith('//')) return external(`https:${trimmed}`)

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)
  const schemeName = scheme?.[1]
  if (schemeName && schemeName.length > 1) {
    const name = schemeName.toLowerCase()
    if (name === 'http' || name === 'https') return external(trimmed)
    if (SKIPPED_SCHEMES.has(name)) return { kind: 'skip', reason: `${name} links are not checked` }
    return { kind: 'skip', reason: `${name} links are not checked` }
  }

  return { kind: 'local', ...splitLocal(trimmed) }
}

export function resolveLocalPath(fromFile: string, urlPath: string, root: string): string {
  if (urlPath === '') return fromFile
  const decoded = safeDecode(urlPath)
  if (decoded.startsWith('/')) {
    return path.resolve(root, decoded.replace(/^\/+/, ''))
  }
  return path.resolve(path.dirname(fromFile), decoded)
}

export function relativePosix(from: string, to: string): string {
  const relative = path.relative(from, to)
  if (!relative) return ''
  return relative.split(path.sep).join('/')
}

function external(input: string): ClassifiedTarget {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { kind: 'invalid', message: `invalid URL ${input}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const name = url.protocol.replace(':', '')
    return { kind: 'skip', reason: `${name} links are not checked` }
  }
  url.hash = ''
  const href = url.href
  return { kind: 'external', href, dedupeKey: href }
}

function splitLocal(input: string): { path: string; fragment: string } {
  const hash = input.indexOf('#')
  const before = hash >= 0 ? input.slice(0, hash) : input
  const fragment = hash >= 0 ? input.slice(hash + 1) : ''
  const query = before.indexOf('?')
  const urlPath = query >= 0 ? before.slice(0, query) : before
  return { path: urlPath, fragment }
}
