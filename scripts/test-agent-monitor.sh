#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

require_platform=0
case "${1:-}" in
  "") ;;
  --require-platform-checks) require_platform=1 ;;
  *) echo "Usage: bash scripts/test-agent-monitor.sh [--require-platform-checks]" >&2; exit 2 ;;
esac
if (( $# > 1 )); then echo "Too many arguments" >&2; exit 2; fi

bash scripts/test-agent-adapters.sh
node --test tests/agent-monitor.test.ts
python3 -B -m unittest discover -s tests -p 'test_agent_relay.py'

pending=0
if [[ -x windows/node_modules/.bin/tsc && -x windows/node_modules/.bin/vite ]]; then
  (cd windows; ./node_modules/.bin/tsc --noEmit; ./node_modules/.bin/vite build)
else
  echo 'PENDING: TypeScript/Vite checks (install existing windows lockfile dependencies)'
  pending=1
fi
if command -v cargo >/dev/null 2>&1; then
  (cd windows; cargo test --workspace)
else
  echo 'PENDING: Rust workspace tests (Cargo unavailable)'
  pending=1
fi
if command -v swiftc >/dev/null 2>&1 && [[ -f scripts/test-agent-monitor-swift.sh ]]; then
  bash scripts/test-agent-monitor-swift.sh
else
  echo 'PENDING: Swift inspector tests (native lane/runner unavailable)'
  pending=1
fi

# Builds and fixture tests are not native UI or actual agent-host qualification.
echo 'PENDING: real OpenCode V2/Hermes flows, native UI/sandbox and transport-lifetime acceptance'
pending=1
git diff --check
if (( require_platform && pending )); then
  echo 'Required runtime/platform acceptance is incomplete' >&2
  exit 1
fi
echo 'Portable checks passed; native verification may remain pending'
