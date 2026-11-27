# link-sentry

Find broken links in Markdown docs. link-sentry is a small Node.js CLI and a GitHub Action. It checks external URLs, relative files, and in-page `#anchors` against GitHub heading slugs, then prints `file:line:column` so you can jump straight to the problem.

```bash
npx link-sentry "docs/**/*.md"
```

- [Install](#install)
- [Quick start](#quick-start)
- [What it checks](#what-it-checks)
- [Report](#report)
- [GitHub Action](#github-action)
- [CLI](#cli)
- [Configuration](#configuration)
- [Ignore patterns](#ignore-patterns)
- [Anchors](#anchors)
- [Rate limits](#rate-limits)
- [Exit codes](#exit-codes)
- [Security](#security)
- [Development](#development)
- [License](#license)

## Install

Node.js 20 or newer. The CLI uses the built-in `fetch`.

```bash
npm install --save-dev link-sentry
npx link-sentry "docs/**/*.md"
```

From a checkout of this repository:

```bash
npm ci
npm run build
node dist/cli.js "docs/**/*.md"
```

With no globs, link-sentry checks `**/*.md` and `**/*.markdown`. It skips `node_modules` and `.git` unless you pass `--no-default-excludes`.

## Quick start

```bash
npx link-sentry "docs/**/*.md" README.md
```

A clean tree prints one line and exits 0:

```text
link-sentry  2 files · 18 links · 18 ok · 840ms
```

A broken link exits 1. The location is `file:line:column`, which editors and GitHub annotations already understand:

```text
link-sentry found 3 problems

docs/guide.md:12:1  missing        ./old-name.md
                    file not found: docs/old-name.md

docs/guide.md:18:1  anchor         #instal
                    no heading or anchor "instal" in docs/guide.md (did you mean "install"?)

README.md:30:3  broken         https://example.com/moved
                404 Not Found

2 files · 14 links · 3 failed · 11 ok · 1.2s
```

Machine-readable output:

```bash
npx link-sentry --json "docs/**/*.md" > report.json
```

## What it checks

| Link | What happens |
| --- | --- |
| `https://…` and `http://…` | HEAD, then GET if the server rejects HEAD. Redirects are followed. |
| `//cdn.example/app.js` | Treated as `https:`. |
| `./guide.md`, `../README.md` | Resolved from the file that contains the link. |
| `/docs/guide.md` | Resolved from `--root` (default: the working directory). |
| `./guide.md#setup`, `#setup` | The file must exist and the fragment must match a heading slug or an explicit `id`. |
| `./images/diagram.png` and `![alt](url)` | The file or URL must exist. `--skip-images` leaves these out. |
| `./guide.md?plain=1` | The query is ignored for the file check. GitHub uses this. |
| `mailto:`, `tel:`, `javascript:`, `data:` | Skipped. They are not pages. |
| `[text][id]` with no definition | Reported as a broken reference. Undefined references render as literal text. |

Fenced code blocks, indented code blocks, and inline code are not scanned. A sample URL in a code fence will not fail the build.

The same external URL is requested once per run, even when many files point at it.

## Report

Text goes to stdout. With `--json`, stdout is a single JSON document and nothing else. `--json-file report.json` writes that document and still prints the text report.

```json
{
  "version": 1,
  "ok": false,
  "files": ["README.md"],
  "durationMs": 420,
  "summary": { "total": 2, "ok": 1, "failed": 1, "rateLimited": 0, "ignored": 0, "skipped": 0 },
  "results": [
    {
      "file": "README.md",
      "line": 12,
      "column": 1,
      "kind": "link",
      "target": "https://example.com/missing",
      "status": "broken",
      "httpStatus": 404,
      "method": "GET",
      "attempts": 1,
      "message": "404 Not Found"
    }
  ],
  "errors": []
}
```

Statuses:

| Status | Meaning |
| --- | --- |
| `ok` | The link resolved. |
| `broken` | HTTP 4xx/5xx (other than a final 429), an empty link, or an unresolved reference. |
| `missing` | The relative file does not exist. |
| `anchor` | The file exists, and the fragment does not. |
| `rate_limited` | Still HTTP 429 after retries. |
| `timeout` | Every attempt exceeded `--timeout`. |
| `network` | DNS, connection reset, or another fetch error, after retries. |
| `ignored` | Matched an ignore pattern. Not requested. |
| `skipped` | Scheme we do not check, or external checks were turned off. |

`--verbose` prints the links that passed. The default printout is problems only, plus a summary line.

## GitHub Action

The action runs the bundled CLI shipped in this repository. It does not `npm install`. GitHub-hosted runners already have Node.js 20+.

```yaml
name: Links
on:
  pull_request:
  push:
permissions:
  contents: read
jobs:
  links:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: frozenmango8/link-sentry@v1
        with:
          paths: |
            docs/**/*.md
            README.md
```

Pin `@v1` to the release you want, or pin a commit SHA. A copy of this workflow lives in [examples/check-links.yml](examples/check-links.yml). This repository's own CI uses `uses: ./` so the action is exercised on every pull request.

| Input | Default | |
| --- | --- | --- |
| `paths` | `**/*.md` | One glob per line, or several space-separated globs on one line. |
| `config` | | Path to a JSON config file. |
| `ignore` | | Extra ignore regexes, one per line. |
| `concurrency` | `8` | In-flight HTTP requests. |
| `timeout` | `10000` | Per-request timeout in milliseconds. |
| `retries` | `2` | Extra attempts after the first, for timeouts, network errors, 429, and 5xx. |
| `root` | workspace | Used for links that start with `/`. |
| `allow-rate-limit` | `false` | A remaining HTTP 429 does not fail the job. |
| `skip-external` | `false` | Check only files and anchors. |
| `skip-anchors` | `false` | Do not check fragments. |
| `skip-images` | `false` | Do not check images. |
| `verbose` | `false` | Print successes too. |
| `json-output` | | Write the JSON report to this path. |

Failures fail the step. On GitHub the action also appends a short table to the job summary.

## CLI

```text
link-sentry [options] [globs...]
```

| Flag | Default | |
| --- | --- | --- |
| `-c, --config <file>` | | `link-sentry.config.json` or `.link-sentry.json` in the working directory. |
| `--concurrency <n>` | `8` | |
| `--timeout <ms>` | `10000` | Applied to each request, including each redirect hop. |
| `--retries <n>` | `2` | Extra attempts. A value of 2 means three tries total. |
| `--max-redirects <n>` | `5` | |
| `--max-retry-wait <ms>` | `15000` | Cap on `Retry-After` and on exponential backoff. |
| `--ignore <regex>` | | Repeatable. Case-insensitive. |
| `--exclude <glob>` | | Repeatable. Added to the default excludes. |
| `--root <dir>` | `.` | |
| `--user-agent <ua>` | `link-sentry/<version>` | |
| `--header-host <host>` | | Repeatable. See [Security](#security). |
| `--allow-rate-limit` | off | Remaining 429s are reported and do not fail the process. |
| `--skip-external` | off | |
| `--skip-anchors` | off | |
| `--skip-images` | off | |
| `--allow-empty` | off | Exit 0 when no files match. The default is exit 2, so a bad glob fails CI. |
| `--no-default-excludes` | off | Also scan `node_modules` and `.git`. |
| `--json` | off | JSON on stdout only. |
| `--json-file <file>` | | |
| `--github-summary` | off | Append Markdown to `GITHUB_STEP_SUMMARY` when that file is set. |
| `--verbose` | off | |
| `--no-color` | | Also disabled when stdout is not a TTY or `NO_COLOR` is set. |
| `-h, --help` | | |
| `-v, --version` | | |

A flag on the command line turns a boolean on. It does not turn a config value off. To disable something set in the config file, change the file.

## Configuration

If you do not pass `--config`, link-sentry reads `link-sentry.config.json` or `.link-sentry.json` from the working directory when one of them exists. Unknown keys are an error, so a typo does not silently do nothing.

```json
{
  "patterns": ["docs/**/*.md", "README.md"],
  "concurrency": 8,
  "timeout": 10000,
  "retries": 2,
  "maxRedirects": 5,
  "maxRetryWait": 15000,
  "ignore": ["https://example\\.com/private", "localhost"],
  "exclude": ["**/CHANGELOG.md"],
  "allowRateLimit": false,
  "headerHosts": ["docs.example.com"]
}
```

`timeout` and `timeoutMs` are the same key. So are `maxRetryWait` and `maxRetryWaitMs`. Do not set both. A full example is in [examples/link-sentry.config.json](examples/link-sentry.config.json).

`headers` is an object of strings, for a private docs host. Pair it with `headerHosts` so the token is not sent anywhere else, and do not commit a real secret. See [Security](#security). The config file is plain JSON: nothing expands `${...}` for you.

Globs on the command line replace `patterns` from the file. Ignore patterns and excludes are combined.

## Ignore patterns

Every `--ignore` value and every `ignore` entry is a JavaScript regular expression, matched case-insensitively against the raw link and, for external URLs, the normalized URL. Dots are not special unless you escape them. `example.com` matches `exampleXcom` as well as `example.com`. Write `example\\.com` when you mean the dot.

```bash
npx link-sentry --ignore "https://example\\.com/private" --ignore "localhost" "docs/**/*.md"
```

Ignored links are not requested. They show up in the JSON report and in the summary count, and in the text report only with `--verbose`.

## Anchors

Heading ids follow [GitHub's slug algorithm](https://github.com/Flet/github-slugger) (`github-slugger`): lowercase, strip punctuation, turn spaces into hyphens, and append `-1`, `-2`, … when the same slug already occurred in that file.

```markdown
# Hello, World!
# Hello, World!
```

Those headings are `#hello-world` and `#hello-world-1`. A link to `#Hello-World`, `#user-content-hello-world`, or `#Hello World` still matches. When the fragment is close to a real heading, the message names it.

Explicit HTML anchors count too: `<a id="custom">`, `<h2 id="custom">`, and `name` attributes. Footnote ids (`user-content-fn-1` and friends) are recognized. Fragments on external URLs are not checked, because that would mean guessing another site's HTML.

A link to a directory is fine. A fragment on a directory is checked against that directory's README, which is what GitHub renders. `.html` files are matched by `id`, `name`, and heading text.

## Rate limits

HTTP 429 is not treated as a missing page.

1. The first 429 is never the final answer.
2. If the response has `Retry-After` (seconds or an HTTP date), link-sentry waits that long, but not longer than `--max-retry-wait` (15 seconds by default). A ten-minute `Retry-After` must not stall CI.
3. Otherwise it waits 500ms, then 1s, then 2s, plus a little jitter, also capped.
4. Timeouts, connection errors, and 408/500/502/503/504 use the same retry budget. A 404 does not. A missing page will not appear if you ask again.
5. If the last response is still 429, the status is `rate_limited`. That fails the process, because the link was not verified. `--allow-rate-limit` prints it and exits 0 when nothing else failed.

HEAD is tried first. A GET is sent when HEAD cannot be trusted: the connection fails, or the status is 400, 401, 403, 404, 405, 406, or 501. Plenty of hosts answer 404 or 405 to HEAD and 200 to GET. The GET body is cancelled as soon as the headers arrive.

## Exit codes

| Code | When |
| --- | --- |
| 0 | No broken, missing, anchor, timeout, or network failures. 429 is allowed only with `--allow-rate-limit`. |
| 1 | At least one of those failures, or a file that could not be read. |
| 2 | Bad flag, invalid config or ignore regex, or no files matched. |

## Security

link-sentry requests every `http` and `https` URL it finds outside of code spans. That is the point of the tool. A documentation change can therefore cause CI to send a request to a host you do not control.

- Usernames and passwords in URLs are stripped from the report.
- Redirects to `javascript:`, `data:`, and anything other than `http`/`https` are refused.
- Headers from the config are sent on the original request. They are removed when a redirect crosses to another host, which is the usual way a token leaks.
- `headerHosts` (or repeatable `--header-host`) is stricter: custom headers are attached only when the hostname matches. `*.github.com` matches `api.github.com` and `github.com`.
- Do not put a secret in a config that also checks arbitrary third-party links, and do not commit tokens. `headerHosts` is the safer default when you do need a header.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Tests are `npm test`. [CI](.github/workflows/ci.yml) runs them on Node 20 and 22, checks that the committed CLI bundle matches the source, and runs the action. The programmatic API is `checkLinks`:

```js
import { checkLinks } from 'link-sentry'

const report = await checkLinks({
  cwd: process.cwd(),
  patterns: ['docs/**/*.md'],
  skipExternal: true,
})

if (!report.ok) process.exit(1)
```

## License

[MIT](LICENSE) © frozenmango8
