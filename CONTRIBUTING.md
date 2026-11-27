# Contributing

Thanks for looking at link-sentry. The useful changes are the ones that keep a check honest: fewer false failures, clearer reports, and no surprise requests.

## Setup

You need Node.js 20 or newer.

```bash
git clone https://github.com/frozenmango8/link-sentry.git
cd link-sentry
npm ci
```

## Checks

```bash
npm test          # unit tests, including mocked HTTP and a local server
npm run typecheck
npm run build     # tsc declarations, then a bundled dist/cli.js
node dist/cli.js --skip-external README.md CONTRIBUTING.md
```

`npm test` does not call the public internet. HTTP behavior is covered with a fake `fetch` and with a server bound to `127.0.0.1`.

CI runs those commands on Node 20 and Node 22. It also rebuilds `dist/cli.js` and fails if the committed bundle does not match the source. After you change `src/`, run `npm run build` and commit `dist/cli.js`. The GitHub Action runs that file directly, so a workflow does not need `npm install`.

## Project layout

| Path | Role |
| --- | --- |
| `src/cli.ts` | Argument parsing, exit codes, human and JSON output |
| `src/extract.ts` | Markdown links, images, and heading slugs |
| `src/http.ts` | HEAD, GET fallback, redirects, retries, 429 handling |
| `src/run.ts` | File discovery and the check pipeline |
| `src/report.ts` | Text report and GitHub step summary |
| `action.yml` | Composite action used as `uses: ./` or `uses: frozenmango8/link-sentry@v1` |
| `test/` | Vitest tests |

Library entry point: `checkLinks` from `src/index.ts`.

## Pull requests

- Add or update a test for the behavior you change. A new status code, slug, or CLI flag without a test will regress.
- Keep the public CLI and the `action.yml` inputs in sync. If you add a flag people need in CI, thread it through `action/run.sh` and document it in the README.
- Do not weaken the default failure mode to hide a flaky host. Prefer an ignore pattern, or document `--allow-rate-limit` when the case is really a rate limit.
- Run `npm test` and `npm run typecheck` before pushing.

## Publishing

The package is set up for npm: `files`, `bin`, `exports`, and `prepublishOnly` (which builds). Publishing is a maintainer step and is not part of CI.

## License

By contributing, you agree that your changes are released under the [MIT license](LICENSE).
