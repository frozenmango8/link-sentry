export const DEFAULT_PATTERNS = ['**/*.md', '**/*.markdown']

export const DEFAULT_EXCLUDES = ['**/node_modules/**', '**/.git/**']

export const DEFAULT_CONCURRENCY = 8
export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_RETRIES = 2
export const DEFAULT_MAX_REDIRECTS = 5
export const DEFAULT_MAX_RETRY_WAIT_MS = 15_000

export const MAX_FILE_BYTES = 8_000_000

export const DOC_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdown',
  '.mkd',
  '.mdx',
  '.html',
  '.htm',
])

export const README_NAMES = [
  'README.md',
  'README.markdown',
  'readme.md',
  'Readme.md',
  'index.md',
]
