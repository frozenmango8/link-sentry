import { chmodSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { build } from 'esbuild'

execSync('tsc -p tsconfig.build.json', { stdio: 'inherit' })

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  packages: 'bundle',
})

chmodSync('dist/cli.js', 0o755)
