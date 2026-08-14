#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "local" || "${1:-}" == "workstation" ]]; then
  shift
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

# Prefer this checkout's CLI so launch-patch fixes are what we smoke.
corepack pnpm run build
SHIM="$(mktemp -d "${TMPDIR:-/tmp}/leverframe-smoke-bin.XXXXXX")"
printf '%s\n' '#!/bin/sh' "exec node \"${ROOT}/dist/cli.js\" \"\$@\"" > "${SHIM}/leverframe"
chmod +x "${SHIM}/leverframe"
export PATH="${SHIM}:${HOME}/.local/bin:${PATH}"
export LEVERFRAME_LIVE_PROVIDER_SMOKE="${LEVERFRAME_LIVE_PROVIDER_SMOKE:-1}"
set +e
corepack pnpm exec vitest run tests/live-provider-claude-smoke.test.ts "$@"
status=$?
rm -rf "${SHIM}"
exit "${status}"
