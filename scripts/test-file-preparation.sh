#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coucou-file-preparation.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir "$TEST_DIR/fixtures"
export COUCOU_PREPARATION_TEST_ROOT="$TEST_DIR/fixtures"
swiftc -swift-version 6 -strict-concurrency=complete -parse-as-library \
    NotchBuddy/Sources/App/FilePreparation.swift \
    NotchBuddy/Sources/App/UploadSequenceEngine.swift \
    tests/FilePreparationTests.swift -o "$TEST_DIR/file-preparation-tests"
"$TEST_DIR/file-preparation-tests"
