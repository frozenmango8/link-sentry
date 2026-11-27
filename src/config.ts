import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { UsageError } from './types.js'

const CONFIG_NAMES = ['link-sentry.config.json', '.link-sentry.json']

export interface FileConfig {
  patterns?: string[]
  concurrency?: number
  timeoutMs?: number
  retries?: number
  maxRedirects?: number
  maxRetryWaitMs?: number
  allowRateLimit?: boolean
  skipExternal?: boolean
  skipAnchors?: boolean
  skipImages?: boolean
  allowEmpty?: boolean
  noDefaultExcludes?: boolean
  ignore?: string[]
  exclude?: string[]
  headers?: Record<string, string>
  headerHosts?: string[]
  userAgent?: string
  root?: string
}

const NUMBER_KEYS = new Set<keyof FileConfig>([
  'concurrency',
  'timeoutMs',
  'retries',
  'maxRedirects',
  'maxRetryWaitMs',
])

const BOOLEAN_KEYS = new Set<keyof FileConfig>([
  'allowRateLimit',
  'skipExternal',
  'skipAnchors',
  'skipImages',
  'allowEmpty',
  'noDefaultExcludes',
])

const STRING_ARRAY_KEYS = new Set<keyof FileConfig>([
  'patterns',
  'ignore',
  'exclude',
  'headerHosts',
])

const ALIASES: Record<string, keyof FileConfig> = {
  patterns: 'patterns',
  concurrency: 'concurrency',
  timeout: 'timeoutMs',
  timeoutMs: 'timeoutMs',
  retries: 'retries',
  maxRedirects: 'maxRedirects',
  maxRetryWait: 'maxRetryWaitMs',
  maxRetryWaitMs: 'maxRetryWaitMs',
  allowRateLimit: 'allowRateLimit',
  skipExternal: 'skipExternal',
  skipAnchors: 'skipAnchors',
  skipImages: 'skipImages',
  allowEmpty: 'allowEmpty',
  noDefaultExcludes: 'noDefaultExcludes',
  ignore: 'ignore',
  exclude: 'exclude',
  headers: 'headers',
  headerHosts: 'headerHosts',
  userAgent: 'userAgent',
  root: 'root',
}

const NUMBER_MINIMUMS: Partial<Record<keyof FileConfig, number>> = {
  concurrency: 1,
  timeoutMs: 1,
  retries: 0,
  maxRedirects: 0,
  maxRetryWaitMs: 0,
}

export async function loadConfigFile(cwd: string, explicit?: string): Promise<FileConfig> {
  const file = await locateConfig(cwd, explicit)
  if (!file) return {}
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new UsageError(`Could not read config ${display(cwd, file)}: ${message(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new UsageError(`Config ${display(cwd, file)} is not valid JSON: ${message(error)}`)
  }
  return normalizeConfig(parsed, display(cwd, file))
}

async function locateConfig(cwd: string, explicit?: string): Promise<string | undefined> {
  if (explicit) {
    const full = path.resolve(cwd, explicit)
    try {
      await access(full)
    } catch {
      throw new UsageError(`Config file not found: ${explicit}`)
    }
    return full
  }
  for (const name of CONFIG_NAMES) {
    const full = path.join(cwd, name)
    try {
      await access(full)
      return full
    } catch {
      // try the next conventional name
    }
  }
  return undefined
}

function normalizeConfig(parsed: unknown, file: string): FileConfig {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`Config ${file} must be a JSON object`)
  }
  const config: FileConfig = {}
  const seen = new Map<keyof FileConfig, string>()
  for (const [key, value] of Object.entries(parsed)) {
    const canonical = ALIASES[key]
    if (!canonical) throw new UsageError(`Unknown config key "${key}" in ${file}`)
    const previous = seen.get(canonical)
    if (previous) {
      throw new UsageError(`Config ${file} sets both "${previous}" and "${key}"`)
    }
    seen.set(canonical, key)
    assign(config, canonical, value, file)
  }
  return config
}

function assign(config: FileConfig, key: keyof FileConfig, value: unknown, file: string): void {
  if (NUMBER_KEYS.has(key)) {
    const minimum = NUMBER_MINIMUMS[key] ?? 0
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
      throw new UsageError(`Config key "${key}" must be an integer >= ${minimum}`)
    }
    config[key] = value as never
    return
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value !== 'boolean') throw new UsageError(`Config key "${key}" must be a boolean`)
    config[key] = value as never
    return
  }
  if (STRING_ARRAY_KEYS.has(key)) {
    config[key] = stringArray(value, key) as never
    return
  }
  if (key === 'userAgent' || key === 'root') {
    if (typeof value !== 'string' || !value.trim()) {
      throw new UsageError(`Config key "${key}" must be a non-empty string`)
    }
    config[key] = value
    return
  }
  if (key === 'headers') {
    config.headers = headerRecord(value, file)
  }
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new UsageError(`Config key "${key}" must be an array of strings`)
  }
  return value
}

function headerRecord(value: unknown, file: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError(`Config ${file} key "headers" must be an object of strings`)
  }
  const headers: Record<string, string> = {}
  for (const [name, header] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      throw new UsageError(`Invalid header name "${name}" in ${file}`)
    }
    if (typeof header !== 'string' || /[\r\n]/.test(header)) {
      throw new UsageError(`Header "${name}" in ${file} must be a single-line string`)
    }
    headers[name] = header
  }
  return headers
}

function display(cwd: string, file: string): string {
  const relative = path.relative(cwd, file)
  return relative && !relative.startsWith('..') ? relative : file
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
