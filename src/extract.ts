import GithubSlugger from 'github-slugger'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { toString } from 'mdast-util-to-string'
import { gfm } from 'micromark-extension-gfm'
import { visit } from 'unist-util-visit'
import type {
  Definition,
  FootnoteDefinition,
  Heading,
  Html,
  Image,
  ImageReference,
  Link,
  LinkReference,
  Text,
} from 'mdast'
import {
  addAnchor,
  createAnchorIndex,
  htmlAttributeValues,
  stripTags,
  type AnchorIndex,
} from './anchors.js'
import type { LinkKind } from './types.js'

export interface ExtractedLink {
  line: number
  column: number
  kind: LinkKind
  raw: string
  text: string
  unresolvedLabel?: string
}

export interface ExtractedDocument {
  links: ExtractedLink[]
  anchors: AnchorIndex
}

export function extractMarkdown(markdown: string): ExtractedDocument {
  const source = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: gfmFromMarkdown(),
  })

  const definitions = new Map<string, string>()
  visit(tree, 'definition', (node: Definition) => {
    definitions.set(node.identifier, node.url)
  })

  const anchors = createAnchorIndex()
  const links: ExtractedLink[] = []
  const slugger = new GithubSlugger()

  visit(tree, (node) => {
    switch (node.type) {
      case 'heading':
        recordHeading(node as Heading, slugger, anchors)
        break
      case 'footnoteDefinition':
        recordFootnote(node as FootnoteDefinition, anchors)
        break
      case 'html':
        recordHtml(node as Html, slugger, anchors, links)
        break
      case 'link':
        links.push(linkFrom(node as Link, 'link', (node as Link).url, toString(node)))
        break
      case 'image':
        links.push(linkFrom(node as Image, 'image', (node as Image).url, (node as Image).alt ?? ''))
        break
      case 'linkReference':
        links.push(referenceLink(node as LinkReference, 'link', definitions, toString(node)))
        break
      case 'imageReference': {
        const image = node as ImageReference
        links.push(referenceLink(image, 'image', definitions, image.alt ?? toString(image)))
        break
      }
      case 'text':
        // A full reference with no definition is left as literal text by CommonMark.
        // It was still written as a link, so report it.
        links.push(...unresolvedInText(node as Text))
        break
      default:
        break
    }
  })

  return { links, anchors }
}

function recordHeading(node: Heading, slugger: GithubSlugger, anchors: AnchorIndex): void {
  const value = slugger.slug(toString(node))
  if (value) addAnchor(anchors, value, true)
}

function recordFootnote(node: FootnoteDefinition, anchors: AnchorIndex): void {
  const id = node.identifier.trim()
  if (!id) return
  addAnchor(anchors, `fn-${id}`, false)
  addAnchor(anchors, `user-content-fn-${id}`, false)
  addAnchor(anchors, `fnref-${id}`, false)
  addAnchor(anchors, `user-content-fnref-${id}`, false)
}

function recordHtml(
  node: Html,
  slugger: GithubSlugger,
  anchors: AnchorIndex,
  links: ExtractedLink[],
): void {
  const value = node.value
  const trimmed = value.trimStart()
  if (trimmed.startsWith('<!--')) return
  if (/^<(script|style)\b/i.test(trimmed)) return

  for (const id of htmlAttributeValues(value, 'id|name')) addAnchor(anchors, id, false)

  const heading = /^<h([1-6])\b[^>]*>([\s\S]*)<\/h\1>\s*$/i.exec(trimmed)
  if (heading) {
    const text = stripTags(heading[2] ?? '')
    if (text) {
      const valueSlug = slugger.slug(text)
      if (valueSlug) addAnchor(anchors, valueSlug, true)
    }
  }

  const startLine = node.position?.start.line ?? 1
  const startColumn = node.position?.start.column ?? 1
  const attributes = /\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
  for (const match of value.matchAll(attributes)) {
    const raw = match[2] ?? match[3] ?? match[4] ?? ''
    if (!raw || /[\s<>]/.test(raw)) continue
    const index = match.index ?? 0
    const prior = value.slice(0, index)
    const parts = prior.split('\n')
    const extra = parts.length - 1
    const last = parts[extra] ?? ''
    links.push({
      line: startLine + extra,
      column: extra === 0 ? startColumn + last.length : last.length + 1,
      kind: (match[1] ?? '').toLowerCase() === 'src' ? 'image' : 'link',
      raw,
      text: raw,
    })
  }
}

function referenceLink(
  node: LinkReference | ImageReference,
  kind: LinkKind,
  definitions: ReadonlyMap<string, string>,
  text: string,
): ExtractedLink {
  const url = definitions.get(node.identifier)
  const position = locationOf(node)
  if (!url) {
    const label = node.label ?? node.identifier
    return { ...position, kind, raw: label, text, unresolvedLabel: label }
  }
  return { ...position, kind, raw: url, text }
}

function unresolvedInText(node: Text): ExtractedLink[] {
  const value = node.value
  const found: ExtractedLink[] = []
  const expression = /\[([^\]\n]+)\]\[([^\]\n]*)\]/g
  for (const match of value.matchAll(expression)) {
    const index = match.index ?? 0
    const previous = index > 0 ? value[index - 1] : ''
    if (previous === '\\' || (previous !== undefined && /[\p{L}\p{N}_]/u.test(previous))) continue
    const label = (match[2] || match[1] || '').trim()
    if (!label) continue
    found.push({
      ...offsetPosition(node, value, index),
      kind: 'link',
      raw: label,
      text: (match[1] ?? label).trim(),
      unresolvedLabel: label,
    })
  }
  return found
}

function offsetPosition(
  node: { position?: { start: { line: number; column: number } } | undefined },
  value: string,
  index: number,
): { line: number; column: number } {
  const start = locationOf(node)
  const prior = value.slice(0, index)
  const parts = prior.split('\n')
  const extra = parts.length - 1
  const last = parts[extra] ?? ''
  return {
    line: start.line + extra,
    column: extra === 0 ? start.column + last.length : last.length + 1,
  }
}

function linkFrom(
  node: Link | Image,
  kind: LinkKind,
  raw: string,
  text: string,
): ExtractedLink {
  return { ...locationOf(node), kind, raw, text }
}

function locationOf(node: { position?: { start: { line: number; column: number } } | undefined }): {
  line: number
  column: number
} {
  return {
    line: node.position?.start.line ?? 1,
    column: node.position?.start.column ?? 1,
  }
}
