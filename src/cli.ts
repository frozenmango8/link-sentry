import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { loadConfigFile, type FileConfig } from './config.js'
import { formatGitHubSummary, formatText } from './report.js'
import { checkLinks } from './run.js'
import type { CheckOptions } from './types.js'
import { UsageError } from './types.js'
import { packageVersion } from './version.js'

interface TextStream {
  write(chunk: string): void
}

export interface MainIO {
  stdout?: TextStream
  stderr?: TextStream
  cwd?: string
  env?: NodeJS.ProcessEnv
  color?: boolean
}

const HELP = `link-sentry — find broken links in Markdown

Usage
  link-sentry [options] [globs...]

  With no globs, checks **/*.md and **/*.markdown, skipping node_modules and .git.
  External URLs are requested with HEAD, then GET when a server rejects HEAD.
  Relative links and #anchors are checked on disk. Anchors use GitHub heading slugs.

Options
  -c, --config <file>       JSON config (link-sentry.config.json or .link-sentry.json)
      --concurrency <n>     In-flight HTTP requests (default 8)
      --timeout <ms>        Per-request timeout (default 10000)
      --retries <n>         Extra attempts for timeouts, network errors, 429, and 5xx (default 2)
      --max-redirects <n>   Redirects to follow (default 5)
      --max-retry-wait <ms> Cap for Retry-After and backoff (default 15000)
      --ignore <regex>      Case-insensitive regex; repeat to add more
      --exclude <glob>      Skip files; repeat to add more
      --root <dir>          Root for links that start with /
      --user-agent <ua>     Override the User-Agent header
      --header-host <host>  Send config headers only to this host (repeatable, *.example.com ok)
      --allow-rate-limit    HTTP 429 after retries does not fail the process
      --skip-external       Check only files and anchors
      --skip-anchors        Do not check #fragments
      --skip-images         Do not check image destinations
      --allow-empty         Exit 0 when no files match
      --no-default-excludes Do not ignore node_modules and .git
      --json                Print the report as JSON on stdout
      --json-file <file>    Write the JSON report to a file
      --github-summary      Append a Markdown summary to GITHUB_STEP_SUMMARY
      --verbose             Print links that passed, plus ignored and skipped links
      --no-color            Disable color
  -h, --help                Show this help
  -v, --version             Print the version

Exit codes
  0  every checked link is ok (rate limits pass when --allow-rate-limit is set)
  1  a link is broken, missing, an unknown anchor, timed out, or a network error
  2  the invocation itself is wrong (bad flag, bad config, no files matched)

Examples
  link-sentry "docs/**/*.md"
  link-sentry --skip-external README.md
  link-sentry --ignore "https://example\\\\.com" --json
  link-sentry --config link-sentry.config.json

A persistent HTTP 429 is reported as rate-limited, not as a broken page.
The checker waits for Retry-After (capped) and otherwise backs off before retrying.
`

interface Flags {
  help: boolean
  version: boolean
  config?: string
  concurrency?: string
  timeout?: string
  retries?: string
  maxRedirects?: string
  maxRetryWait?: string
  ignore: string[]
  exclude: string[]
  headerHosts: string[]
  root?: string
  userAgent?: string
  allowRateLimit: boolean
  skipExternal: boolean
  skipAnchors: boolean
  skipImages: boolean
  allowEmpty: boolean
  noDefaultExcludes: boolean
  json: boolean
  jsonFile?: string
  githubSummary: boolean
  verbose: boolean
  noColor: boolean
  patterns: string[]
}

