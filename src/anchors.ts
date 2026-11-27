import { slug } from 'github-slugger'
import { safeDecode } from './target.js'

export interface AnchorIndex {
  ids: Set<string>
  headings: string[]
}

export function createAnchorIndex(): AnchorIndex {
  return { ids: new Set(), headings: [] }
}

export function addAnchor(index: AnchorIndex, id: string, asHeading: boolean): void {
  const trimmed = id.trim()
  if (!trimmed) return
  const lower = trimmed.toLowerCase()
  index.ids.add(lower)
  if (!lower.startsWith('user-content-')) index.ids.add(`user-content-${lower}`)
  if (asHeading) index.headings.push(trimmed)
}

export function fragmentMatches(fragment: string, index: AnchorIndex): boolean {
  if (fragment.trim() === '') return true
  for (const candidate of fragmentCandidates(fragment)) {
    if (index.ids.has(candidate)) return true
  }
  return false
}

export function suggestAnchor(fragment: string, headings: readonly string[]): string | undefined {
  const decoded = safeDecode(fragment).trim().toLowerCase().replace(/^user-content-/, '')
  if (decoded.length < 3) return undefined
  const maxDistance = decoded.length <= 4 ? 1 : 2
  let best: { heading: string; distance: number } | undefined
  for (const heading of headings) {
    if (heading.length > 100) continue
    const distance = levenshtein(decoded, heading.toLowerCase())
    if (distance === 0 || distance > maxDistance) continue
    if (!best || distance < best.distance) best = { heading, distance }
  }
  return best?.heading
}

export function anchorsFromHtmlDocument(html: string): AnchorIndex {
  const index = createAnchorIndex()
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  for (const id of htmlAttributeValues(cleaned, 'id|name')) addAnchor(index, id, false)

  const headings = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi
  for (const match of cleaned.matchAll(headings)) {
    const attrs = match[2] ?? ''
    const text = stripTags(match[3] ?? '')
    const explicit = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    const explicitId = explicit?.[1] ?? explicit?.[2]
    if (explicitId) addAnchor(index, explicitId, true)
    if (text) {
      const value = slug(text)
      if (value) addAnchor(index, value, !explicitId)
    }
  }
  return index
}

export function htmlAttributeValues(source: string, names: string): string[] {
  const expression = new RegExp(
    `\\b(?:${names})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
    'gi',
  )
  const values: string[] = []
  for (const match of source.matchAll(expression)) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value) values.push(value)
  }
  return values
}

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function fragmentCandidates(fragment: string): string[] {
  const decoded = safeDecode(fragment).trim()
  const values = new Set<string>()
  const add = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    values.add(trimmed.toLowerCase())
    values.add(trimmed.toLowerCase().replace(/^user-content-/, ''))
  }
  add(decoded)
  add(slug(decoded))
  return [...values]
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i]
    const left = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const insert = (current[j - 1] ?? 0) + 1
      const remove = (previous[j] ?? 0) + 1
      const replace = (previous[j - 1] ?? 0) + (left === b.charCodeAt(j - 1) ? 0 : 1)
      current[j] = Math.min(insert, remove, replace)
    }
    previous = current
  }
  return previous[b.length] ?? 0
}
