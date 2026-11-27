import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { capture, tempRepo } from './helpers.js'

describe('cli', () => {
  it('prints help and version', async () => {
    const help = capture()
    expect(await main(['--help'], help)).toBe(0)
    expect(help.out()).toContain('link-sentry')
    expect(help.out()).toContain('--allow-rate-limit')

    const version = capture()
    expect(await main(['--version'], version)).toBe(0)
    expect(version.out().trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('exits 2 on a bad flag, a bad ignore pattern, and no matching files', async () => {
    const badFlag = capture()
    expect(await main(['--not-a-flag'], badFlag)).toBe(2)
    expect(badFlag.err()).toContain('link-sentry:')

    const repo = await tempRepo()
    try {
      const badNumber = capture()
      expect(await main(['--concurrency', 'zero'], { ...badNumber, cwd: repo.dir })).toBe(2)

      const badIgnore = capture()
      expect(await main(['--ignore', '('], { ...badIgnore, cwd: repo.dir })).toBe(2)
      expect(badIgnore.err()).toContain('Invalid ignore pattern')

      const empty = capture()
      expect(await main(['docs/**/*.md'], { ...empty, cwd: repo.dir })).toBe(2)
      expect(empty.err()).toContain('No Markdown files')

      const allowed = capture()
      expect(await main(['--allow-empty', 'docs/**/*.md'], { ...allowed, cwd: repo.dir })).toBe(0)
    } finally {
      await repo.cleanup()
    }
  })

  it('exits 1 for a broken local link and 0 when the docs are clean', async () => {
    const repo = await tempRepo()
    try {
      await repo.write('README.md', '# Title\n\n[self](#title)\n\n[missing](./missing.md)\n')
      const failed = capture()
      expect(await main(['--skip-external', 'README.md'], { ...failed, cwd: repo.dir })).toBe(1)
      expect(failed.out()).toContain('README.md:')
      expect(failed.out()).toContain('missing')

      await repo.write('README.md', '# Title\n\n[self](#title)\n')
      const ok = capture()
      expect(await main(['--skip-external', '--json', 'README.md'], { ...ok, cwd: repo.dir })).toBe(0)
      const report = JSON.parse(ok.out()) as { ok: boolean; summary: { ok: number } }
      expect(report.ok).toBe(true)
      expect(report.summary.ok).toBe(1)
    } finally {
      await repo.cleanup()
    }
  })

  it('loads config and writes a json file', async () => {
    const repo = await tempRepo()
    const summaryDir = await mkdtemp(path.join(tmpdir(), 'link-sentry-summary-'))
    try {
      await repo.write(
        'link-sentry.config.json',
        JSON.stringify({
          patterns: ['notes/*.md'],
          skipExternal: true,
          ignore: ['https://example\\.com'],
        }),
      )
      await repo.write('notes/a.md', '# Notes\n\n[here](#notes)\n')
      const summaryFile = path.join(summaryDir, 'summary.md')
      const io = capture()
      const code = await main(['--json-file', 'out/report.json', '--github-summary'], {
        ...io,
        cwd: repo.dir,
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
      })
      expect(code).toBe(0)
      const written = JSON.parse(await readFile(path.join(repo.dir, 'out/report.json'), 'utf8')) as {
        ok: boolean
      }
      expect(written.ok).toBe(true)
      const summary = await readFile(summaryFile, 'utf8')
      expect(summary).toContain('### Link Sentry')
      expect(io.out()).toContain('link-sentry')
    } finally {
      await repo.cleanup()
      await rm(summaryDir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown config key', async () => {
    const repo = await tempRepo()
    try {
      await repo.write('link-sentry.config.json', '{"timeouts": 1}\n')
      await repo.write('README.md', '# Title\n')
      const io = capture()
      expect(await main([], { ...io, cwd: repo.dir })).toBe(2)
      expect(io.err()).toContain('Unknown config key')
    } finally {
      await repo.cleanup()
    }
  })
})