export async function main(argv: string[], io: MainIO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const cwd = io.cwd ?? process.cwd()
  const env = io.env ?? process.env

  try {
    const flags = parseFlags(argv)
    if (flags.help) {
      stdout.write(HELP)
      return 0
    }
    if (flags.version) {
      stdout.write(`${packageVersion()}\n`)
      return 0
    }

    const file = await loadConfigFile(cwd, flags.config)
    const check = toCheckOptions(flags, file, cwd)
    const report = await checkLinks(check)
    const color =
      io.color ??
      (!flags.noColor && !env.NO_COLOR && !flags.json && Boolean(process.stdout.isTTY) && !io.stdout)

    if (flags.jsonFile) {
      const destination = path.resolve(cwd, flags.jsonFile)
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`)
    }
    if (flags.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else stdout.write(formatText(report, { color, verbose: flags.verbose, allowRateLimit: check.allowRateLimit ?? false }))

    if (flags.githubSummary && env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        formatGitHubSummary(report, check.allowRateLimit ?? false),
      )
    }
    return report.ok ? 0 : 1
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`link-sentry: ${error.message}\n`)
      return 2
    }
    stderr.write(`link-sentry: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function parseFlags(argv: string[]): Flags {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        config: { type: 'string', short: 'c' },
        concurrency: { type: 'string' },
        timeout: { type: 'string' },
        retries: { type: 'string' },
        'max-redirects': { type: 'string' },
        'max-retry-wait': { type: 'string' },
        ignore: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        'header-host': { type: 'string', multiple: true },
        root: { type: 'string' },
        'user-agent': { type: 'string' },
        'allow-rate-limit': { type: 'boolean', default: false },
        'skip-external': { type: 'boolean', default: false },
        'skip-anchors': { type: 'boolean', default: false },
        'skip-images': { type: 'boolean', default: false },
        'allow-empty': { type: 'boolean', default: false },
        'no-default-excludes': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'json-file': { type: 'string' },
        'github-summary': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
      },
    })
    const values = parsed.values
    return {
      help: values.help,
      version: values.version,
      config: values.config,
      concurrency: values.concurrency,
      timeout: values.timeout,
      retries: values.retries,
      maxRedirects: values['max-redirects'],
      maxRetryWait: values['max-retry-wait'],
      ignore: values.ignore ?? [],
      exclude: values.exclude ?? [],
      headerHosts: values['header-host'] ?? [],
      root: values.root,
      userAgent: values['user-agent'],
      allowRateLimit: values['allow-rate-limit'],
      skipExternal: values['skip-external'],
      skipAnchors: values['skip-anchors'],
      skipImages: values['skip-images'],
      allowEmpty: values['allow-empty'],
      noDefaultExcludes: values['no-default-excludes'],
      json: values.json,
      jsonFile: values['json-file'],
      githubSummary: values['github-summary'],
      verbose: values.verbose,
      noColor: values['no-color'],
      patterns: parsed.positionals,
    }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

function toCheckOptions(flags: Flags, file: FileConfig, cwd: string): CheckOptions {
  return {
    cwd,
    patterns: flags.patterns.length > 0 ? flags.patterns : file.patterns,
    root: flags.root ?? file.root,
    concurrency: integerFlag('--concurrency', flags.concurrency, 1) ?? file.concurrency,
    timeoutMs: integerFlag('--timeout', flags.timeout, 1) ?? file.timeoutMs,
    retries: integerFlag('--retries', flags.retries, 0) ?? file.retries,
    maxRedirects: integerFlag('--max-redirects', flags.maxRedirects, 0) ?? file.maxRedirects,
    maxRetryWaitMs: integerFlag('--max-retry-wait', flags.maxRetryWait, 0) ?? file.maxRetryWaitMs,
    ignore: [...(file.ignore ?? []), ...flags.ignore],
    exclude: [...(file.exclude ?? []), ...flags.exclude],
    headerHosts: [...(file.headerHosts ?? []), ...flags.headerHosts],
    headers: file.headers,
    userAgent: flags.userAgent ?? file.userAgent,
    allowRateLimit: flags.allowRateLimit || file.allowRateLimit,
    skipExternal: flags.skipExternal || file.skipExternal,
    skipAnchors: flags.skipAnchors || file.skipAnchors,
    skipImages: flags.skipImages || file.skipImages,
    allowEmpty: flags.allowEmpty || file.allowEmpty,
    noDefaultExcludes: flags.noDefaultExcludes || file.noDefaultExcludes,
  }
}

function integerFlag(name: string, value: string | undefined, minimum: number): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be an integer >= ${minimum}`)
  const parsed = Number(value)
  if (parsed < minimum) throw new UsageError(`${name} must be an integer >= ${minimum}`)
  return parsed
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code)
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    },
  )
}
