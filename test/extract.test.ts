import { describe, expect, it } from 'vitest'
import { extractMarkdown } from '../src/extract.js'

describe('extractMarkdown', () => {
  it('slugs headings the way GitHub does, including duplicates', () => {
    const { anchors } = extractMarkdown('# Hello, World!\n\n# Hello, World!\n\n## `code` in heading\n')
    expect(anchors.headings).toEqual(['hello-world', 'hello-world-1', 'code-in-heading'])
  })

  it('keeps underscores, drops punctuation, and turns spaces into hyphens', () => {
    const { anchors } = extractMarkdown('# foo  bar\n\n# C++\n\n# a_b\n\n# 😄 emoji\n')
    expect(anchors.headings).toEqual(['foo--bar', 'c', 'a_b', '-emoji'])
  })

  it('ignores links inside fenced blocks, inline code, and comments', () => {
    const { links } = extractMarkdown(`
# Title

\`[hidden](./missing.md)\`

\`\`\`md
[hidden](./missing.md)
\`\`\`

<!-- [hidden](./missing.md) <a href="https://example.com/hidden">x</a> -->

[real](./a.md)
`)
    expect(links.map((link) => link.raw)).toEqual(['./a.md'])
  })

  it('resolves reference links and reports unresolved ones', () => {
    const { links } = extractMarkdown(`
[label][id]

[missing][nope]

[id]: https://example.com/ref
`)
    expect(links.map((link) => link.unresolvedLabel ?? link.raw)).toEqual([
      'https://example.com/ref',
      'nope',
    ])
    const prose = extractMarkdown('Use values[0][1] in the matrix.\n')
    expect(prose.links).toEqual([])
  })

  it('extracts autolinks, images, and html hrefs', () => {
    const { links, anchors } = extractMarkdown(`
https://example.com/auto

<https://example.com/angle>

![alt](./pic.png)

<a href="https://example.com/html">x</a>
<a id="custom-id"></a>
`)
    expect(links.map((link) => `${link.kind}:${link.raw}`)).toEqual([
      'link:https://example.com/auto',
      'link:https://example.com/angle',
      'image:./pic.png',
      'link:https://example.com/html',
    ])
    expect(anchors.ids.has('custom-id')).toBe(true)
  })

  it('records a link inside a heading and the heading slug', () => {
    const extracted = extractMarkdown('# [Intro](./intro.md)\n')
    expect(extracted.anchors.headings).toEqual(['intro'])
    expect(extracted.links.map((link) => link.raw)).toEqual(['./intro.md'])
  })

  it('slugs html headings and keeps footnote anchors', () => {
    const { anchors } = extractMarkdown(`
<h2 id="custom">HTML title</h2>

A note[^1].

[^1]: The footnote.
`)
    expect(anchors.ids.has('custom')).toBe(true)
    expect(anchors.ids.has('html-title')).toBe(true)
    expect(anchors.ids.has('user-content-fn-1')).toBe(true)
  })

  it('preserves line numbers', () => {
    const { links } = extractMarkdown('# T\n\n[docs](./a.md)\n')
    expect(links[0]).toMatchObject({ line: 3, column: 1, raw: './a.md' })
  })
})
