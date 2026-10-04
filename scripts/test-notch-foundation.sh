#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

require_native=0
case "${1:-}" in
  '') ;;
  --require-native) require_native=1 ;;
  *) echo 'Usage: bash scripts/test-notch-foundation.sh [--require-native]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then echo 'Too many arguments' >&2; exit 2; fi

node --test tests/island-fsm.test.ts tests/file-preparation.test.ts tests/foundation-runner.test.mjs

if [[ -f scripts/test-file-copy.sh ]] && { [[ -n "${RUSTC:-}" ]] || command -v rustc >/dev/null 2>&1; }; then
  bash scripts/test-file-copy.sh
else
  echo 'PENDING: standalone native copy checks (supply RUSTC or rustc on PATH)'
fi

if [[ -x windows/node_modules/.bin/tsc && -x windows/node_modules/.bin/vite ]]; then
  (cd windows; ./node_modules/.bin/tsc --noEmit; ./node_modules/.bin/vite build)
else
  echo 'PENDING: TypeScript/Vite checks (existing lockfile dependencies unavailable)'
fi

if [[ -f windows/Cargo.toml ]] && command -v cargo >/dev/null 2>&1; then
  # No full static archive: execute the app-library test target only.
  (cd windows; cargo test -p coucou --lib --locked)
else
  echo 'PENDING: native app-library checks (Cargo/platform prerequisites unavailable)'
fi

if command -v swiftc >/dev/null 2>&1 && [[ -f scripts/test-island-fsm.sh && -f scripts/test-file-preparation.sh ]]; then
  bash scripts/test-island-fsm.sh
  bash scripts/test-file-preparation.sh
else
  echo 'PENDING: executable Swift hover/preparation checks'
fi

# Browser fixtures and a stale receipt file are not native acceptance evidence.
echo 'PENDING: actual Mac/Windows drag, approval, sandbox, accessibility and performance acceptance'
if (( require_native )); then
  echo 'Required native foundation acceptance is incomplete' >&2
  exit 1
fi
echo 'Available foundation checks passed; native milestone remains pending'
