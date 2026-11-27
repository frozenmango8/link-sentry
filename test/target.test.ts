import { describe, expect, it } from 'vitest'
import { classifyTarget, displayTarget, resolveLocalPath } from '../src/target.js'
import path from 'node:path'

describe('classifyTarget', () => {
  it('treats http(s) and protocol-relative URLs as external', () => {
    expect(classifyTarget('https://example.com/a#b')).toMatchObject({
      kind: 'external',
      href: 'https://example.com/a',
      dedupeKey: 'https://example.com/a',
    })
    expect(classifyTarget('//cdn.example/a.png')).toMatchObject({
      kind: 'external',
      href: 'https://cdn.example/a.png',
    })
  })

  it('skips non-http schemes and keeps single-letter drives local', () => {
    expect(classifyTarget('mailto:dev@example.com')).toMatchObject({ kind: 'skip' })
    expect(classifyTarget('javascript:alert(1)')).toMatchObject({ kind: 'skip' })
    expect(classifyTarget('C:/docs/a.md')).toEqual({ kind: 'local', path: 'C:/docs/a.md', fragment: '' })
  })

  it('splits local paths, queries, and fragments', () => {
    expect(classifyTarget('./Guide.md?plain=1#Section')).toEqual({
      kind: 'local',
      path: './Guide.md',
      fragment: 'Section',
    })
    expect(classifyTarget('#hello-world')).toEqual({ kind: 'local', path: '', fragment: 'hello-world' })
  })

  it('rejects empty and malformed urls', () => {
    expect(classifyTarget('   ')).toMatchObject({ kind: 'invalid' })
    expect(classifyTarget('http://')).toMatchObject({ kind: 'invalid' })
  })

  it('redacts userinfo in the displayed target', () => {
    expect(displayTarget('https://user:secret@example.com/a')).toBe('https://example.com/a')
  })

  it('resolves root-absolute paths from the project root', () => {
    const from = path.join('/repo/docs', 'guide.md')
    expect(resolveLocalPath(from, '/docs/other.md', '/repo')).toBe(path.join('/repo/docs', 'other.md'))
    expect(resolveLocalPath(from, './other.md', '/repo')).toBe(path.join('/repo/docs', 'other.md'))
    expect(resolveLocalPath(from, './my%20file.md', '/repo')).toBe(path.join('/repo/docs', 'my file.md'))
    expect(resolveLocalPath(from, '', '/repo')).toBe(from)
  })
})
