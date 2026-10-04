# Notch foundation — verified checkpoint and remaining gates

Updated 2026-10-04. **Partial foundation implementation, not native parity or
release qualification.** [Approved plan](../superpowers/plans/2026-10-04-notch-foundation.md)
and [full roadmap](../NOTCH_ROADMAP.md) define the remaining obligations.

Implementation revisions: `e5546e3` (native copy/lifetime/Linux cleanup) and
`44847ca` (Tauri hover, preparation UI and regression fixtures). This receipt and
the composition runner accompany the subsequent documentation checkpoint.

## Implemented and centrally reviewed

- Tauri full hover expansion: default immediate, 0–1000 ms setting, 300 ms leave
  grace, explicit-open auto-close, actual countdown deadline and independent
  approval/inspector/keyboard/drag/menu owner inputs. Greeting/compact timers
  honor those owners too; replaced callbacks are invalidated.
- Ordinary reduced-motion geometry/decorative-loop control, keyboard wake and
  existing inspector/approval behavior are exercised synthetically. Native drag
  session termination, screen change/focus and menu delivery remain unqualified.
- Native Rust preparation streams into exclusive operation directories, never
  a same-name existing inbox entry. No-follow/native handles, controlled errors,
  per-operation cancellation, shutdown ownership, source-change detection and
  no-overwrite publication have Linux execution evidence.
- New `prepare_file` / `cancel_file_copy` IPC fields match the frontend; the
  path-only `ingest_file` compatibility wrapper remains. Native cancellation can
  retire a valid unseen ID before asynchronous admission without gaining any
  cleanup authority. Operations/retirement cap at 4096, fail closed under pressure
  and never evict live ready state; the current flow admits one preparing worker.
- Tauri readiness uses the current native receipt only. Original paths are not
  published as ready chat context. Pending work stays indeterminate; no elapsed
  timer generates percent, success, chime or Choose. Stale success/failure,
  recovery timers, replace/clear/pause/pagehide and one latest queued selection
  are bounded and guarded. Cancelling acknowledges revocation, not termination;
  next admission waits for both old work and cancel to settle.
- File-drop paths cannot replace a real pending agent approval. Aborted drag
  previews preserve the existing ready file, chat, unsent draft/context and actions.
  Unsupported multiple paths are visibly rejected, not silently accepted. A valid
  replacement alone supersedes the previous selection.
- The existing sequence already capped historical catch-up to two seconds.
  A twelve-hour suspension regression now protects that behavior; no new
  performance optimization or hardware frame-time measurement is claimed.

No new runtime dependency, telemetry, automatic chat/file send, private-content
logging or global agent/account configuration change was added. This is still
one regular-file selection, not a multi-item shelf or LocalSend implementation.

## Linux crash cleanup boundary

Recognized abandoned copy operations are reaped on next startup. Cleanup uses
fixed 72-byte private versioned markers containing filesystem identities only:
root, operation directory, content and marker device/inode pairs. They hold a
native exclusive nonblocking lease while preparing/ready. No source path,
filename, size, shelf row/history, agent content, PID or timestamp is saved in
that record. Its authority is deletion of identified owned temporary data only;
it cannot restore display state.

Enumeration is limited to 4096 entries in the native-selected private copy root,
anchored to held Linux descriptors. Live owners, unknown/pre-marker data,
substituted/symlink/hard-linked entries, malformed/copied markers and extra foreign
files are preserved. No recursive/general inbox/downloads sweep exists. Missing
procfs, invalid ownership or scan pressure fails closed. Actual subprocess death,
active leases and restart cleanup were tested with synthetic files.

**Limits:** a crash before a durable ownership record can leave an unidentified
partial; it is preserved rather than guessed. Same-UID hostile inode/name races,
network filesystems and power-loss durability are not comprehensively certified.
Windows restart reaping is explicitly unsupported/unimplemented, not inferred
from Linux. Windows handle code is authored but remains uncompiled/unexecuted.
Ready native copies stay owned until explicit disposal/exit; UI clearing must not
guess they are unleased. Export/transfer leases and full eviction belong to shelf
work. Cooperative cancellation cannot interrupt an indefinitely blocked kernel
read/flush; normal shutdown waits off the UI executor.

## Fresh controller checks

All fixtures are invented; no user session/file/account payload capture is used.
Commands are from repository root unless the row says `windows/`.

