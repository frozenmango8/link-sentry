import type { FileError, LinkResult, LinkStatus, Report } from './types.js'
import { isHardFailure } from './types.js'

const LABELS: Record<LinkStatus, string> = {
  ok: 'ok',
  broken: 'broken',
  missing: 'missing',
  anchor: 'anchor',
  rate_limited: 'rate-limited',
  timeout: 'timeout',
  network: 'network',
  ignored: 'ignored',
  skipped: 'skipped',
}

export function formatText(
  report: Report,
  options: { color: boolean; verbose: boolean; allowRateLimit: boolean },
): string {
  const visible = report.results.filter((result) =>
    shouldShow(result, options.verbose),
  )
  const problemCount =
    report.summary.failed +
    report.errors.length +
    (options.allowRateLimit ? 0 : report.summary.rateLimited)
  const lines: string[] = []

  const allowedRates = options.allowRateLimit && report.summary.rateLimited > 0
  if (problemCount === 0 && !allowedRates && visible.length === 0) {
    lines.push(`${paint(options.color, '32', 'link-sentry')}  ${summaryLine(report, options.allowRateLimit)}`)
    return `${lines.join('\n')}\n`
  }

  if (problemCount === 0 && allowedRates) {
    lines.push(
      `${paint(options.color, '33', 'link-sentry')}  rate limits were allowed and are listed below`,
    )
  } else if (problemCount === 0) {
    lines.push(paint(options.color, '32', 'link-sentry'))
  } else {
    const label = problemCount === 1 ? 'problem' : 'problems'
    lines.push(paint(options.color, '1', `link-sentry found ${problemCount} ${label}`))
  }
  lines.push('')

  for (const error of report.errors) {
    lines.push(`${paint(options.color, '31', 'error'.padEnd(13))}  ${error.file}`)
    lines.push(`${''.padEnd(13)}  ${paint(options.color, '2', error.message)}`)
    lines.push('')
  }

  for (const result of visible) {
    const location = `${result.file}:${result.line}:${result.column}`
    const label = LABELS[result.status].padEnd(13)
    lines.push(
      `${location}  ${paint(options.color, colorFor(result.status), label)}  ${result.target}`,
    )
    lines.push(
      `${''.padEnd(location.length)}  ${''.padEnd(13)}  ${paint(options.color, '2', result.message)}`,
    )
    lines.push('')
  }

  lines.push(summaryLine(report, options.allowRateLimit))
  return `${lines.join('\n')}\n`
}

export function formatGitHubSummary(report: Report, allowRateLimit: boolean): string {
  const summary = report.summary
  const lines = [
    '### Link Sentry',
    '',
    '| | Count |',
    '| --- | ---: |',
    `| Files | ${report.files.length} |`,
    `| Links | ${summary.total} |`,
    `| Ok | ${summary.ok} |`,
    `| Failed | ${summary.failed} |`,
    `| Rate limited | ${summary.rateLimited}${allowRateLimit ? ' (allowed)' : ''} |`,
  ]
  if (summary.ignored) lines.push(`| Ignored | ${summary.ignored} |`)
  if (summary.skipped) lines.push(`| Skipped | ${summary.skipped} |`)

  const problems = report.results.filter(
    (result) => isHardFailure(result.status) || result.status === 'rate_limited',
  )
  const rows = [
    ...report.errors.map(
      (error) => `| \`${cell(error.file)}\` | error | ${cell(error.message)} |`,
    ),
    ...problems.map(
      (result) =>
        `| \`${cell(`${result.file}:${result.line}:${result.column}`)}\` | ${LABELS[result.status]} | ${cell(result.target)} |`,
    ),
  ]
  if (rows.length > 0) {
    lines.push('', '#### Problems', '', '| Location | Status | Target |', '| --- | --- | --- |')
    const cap = 40
    lines.push(...rows.slice(0, cap))
    if (rows.length > cap) lines.push('', `_and ${rows.length - cap} more._`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function summarize(
  results: readonly LinkResult[],
  errors: readonly FileError[],
  allowRateLimit: boolean,
): { summary: Report['summary']; ok: boolean } {
  const summary: Report['summary'] = {
    total: results.length,
    ok: 0,
    failed: 0,
    rateLimited: 0,
    ignored: 0,
    skipped: 0,
  }
  for (const result of results) {
    if (result.status === 'ok') summary.ok += 1
    else if (result.status === 'ignored') summary.ignored += 1
    else if (result.status === 'skipped') summary.skipped += 1
    else if (result.status === 'rate_limited') summary.rateLimited += 1
    else summary.failed += 1
  }
  const rateFails = allowRateLimit ? 0 : summary.rateLimited
  return {
    summary,
    ok: summary.failed === 0 && rateFails === 0 && errors.length === 0,
  }
}

function shouldShow(result: LinkResult, verbose: boolean): boolean {
  if (verbose) return true
  return isHardFailure(result.status) || result.status === 'rate_limited'
}

function summaryLine(report: Report, allowRateLimit: boolean): string {
  const summary = report.summary
  const parts = [
    `${report.files.length} ${report.files.length === 1 ? 'file' : 'files'}`,
    `${summary.total} ${summary.total === 1 ? 'link' : 'links'}`,
  ]
  if (summary.failed) parts.push(`${summary.failed} failed`)
  if (summary.rateLimited) {
    parts.push(`${summary.rateLimited} rate-limited${allowRateLimit ? ' (allowed)' : ''}`)
  }
  if (summary.ok) parts.push(`${summary.ok} ok`)
  if (summary.ignored) parts.push(`${summary.ignored} ignored`)
  if (summary.skipped) parts.push(`${summary.skipped} skipped`)
  parts.push(formatDuration(report.durationMs))
  return parts.join(' · ')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function colorFor(status: LinkStatus): string {
  if (status === 'ok') return '32'
  if (status === 'rate_limited' || status === 'timeout' || status === 'network') return '33'
  if (status === 'ignored' || status === 'skipped') return '2'
  return '31'
}

function paint(enabled: boolean, code: string, text: string): string {
  if (!enabled) return text
  return `\u001b[${code}m${text}\u001b[0m`
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
