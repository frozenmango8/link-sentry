import { describe, expect, it } from 'vitest'
import { addAnchor, createAnchorIndex, fragmentMatches, suggestAnchor } from '../src/anchors.js'

describe('anchors', () => {
  it('matches GitHub slugs, user-content prefixes, and heading text', () => {
    const index = createAnchorIndex()
    addAnchor(index, 'hello-world', true)
    expect(fragmentMatches('hello-world', index)).toBe(true)
    expect(fragmentMatches('Hello-World', index)).toBe(true)
    expect(fragmentMatches('user-content-hello-world', index)).toBe(true)
    expect(fragmentMatches('Hello World', index)).toBe(true)
    expect(fragmentMatches('', index)).toBe(true)
    expect(fragmentMatches('missing', index)).toBe(false)
  })

  it('suggests a nearby heading', () => {
    expect(suggestAnchor('hell-world', ['hello-world', 'other'])).toBe('hello-world')
    expect(suggestAnchor('nope', ['hello-world'])).toBeUndefined()
  })
})
