import { UsageError } from './types.js'

export interface IgnoreMatcher {
  source: string
  test: (value: string) => boolean
}

export function compileIgnore(patterns: readonly string[]): IgnoreMatcher[] {
  return patterns.map((pattern) => {
    try {
      const expression = new RegExp(pattern, 'i')
      return {
        source: pattern,
        test: (value: string) => expression.test(value),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new UsageError(`Invalid ignore pattern /${pattern}/: ${detail}`)
    }
  })
}

export function isIgnored(value: string, matchers: readonly IgnoreMatcher[]): boolean {
  return matchers.some((matcher) => matcher.test(value))
}
