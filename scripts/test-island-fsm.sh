#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coucou-island-fsm.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -parse-as-library \
    NotchBuddy/Sources/App/IslandStateMachine.swift \
    tests/IslandStateMachineTests.swift -o "$TEST_DIR/island-fsm-tests"
"$TEST_DIR/island-fsm-tests"
