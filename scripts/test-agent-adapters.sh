#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

node --test tests/opencode-privacy.test.mjs tests/adapter-relay.test.mjs
python3 -B -m unittest discover -s tests -p test_hermes_privacy.py -v
python3 -B -m unittest discover -s tests -p test_adapter_relay.py -v

echo "Synthetic baseline/privacy/bounded-sender checks passed; runtime and native qualification remain pending"