| Check | Observed result | Evidence scope |
| --- | --- | --- |
| `node --test tests/*.test.ts` | 81 pass | 58 inspector + 13 FSM + 10 preparation checks |
| `node --test tests/foundation-runner.test.mjs` | 3 pass | Actual composition-script flag/error/native-gate behavior with external executables substituted |
| `bash scripts/test-file-copy.sh` with compiler environment below | 22 pass | Linux regular-file/cancel/collision/ownership/crash subprocess checks |
| `cargo test -p coucou --lib --offline --locked` in `windows/` with environment below | 29 pass | Actual Linux app-library/commands/settings/copy/receiver test target |
| `cargo test -p coucou-hook --offline --locked` in `windows/` with task-local Cargo | 10 pass | Actual separate relay test target |
| `bash scripts/test-agent-monitor.sh` | 83 Node + 83 Python pass; TypeScript/Vite pass | Existing portable regression; absent standard-PATH Cargo and native UI/rich/lifetime lanes explicitly pending |
| `bash scripts/test-notch-foundation.sh` with supplied compiler | Available checks pass | New FSM/preparation/runner + standalone copy + TypeScript/Vite; no inferred native completion |
| Same with `--require-native` | Exit 1 as required | Missing actual Mac/Windows acceptance blocks the milestone |
| Synthetic Chromium production-handler/canvas harness | 136 normal / 138 reduced-motion checks pass, 0 FAIL, passed markers | Deferred IPC fixtures/manual frame drive; not real Tauri receipts, OLE/native motion or accessibility |
| `bash -n` for new scripts; `git diff --check` | Pass | Shell syntax/whitespace only |

The original collision/suffix-exhaustion tests failed before the native fix.
Additional observed red checks exposed timer holds, missing crash cleanup,
cancel-before-admission, fake timed canvas completion, approval replacement,
invisible Choose controls and destructive aborted-preview behavior. Those actual
behavior regressions were fixed and rechecked; no source-grep test is passed off
as executable product evidence.

## Reproduce without global changes

With ordinary installed Rust/Node and existing frontend lockfile dependencies:

```sh
bash scripts/test-notch-foundation.sh
bash scripts/test-notch-foundation.sh --require-native
bash scripts/test-agent-monitor.sh
```

The strict command currently **must fail**. The runner does not accept a stale
Markdown receipt or browser fixture as native acceptance. Missing compiler/build
lanes are explicitly reported. An executed check failure always propagates.

For the already prepared disposable compiler on this workstation, supply the
environment explicitly; public scripts contain no workstation runtime paths:

```sh
RUSTUP_HOME=/tmp/opencode/coucou-qualification-wzd3y1yh/rustup \
CARGO_HOME=/tmp/opencode/coucou-qualification-wzd3y1yh/cargo \
RUSTC=/tmp/opencode/coucou-qualification-wzd3y1yh/cargo/bin/rustc \
TMPDIR=/tmp/opencode bash scripts/test-notch-foundation.sh
```

Cached Linux native library lane (no full static archive or dependency/profile
rebuild; keep these overrides command-local):

```sh
cd windows
PATH=/tmp/opencode/coucou-qualification-wzd3y1yh/cargo/bin:$PATH \
RUSTUP_HOME=/tmp/opencode/coucou-qualification-wzd3y1yh/rustup \
CARGO_HOME=/tmp/opencode/coucou-qualification-wzd3y1yh/cargo \
CARGO_TARGET_DIR=/tmp/opencode/coucou-qualification-wzd3y1yh/cargo-target \
LIBRARY_PATH=/tmp/opencode/coucou-qualification-wzd3y1yh/native-libs/usr/lib \
LD_LIBRARY_PATH=/tmp/opencode/coucou-qualification-wzd3y1yh/native-libs/usr/lib \
CARGO_BUILD_JOBS=2 TAURI_CONFIG='{"bundle":{"resources":[]}}' \
cargo test -p coucou --lib --offline --locked
```

Synthetic UI: run the existing Vite server in `windows/`, open
`/tests/agent-session-ui.html` and require its passed results marker, not just
Chromium process exit 0. Fresh controller normal/reduced runs used separate
synthetic profiles and a temporary local server which was stopped afterwards.

## Still required

Swift foundation Tasks 2/4 need an actual compiler/Xcode lane; no untested parity
implementation is claimed. Windows native compilation, reparse/rename/delete,
restart cleanup, OLE drag/attachments, real disk-full/permission-loss, focus,
pause/quit/sleep, sandbox, VoiceOver/Narrator and hardware frame/idle/input targets
remain pending. Full native archive packaging is not proved by separate tests.

Multi-item shelf, folders/images/text, native export/share, LocalSend, expanded
media/system/calendar and rich agent acceptance remain on the roadmap. Signing,
Defender clearance and asset-rights gates are unchanged. This source checkpoint
does not authorize or establish a packaged release.
