#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coucou-cpu-monitor.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -parse-as-library \
    NotchBuddy/Sources/App/CPUMonitor.swift \
    tests/CPUMonitorTests.swift -o "$TEST_DIR/cpu-monitor-tests"
"$TEST_DIR/cpu-monitor-tests"