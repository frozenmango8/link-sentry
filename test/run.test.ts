import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLinks } from '../src/run.js'
import { tempRepo } from './helpers.js'

describe('checkLinks', () => {
  it('checks files, anchors, and external URLs, and dedupes requests', async () => {
    const repo = await tempRepo()
    try {
      await repo.write(
        'docs/guide.md',
        `# Guide

See the [guide](#guide) and the [other](./other.md#other).

Missing [page](./nope.md) and a bad [anchor](#missing-heading).

[site](https://example.com/docs)
[site again](https://example.com/docs)
[mail](mailto:dev@example.com)
[plain](./other.md?plain=1)
[spaced](./my%20file.md)
`,
      )
      await repo.write('docs/other.md', '# Other\n')
      await repo.write('docs/my file.md', '# Spaced\n')
      const calls: string[] = []
      const report = await checkLinks({
        cwd: repo.dir,
        patterns: ['docs/**/*.md'],
        fetch: async (url) => {
          calls.push(url)
          return new Response(null, { status: url.includes('example.com') ? 200 : 404 })
        },
        sleep: async () => undefined,
        random: () => 0,
      })
      expect(report.files).toEqual(['docs/guide.md', 'docs/my file.md', 'docs/other.md'])
      expect(report.ok).toBe(false)
      const byTarget = Object.fromEntries(report.results.map((result) => [result.target, result.status]))
      expect(byTarget['#guide']).toBe('ok')
      expect(byTarget['./other.md#other']).toBe('ok')
      expect(byTarget['./nope.md']).toBe('missing')
      expect(byTarget['#missing-heading']).toBe('anchor')
      expect(byTarget['https://example.com/docs']).toBe('ok')
      expect(byTarget['mailto:dev@example.com']).toBe('skipped')
      expect(byTarget['./other.md?plain=1']).toBe('ok')
      expect(byTarget['./my%20file.md']).toBe('ok')
      expect(calls.filter((url) => url.startsWith('https://example.com/docs'))).toHaveLength(1)
      expect(report.summary.failed).toBe(2)
    } finally {
      await repo.cleanup()
    }
  })

  it('suggests a close heading and resolves root links and directories', async () => {
    const repo = await tempRepo()
    try {
      await repo.write('README.md', '# Welcome\n\n[typo](#welcom)\n\n[root](/docs/guide.md)\n\n[dir](./docs#guide)\n')
      await repo.write('docs/guide.md', '# Guide\n')
      await repo.write('docs/README.md', '# Guide\n')
      const report = await checkLinks({
        cwd: repo.dir,
        patterns: ['README.md'],
        skipExternal: true,
      })
      const typo = report.results.find((result) => result.target === '#welcom')
      expect(typo?.status).toBe('anchor')
      expect(typo?.message).toContain('did you mean "welcome"')
      expect(report.results.find((result) => result.target === '/docs/guide.md')?.status).toBe('ok')
      expect(report.results.find((result) => result.target === './docs#guide')?.status).toBe('ok')
      expect(report.ok).toBe(false)
    } finally {
      await repo.cleanup()
    }
  })

  it('ignores matching URLs and allows a persistent 429 when asked', async () => {
    const repo = await tempRepo()
    try {
      await repo.write(
        'README.md',
        '[skip](https://example.com/secret)\n\n[limited](https://example.com/limited)\n',
      )
      const report = await checkLinks({
        cwd: repo.dir,
        patterns: ['README.md'],
        ignore: ['example\\.com/secret'],
        allowRateLimit: true,
        retries: 0,
        fetch: async () => new Response(null, { status: 429 }),
        sleep: async () => undefined,
      })
      expect(report.results.map((result) => result.status)).toEqual(['ignored', 'rate_limited'])
      expect(report.ok).toBe(true)
    } finally {
      await repo.cleanup()
    }
  })

  it('fails the report when 429 is not allowed', async () => {
    const repo = await tempRepo()
    try {
      await repo.write('README.md', '[limited](https://example.com/limited)\n')
      const report = await checkLinks({
        cwd: repo.dir,
        patterns: ['README.md'],
        retries: 0,
        fetch: async () => new Response(null, { status: 429 }),
        sleep: async () => undefined,
      })
      expect(report.ok).toBe(false)
      expect(report.summary.rateLimited).toBe(1)
      expect(report.summary.failed).toBe(0)
    } finally {
      await repo.cleanup()
    }
  })

  it('does not scan node_modules unless asked', async () => {
    const repo = await tempRepo()
    try {
      await repo.write('README.md', '# Home\n')
      await repo.write('node_modules/pkg/README.md', '[missing](./nope.md)\n')
      const report = await checkLinks({ cwd: repo.dir, skipExternal: true })
      expect(report.files).toEqual(['README.md'])
      expect(report.ok).toBe(true)
    } finally {
      await repo.cleanup()
    }
  })

  it('throws a usage error when nothing matches', async () => {
    const repo = await tempRepo()
    try {
      await expect(checkLinks({ cwd: repo.dir, patterns: ['docs/**/*.md'] })).rejects.toThrow(/No Markdown files/)
      const report = await checkLinks({ cwd: repo.dir, patterns: ['docs/**/*.md'], allowEmpty: true })
      expect(report.ok).toBe(true)
      expect(report.files).toEqual([])
    } finally {
      await repo.cleanup()
    }
  })

  it('checks an anchor in an html file', async () => {
    const repo = await tempRepo()
    try {
      await repo.write('README.md', '[page](./page.html#install)\n[bad](./page.html#nope)\n')
      await repo.write('page.html', '<h2 id="install">Install</h2>\n')
      const report = await checkLinks({ cwd: repo.dir, patterns: ['README.md'], skipExternal: true })
      expect(report.results.map((result) => result.status)).toEqual(['ok', 'anchor'])
      expect(path.basename(repo.dir)).toBeTruthy()
    } finally {
      await repo.cleanup()
    }
  })
})
