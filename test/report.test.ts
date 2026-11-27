import { describe, expect, it } from 'vitest'
import { formatGitHubSummary, formatText, summarize } from '../src/report.js'
import type { Report } from '../src/types.js'

function report(partial: Partial<Report> = {}): Report {
  const results = partial.results ?? []
  const errors = partial.errors ?? []
  const { summary, ok } = summarize(results, errors, false)
  return {
    version: 1,
    tool: { name: 'link-sentry', version: '0.1.0' },
    ok,
    files: partial.files ?? ['README.md'],
    durationMs: partial.durationMs ?? 12,
    summary,
    results,
    errors,
  }
}

describe('report', () => {
  it('prints a one-line success report', () => {
    const text = formatText(
      report({
        results: [
          {
            file: 'README.md',
            line: 1,
            column: 1,
            kind: 'link',
            target: 'https://example.com',
            status: 'ok',
            message: '200 OK',
          },
        ],
      }),
      { color: false, verbose: false, allowRateLimit: false },
    )
    expect(text).toBe('link-sentry  1 file · 1 link · 1 ok · 12ms\n')
  })

  it('prints failures with file:line:column and hides successes', () => {
    const text = formatText(
      report({
        files: ['docs/guide.md'],
        results: [
          {
            file: 'docs/guide.md',
            line: 4,
            column: 1,
            kind: 'link',
            target: './missing.md',
            status: 'missing',
            message: 'file not found: docs/missing.md',
          },
          {
            file: 'docs/guide.md',
            line: 8,
            column: 1,
            kind: 'link',
            target: 'https://example.com',
            status: 'ok',
            message: '200 OK',
          },
        ],
      }),
      { color: false, verbose: false, allowRateLimit: false },
    )
    expect(text).toContain('link-sentry found 1 problem')
    expect(text).toContain('docs/guide.md:4:1  missing')
    expect(text).toContain('file not found: docs/missing.md')
    expect(text).not.toContain('https://example.com')
    expect(text).toContain('1 failed · 1 ok')
  })

  it('lists successes in verbose mode without calling them rate limits', () => {
    const text = formatText(
      report({
        results: [
          {
            file: 'README.md',
            line: 1,
            column: 1,
            kind: 'link',
            target: 'https://example.com',
            status: 'ok',
            message: '200 OK',
          },
        ],
      }),
      { color: false, verbose: true, allowRateLimit: false },
    )
    expect(text).toContain('README.md:1:1  ok')
    expect(text).toContain('1 file · 1 link · 1 ok')
    expect(text).not.toContain('rate limit')
  })

  it('writes a GitHub step summary table', () => {
    const summary = formatGitHubSummary(
      report({
        results: [
          {
            file: 'README.md',
            line: 2,
            column: 3,
            kind: 'link',
            target: 'https://example.com/missing',
            status: 'broken',
            message: '404 Not Found',
          },
        ],
      }),
      false,
    )
    expect(summary).toContain('### Link Sentry')
    expect(summary).toContain('| `README.md:2:3` | broken | https://example.com/missing |')
  })
})
