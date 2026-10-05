# Infinite-Notch source checkpoint guide

This repository is a development source fork of Coucou. **It is not a completed
or release-qualified Infinite-Notch app.** Upstream names/artwork remain in the
checkout for development; packaged distribution requires resolving
[asset rights](../LICENSE-ASSETS.md), signing and the gates below.

## What exists today

- The upstream native Mac app and Windows/Linux Tauri app remain intact.
- New OpenCode V2/Hermes monitoring adapters, privacy filters/bounded senders,
  wire fixtures and a synthetic-tested Tauri Details inspector are present.
- OpenCode `2.0.6` baseline delivery was exercised in an isolated real runtime;
  Hermes registration/dispatch passed with supplied synthetic hook inputs.
- Rich producers, actual Hermes model-turn inputs, native ingress/lifetime,
  SwiftUI inspector and full platform acceptance remain incomplete.
- The first Tauri foundation implements full hover/holds and receipt-owned file
  readiness, with native owned-copy/cancel and Linux crash cleanup. It is still
  one regular-file selection, not the broader shelf/LocalSend/media/HUD/calendar
  expansion. [Foundation receipt](research/notch-foundation-verification.md),
  [roadmap](NOTCH_ROADMAP.md) and [approved design](superpowers/specs/2026-10-04-notch-app-expansion-design.md)
  separate implemented obligations from pending native/full-release behavior.

See [the agent receipt](research/agent-inspector-verification.md) for precise
commands, evidence limits and pending checks. Do not interpret a source push as
a release endorsement.

## Build and development

Preserve the existing stack. Do not change global agent/model/account settings.

### Windows or Linux

Build-only hosted results are recorded in
[native qualification](research/native-qualification.md). At `4e9468a`, Mac's
21 hover cases and three unsigned builds and Linux's full lane passed; Windows's
standalone lane was 10/11, so its later builds were skipped. These are not native
UI, hardware, signing or release-qualification receipts.
At `0331a4f`, the corrected Windows fixture and new held-writer refusal case
passed (12 standalone / 26 app-library / 10 relay), and both Windows/Linux full
build lanes succeeded. Mac preparation's no-I/O readiness test failed as intended;
the subsequent owned-copy source still needs its own native GREEN/build receipt.

Requires Node/npm, Rust/Cargo and the native Tauri 2 prerequisites for the target
OS. The relay is built by the package's existing predev/prebuild hooks.

```sh
cd windows
npm ci
npm run tauri dev
```

Frontend-only preview (does **not** exercise native commands):

```sh
cd windows
./node_modules/.bin/vite --host 127.0.0.1
```

Synthetic inspector page: `/tests/agent-session-ui.html` on that server.
See [Windows/Linux setup](../windows/README.md) for native differences. Running
the real app can read configured integrations and install/update its relay;
use an isolated user/test setup when qualifying changes.

### macOS

Requires macOS 15+, Swift 6, Xcode and XcodeGen. Keep `project.yml` authoritative.

```sh
cd NotchBuddy
xcodegen
xcodebuild -scheme NotchBuddy -configuration Debug build
```

The App Store scheme is `CoucouAppStore`; its sandbox/feature set must be tested
separately. Never replace bundle IDs or signing accounts to bypass a build gate.

## Checks and scope

From the repository root with Node's native TypeScript support and Python 3:

```sh
bash scripts/test-agent-monitor.sh
bash scripts/test-agent-monitor.sh --require-platform-checks
```

The first runs portable adapter/privacy/relay/reducer checks, available frontend
build checks and available native tests. It explicitly prints pending lanes.
The strict variant currently exits nonzero because rich-runtime/native acceptance
is incomplete. That failure is deliberate and must not be converted into success
without real evidence. For native Rust/Swift prerequisites and fixture integrity,
use the precise commands in the agent receipt, not guessed global installations.

Initial monitoring/design checkpoint verification (2026-10-04, `5dc8e17`):

| Check | Observed result | What it does not prove |
| --- | --- | --- |
| Combined portable runner | PASS: 83 Node + 83 Python checks | Actual rich producer/runtime/native UI/lifetime acceptance |
| TypeScript + Vite | PASS | Windows or Mac build/installer correctness |
| Standard-PATH Cargo in runner | PENDING: unavailable | Prior task-local 27 native tests are historical evidence, not a fresh full workspace build |
| Swift/native inspector | PENDING | Mac compile, sandbox, UI or animation |
| Full platform gate | Incomplete by contract | Release readiness |
| Expansion spec coverage | 52 feature rows plus settings mapped | Implemented shelf/LocalSend/media/system/calendar |

The foundation runner is now implemented. From repository root:

```sh
bash scripts/test-notch-foundation.sh
bash scripts/test-notch-foundation.sh --require-native
```

Supply `RUSTC`/its command-local environment if Rust is not on PATH. Fresh detailed
results and disposable-toolchain invocations are in the
[foundation receipt](research/notch-foundation-verification.md). Strict native
acceptance still fails as required; unavailable lanes are never passed by a
browser fixture or a stale receipt file.

Both portable and strict commands were rerun for the source checkpoint. The
portable command exited 0; the strict command exited 1 with
`Required runtime/platform acceptance is incomplete`. The staged source tree
and inherited history were screened for high-confidence credential patterns;
none were found. That bounded screening is not a comprehensive security audit.

## Privacy and safe collaboration

- Agent observations are minimized, temporary and local: no transcript, raw
  arguments/results/errors, file contents/diffs, telemetry or activity history.
- New transfer authority applies only to selected files/text and the chosen peer;
  the planned transfer history is separate, opt-in and local.
- Private credentials, local runtime configuration, logs/recovery state and chat
  attachments never go into commits. Do not use `git add .` for checkpoints.
- Tests use synthetic temporary roots; do not run file-ingest tests against a
  real user's inbox or commit runtime payload captures.
- Preserve current Claude/Codex explicit approvals; new inspector observations
  never answer permissions. Existing settings/hook changes retain their separate
  review/backup rules.

## Git checkpoints and release

Development branch: `feat/notch-expansion` in
[`ATLAS-DEV78423/Infinite-Notch`](https://github.com/ATLAS-DEV78423/Infinite-Notch).
Upstream `origin` stays pointed at Coucou; the added target remote is
`infinite-notch`. Commit exact reviewed files with conventional messages, run
relevant checks, push without force and verify the remote branch's SHA.

No package binaries, GitHub release, signed artifact or release tag is part of
this checkpoint. Existing Windows publishing stays paused pending its signing/
Defender issue. Mac signing/notarization, App Store approval, asset permissions,
native hardware performance/accessibility and independent LocalSend device tests
remain gates. Keep copyright/license files and do not imply upstream endorsement.
