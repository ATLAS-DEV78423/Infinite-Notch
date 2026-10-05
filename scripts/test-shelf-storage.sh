#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coucou-shelf-storage.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
mkdir "$TEST_DIR/fixtures"
export COUCOU_PREPARATION_TEST_ROOT="$TEST_DIR/fixtures"
swiftc -swift-version 6 -strict-concurrency=complete -parse-as-library \
    NotchBuddy/Sources/App/FilePreparation.swift \
    tests/ShelfStorageTests.swift -o "$TEST_DIR/shelf-storage-tests"
"$TEST_DIR/shelf-storage-tests"
