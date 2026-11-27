import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export async function tempRepo(): Promise<{
  dir: string
  write: (relative: string, content: string) => Promise<void>
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'link-sentry-'))
  return {
    dir,
    async write(relative, content) {
      const full = path.join(dir, relative)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content)
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export function capture(): {
  stdout: { write(chunk: string): void }
  stderr: { write(chunk: string): void }
  out: () => string
  err: () => string
} {
  let out = ''
  let err = ''
  return {
    stdout: {
      write(chunk: string) {
        out += chunk
      },
    },
    stderr: {
      write(chunk: string) {
        err += chunk
      },
    },
    out: () => out,
    err: () => err,
  }
}
