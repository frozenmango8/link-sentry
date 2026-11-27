import { readFileSync } from 'node:fs'

let cached: string | undefined

export function packageVersion(): string {
  if (cached) return cached
  const url = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string }
  cached = pkg.version ?? '0.0.0'
  return cached
}

export function defaultUserAgent(): string {
  return `link-sentry/${packageVersion()} (+https://github.com/frozenmango8/link-sentry)`
}
