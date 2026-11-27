#!/usr/bin/env bash
# Entry point for the composite GitHub Action. The bundled CLI is committed
# at dist/cli.js so a workflow does not need to install dependencies.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "link-sentry: Node.js 20 or newer must be on PATH." >&2
  exit 1
fi

cli="${GITHUB_ACTION_PATH}/dist/cli.js"
if [[ ! -f "$cli" ]]; then
  echo "link-sentry: bundled CLI not found at $cli" >&2
  exit 1
fi

args=()

add_opt() {
  local flag="$1"
  local value="$2"
  if [[ -n "$value" ]]; then
    args+=("$flag" "$value")
  fi
}

add_opt --config "${LS_CONFIG:-}"
add_opt --concurrency "${LS_CONCURRENCY:-}"
add_opt --timeout "${LS_TIMEOUT:-}"
add_opt --retries "${LS_RETRIES:-}"
add_opt --root "${LS_ROOT:-}"
add_opt --json-file "${LS_JSON_OUTPUT:-}"

if [[ "${LS_ALLOW_RATE_LIMIT:-}" == "true" ]]; then
  args+=(--allow-rate-limit)
fi
if [[ "${LS_SKIP_EXTERNAL:-}" == "true" ]]; then
  args+=(--skip-external)
fi
if [[ "${LS_SKIP_ANCHORS:-}" == "true" ]]; then
  args+=(--skip-anchors)
fi
if [[ "${LS_SKIP_IMAGES:-}" == "true" ]]; then
  args+=(--skip-images)
fi
if [[ "${LS_VERBOSE:-}" == "true" ]]; then
  args+=(--verbose)
fi

args+=(--github-summary)

# Ignore patterns are newline-separated so a regex can contain spaces.
if [[ -n "${LS_IGNORE:-}" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    args+=(--ignore "$line")
  done <<< "${LS_IGNORE}"
fi

add_paths() {
  local text="$1"
  [[ -z "$text" ]] && return 0
  if [[ "$text" == *$'\n'* ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      args+=("$line")
    done <<< "$text"
  else
    # Keep globs literal. A single line is split on whitespace.
    local parts=()
    set -f
    # shellcheck disable=SC2206
    parts=( $text )
    set +f
    args+=("${parts[@]}")
  fi
}

add_paths "${LS_PATHS:-}"

node "$cli" "${args[@]}"
