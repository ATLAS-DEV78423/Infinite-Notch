#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  '') flags=() ;;
  --legacy) flags=(--cfg legacy_collision) ;;
  --reaping-baseline) flags=(--cfg reaping_baseline) ;;
  *) echo 'Usage: bash scripts/test-file-copy.sh [--legacy|--reaping-baseline]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then exit 2; fi
rustc="${RUSTC:-$(command -v rustc || true)}"
if [[ -z "$rustc" ]] || ! command -v "$rustc" >/dev/null 2>&1; then
  echo 'PENDING: supply RUSTC or put rustc on PATH' >&2; exit 1
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/coucou-file-copy-tests-XXXXXX")
trap 'rm -rf "$work"' EXIT
export COUCOU_COPY_TEST_ROOT="$work"
"$rustc" --edition=2021 --test "${flags[@]}" tests/file-copy-rust.rs -o "$work/tests"
"$work/tests" --test-threads=4
