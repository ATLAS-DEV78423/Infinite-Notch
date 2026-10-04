# Notch Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (the user's preserved choice) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make full hover expansion and existing file preparation truthful, collision-safe and lifetime-owned on both native shells before adding the multi-item shelf.

**Architecture:** Extend the existing FSMs, settings and drop pipeline rather than replace them. Give each native copy and each UI preparation an operation identity; only the current live owner may publish readiness. Keep Mochi's gulp/grow choreography, but stop using elapsed animation time as proof of copying or uploading.

**Tech Stack:** Swift 6/Foundation/AppKit/SwiftUI; existing TypeScript/DOM/Tauri 2; Rust stdlib and existing dependencies; Node built-in tests and standalone Swift/Rust checks.

**Spec:** [approved expansion design](../specs/2026-10-04-notch-app-expansion-design.md), sections 3–5, 10–14. This is the first executable subsystem plan; [the release roadmap](../../NOTCH_ROADMAP.md) tracks the remaining work, including the existing inspector.

**Execution status:** Approved by the user on 2026-10-04. Tauri/Rust Tasks 1/3/5
have scoped implementations and portable/Linux verification; native acceptance
and Swift Tasks 2/4 remain pending. Task 6's runner/receipt is implemented, not
proof of native completion. See [the current receipt](../../research/notch-foundation-verification.md).

## Global Constraints

- Hover delay default 0, validated 0–1000 ms; hover-origin leave grace 300 ms.
- Protected keyboard/drag/approval interactions cannot be collapsed by a mouse-leave timer.
- Preserve explicit-open auto-close preference; retain existing stable pill/bundle IDs and card/Mochi styling.
- No synchronous copying, hashing or networking on UI threads.
- A timed animation cannot publish ready/completed; unknown progress is indeterminate.
- Originals and existing destinations are never deleted or overwritten.
- Reject symlinks/reparse points; cleanup is limited to owned operation directories.
- No new runtime dependency for this foundation; no telemetry, private-content logs, automatic sends or agent-data persistence.
- Preserve all prior dirty work. Native Mac/Windows checks unavailable here remain pending.
- Source checkpoints go to `infinite-notch`, branch `feat/notch-expansion`, with explicit path staging; never force push or publish app binaries.

## Review Focus

- A timer queued before pause/re-entry must not reopen/collapse a newer interaction: Tasks 1–2 timer-generation assertions.
- Releasing an inspector hold must not clear a pending approval or drag hold: Tasks 1–2 combined-owner assertions.
- A same-name file dropped concurrently must preserve both contents, including after nominal suffix exhaustion: Tasks 3–4 exclusive-directory assertions.
- Slow copy finishing after replacement/clear must not revive a file or change prompt context: Tasks 4–5 late-receipt assertions.
- Leaving a copy-owned view, sleep/wake or cancelling during completion must never reveal a fake checkmark or an unreadable ready path: Tasks 4–6 terminal/frame/native assertions.

## Current flow and scope

`IslandStateMachine.swift` and `windows/src/island/fsm.ts` currently reveal
compact on hover and open fully on click. Both shell transition handlers invoke
`mouseLeft()` before their cursor bookkeeping settles, so do not change the FSM
alone: update the input caller order and native wake-strip handling too.

`FileDropHandler.handle` copies in a detached task after removing a same-name
destination; its independent sleep sequence chooses a ready view without waiting
for copying. `Island.swallow` stores the original path, launches `Bridge.ingestFile`,
then lets `stepSequence` complete on a timer. `files::ingest` has a suffix race and
synchronous Tauri command; its test currently writes to the app inbox. Replace
these touched paths with isolated temporary-root checks, not live-user test data.

This milestone supports one regular-file preparation at a time, matching the
existing UI. Multiple items/folders/text and export leases belong to the next
shelf plan. Reject unsupported extra items explicitly rather than silently
dropping all but the first. Do not claim the full shelf or LocalSend is shipped.

---

### Task 1: Tauri hover ownership, settings and input integration

**Files:**
- Modify: `windows/src/island/fsm.ts`, `windows/src/island/island.ts` (FSM/input/countdown/settings only).
- Modify: `windows/src/core/state.ts` (`Settings`/defaults only), `windows/src-tauri/src/settings.rs`, `windows/src/settings/main.ts`.
- Test: create `tests/island-fsm.test.ts`; extend `windows/tests/agent-session-ui.ts` for composed input.

**Interfaces:**
- Keep current FSM inputs and `onTransition` signature.
- Add `hoverOpenDelayMs: number = 0`, `hoverLeaveDelayMs: number = 300` and `setHold(owner: 'approval' | 'inspector' | 'keyboard' | 'drag' | 'menu', held: boolean): void`.
- `held` is the union of owners. Route the current `pinned` and `setInteractionHold` callers through their corresponding owners; do not create a second conflicting source of truth.
- Persist `Settings.hoverOpenDelayMs`; native field `hover_open_delay_ms: u32` defaults to 0 and is clamped at 1000 before saving/applying. Existing settings files still deserialize.
- Internal FSM tracks pointer-inside, opening origin (hover/explicit) and timer generation; no new global timer service.

- [ ] **Step 1:** Add deterministic fake-window-timer Node tests named `hover_opens_full_after_delay`, `leave_cancels_delayed_open`, `reenter_cancels_300ms_collapse`, `explicit_open_keeps_autoclose`, `holds_are_independent`, `cancel_invalidates_queued_callback`. Assert hidden → home at 0/default and 250 ms/configured; leave at 249 ms never opens; hover leave stays home at 299 ms and folds at 300 ms; explicit open uses 15 s default; approval survives clearing inspector+drag. Manually invoke captured stale callbacks after cancellation and assert unchanged state.
- [ ] **Step 2:** Run `node --test tests/island-fsm.test.ts`; expect behavioral assertions to fail against compact-hover/current timer ownership, not only an import error.
- [ ] **Step 3:** Implement the declared FSM/settings interfaces. Set cursor-inside bookkeeping before transition callbacks; support wake-strip opening, hidden clicks, keyboard explicit open and pause/screen-change cancellation. Countdowns use the actual scheduled deadline. Focus within island controls, inspector interaction and live drag set distinct owners; losing one cannot release another. Add the delay control in existing Settings style. Reduced motion follows current OS preference without a new animation library.
- [ ] **Step 4:** Run `node --test tests/island-fsm.test.ts` and `(cd windows && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build)`. Extend the existing browser harness to assert approval/focus survive hover churn and ordinary data updates. A browser pass is not native animation qualification.
- [ ] **Step 5:** Review this task's diff and commit only its files with `feat: add protected full-hover expansion to the Tauri island`; attach exact pass/pending commands to the checkpoint documentation before pushing.

### Task 2: Swift hover ownership and settings parity

**Files:**
- Modify: `NotchBuddy/Sources/App/IslandStateMachine.swift`, `NotchBuddy/Sources/App/IslandWindowController.swift` (FSM/input/settings only), `NotchBuddy/Sources/App/AppState.swift` (hover preference only), `NotchBuddy/Sources/App/SettingsView.swift`.
- Create: `tests/IslandStateMachineTests.swift`, `scripts/test-island-fsm.sh`.

**Interfaces:**
- Keep existing `mouseEntered`, `mouseLeft`, `click`, external-sync and `onTransition` APIs.
- Add `hoverOpenDelayMs: Int = 0`, `hoverLeaveDelayMs: Int = 300`, `setHold(owner: HoldOwner, held: Bool)` with `HoldOwner` cases matching Task 1.
- Bridge existing approval predicate into the approval owner; do not retain an unsynchronized predicate plus a separate pin. UserDefaults key is `hoverOpenDelayMs`, default 0/clamped 0…1000.
- Add only a bounded test-time scheduler seam to the pure FSM if necessary: schedule accepts delay+closure and returns cancellation; production remains Dispatch main queue. No generic scheduler subsystem.

- [ ] **Step 1:** Add standalone `@MainActor` assertions with the six Task 1 names and boundary values, plus `external_open_and_hidden_sync_preserve_input`. A dispatched stale callback must check generation/state/hold even when cancellation raced execution. Use a fake queue for exact 299/300 ms assertions.
- [ ] **Step 2:** Run `bash scripts/test-island-fsm.sh` on a Swift runner; expect assertions to fail against compact hover. If Swift is unavailable, do not simulate this red/green with source grep; record the gate and defer executable Swift edits until a runner is supplied.
- [ ] **Step 3:** Implement the parity interfaces and wire controller pointer bookkeeping before callbacks, pending approvals, first-responder focus, native drag/menu holds and explicit close/open. Add the preference through existing AppState/Settings patterns. Preserve greeting completion semantics; old greet timers cannot fold a newer explicit open. Keep notchless geometry and click-through bounds intact.
- [ ] **Step 4:** Run `bash scripts/test-island-fsm.sh`, `bash scripts/test-screen-geometry.sh` and Xcode Debug builds of both existing schemes with signing disabled. Then exercise hover travel/keyboard/pending approval on actual notched and notchless Mac displays; record warnings/measurements and pending hardware cases.
- [ ] **Step 5:** Review/commit only this task's files with `feat: add protected full-hover expansion to the Mac island`; don't call parity complete until native checks run.

### Task 3: Native Rust copies with exclusive ownership and cancellation

**Files:**
- Modify: `windows/src-tauri/src/files.rs`, `windows/src-tauri/src/lib.rs` (copy commands/state/exit only), `windows/src-tauri/Cargo.toml` (existing native API feature flags only if needed).
- Create: `windows/src-tauri/src/file_copy.rs` (pure copy primitive), `tests/file-copy-rust.rs`, `scripts/test-file-copy.sh`.

**Interfaces:**
- `file_copy::copy_into(source: &Path, root: &Path, operation_id: &str, cancelled: &AtomicBool) -> Result<CopiedFile, CopyError>`; `CopiedFile { name: String, path: PathBuf, size: u64 }`; `CopyError` enumerates invalid source, denied, storage, cancelled, invalid operation, duplicate operation.
- `file_copy::discard(root: &Path, operation_id: &str) -> Result<(), CopyError>` removes only a registry-owned operation directory, never an arbitrary passed path. Validate IDs as 1–64 ASCII letters/digits/hyphens (frontend uses UUID text); root is native-selected private shelf-copy root, not frontend-controlled. An unregistered ID must not delete a directory.
- New Tauri `async fn prepare_file(path: String, operation_id: String, copies: State<'_, DropCopies>) -> Result<DroppedFile, String>` offloads to `spawn_blocking`; `fn cancel_file_copy(operation_id: String, copies: State<'_, DropCopies>)` revokes before removal. Keep the existing `ingest_file(path)` command as an async compatibility wrapper with a native-generated unique operation ID until Task 5 switches the frontend; never break the current drop path between commits. `DropCopies` owns IDs/cancel flags/completed roots; at most one preparing operation for this legacy flow, no eviction of leased ready files.
- Preserve `DroppedFile`'s current name/path/size fields; native returned path is usable only after full copy success. Controlled errors exclude raw paths/OS error text. Pause and application exit cancel workers; pagehide is not the only cleanup owner.

- [ ] **Step 1:** Add `concurrent_same_name_preserves_bytes`, `thousand_duplicates_do_not_overwrite`, `cancel_removes_only_owned_partial`, `failure_does_not_publish_ready`, `root_and_source_symlinks_rejected`, `invalid_or_reused_id_refused`. Use unique test roots under `/tmp/opencode`, synthetic files and 64 KiB copy chunks; never `settings::local_dir()`. Assert source and earlier destinations remain byte-identical and completed results belong to distinct exclusive directories.
- [ ] **Step 2:** Run `bash scripts/test-file-copy.sh`; expect the original ingest behavior to fail the reproduction of its collision/ownership guarantees. The script compiles a standalone `rustc --test` harness for the pure primitive; report missing toolchain, never install globally.
- [ ] **Step 3:** Exclusively create an operation directory (no check-then-create), open source without following symlinks/reparse points using native handle semantics, ensure a regular file, stream to its private partial and publish ready only after successful flush/rename within that owned directory. Reject a source mutation/length mismatch. Cancel checks run between chunks and before publish; serialize cancel/publish at the registry owner boundary. Existing legacy inbox files are left untouched; stop sweeping a general inbox during new operations. Add async commands and app-exit cleanup without logging contents or blocking the UI.
- [ ] **Step 4:** Run the standalone checks and `cargo test -p coucou --lib files::tests` with available task-local Cargo/library overrides; update old tests to isolated roots. Compile the Windows handle path on a Windows runner and exercise large/disk-full/cancel copy. A Linux pure-copy pass is not proof of Windows reparse handling or Tauri command scheduling.
- [ ] **Step 5:** Review/commit exact files with `fix: make native file preparation exclusive and cancellable`; document any unexecuted Windows/native gate before push.

### Task 4: Swift operation-owned copy and truthful readiness

**Files:**
- Modify: `NotchBuddy/Sources/App/FileDropView.swift`, `NotchBuddy/Sources/App/AppState.swift` (drop owner only), `NotchBuddy/Sources/App/AppDelegate.swift` (shutdown only), `NotchBuddy/Sources/App/UploadSequenceEngine.swift`, `NotchBuddy/Sources/App/UploadCanvasView.swift`, `NotchBuddy/Sources/App/IslandViewContent.swift` (local preparation display only), `NotchBuddy/Sources/App/IslandRootView.swift` (legacy time-derived progress only).
- Create: `NotchBuddy/Sources/App/FilePreparation.swift`, `tests/FilePreparationTests.swift`, `scripts/test-file-preparation.sh`.

**Interfaces:**
- `struct PreparedFile: Sendable { let operationID: UUID; let url: URL; let name: String; let size: UInt64 }`.
- `actor FilePreparation` with `prepare(source: URL, operationID: UUID) async throws -> PreparedFile`, `cancel(operationID: UUID) async`, `shutdown() async`; actor owns native-selected root and task handles. Blocking reads run on an owned worker, not the actor/UI executor. Use Foundation/native file handles and security-scoped access when granted.
- AppState has current drop UUID and preparation disposition (preparing/ready/failed); original URL is not placed in ready/chat context. Only matching current noncancelled UUID publishes `DroppedFile` and `.file` prompt context.
- `UploadSequenceEngine.finishPreparation(success: Bool)` unlocks success/grow only after actual result; pending frames show indeterminate preparation and no completion/choose. It consumes state, not guessed byte counts.

- [ ] **Step 1:** Add copy assertions equivalent to Task 3 and `slow_copy_has_no_ready_context`, `replaced_drop_ignores_old_completion`, `cancel_and_shutdown_clear_tasks`. Add frame assertions `pending_after_ten_seconds_has_no_check_or_choose`, `failed_has_no_success`, `success_after_real_completion_grows_once`. Retain gulp/shrink geometry comparisons against current normal-flow constants.
- [ ] **Step 2:** Run `bash scripts/test-file-preparation.sh` on a Swift runner; expected failure demonstrates same-name deletion/fake-ready/late callback. As in Task 2, defer executable Swift edits if the required runner is absent.
- [ ] **Step 3:** Implement declared interfaces, exclusive per-operation roots, no-follow regular-file reads, short chunked copy with cancellation and atomic owned publish. Await real preparation result in `FileDropHandler`; no unowned detached copy or swallowed errors. Replace time-based ticks/success with guarded lifecycle, clear busy state on each terminal result and application termination. Repeated drop cancels previous preparation; unsupported multiple/folder/text input reports not-yet-supported rather than appearing to succeed. Preserve selected original and existing legacy inbox data.
- [ ] **Step 4:** Run standalone copy/frame checks and unsigned Debug builds of both Mac schemes. Native slow/cancel/duplicate drop and sandbox permission checks must leave originals intact and never show success before ready. Verify existing Mail/Ask actions are disabled until ready and remain explicit sends.
- [ ] **Step 5:** Review/commit exact files with `fix: tie Mac drop readiness to owned file preparation`.

### Task 5: Tauri copy receipts and canvas state, composed with hover

**Dependencies:** Tasks 1 and 3. Run after Task 1, not concurrently in its island/state files. Task 4 can proceed in its separate Mac files when native access exists.

**Files:**
- Modify: `windows/src/core/state.ts`, `windows/src/core/bridge.ts`, `windows/src/island/island.ts` (drop/sequence lifecycle), `windows/src/main.ts`, `windows/src/upload/sequence.ts`, `windows/src/upload/canvas.ts`, `windows/src/views/upload.ts` (preparation text/controls only).
- Create: `windows/src/core/file-preparation.ts`, `tests/file-preparation.test.ts`.
- Test: extend `windows/tests/agent-session-ui.ts` for deferred copy/cancel while inspector/approval is open.

**Interfaces:**
- `type Preparation = { id: string; name: string; state: 'preparing' | 'ready' | 'failed'; file?: DroppedFile; error?: 'storage' | 'denied' | 'invalid' }`.
- Pure `FilePreparation.begin(id: string, name: string): void`, `complete(id: string, file: DroppedFile): boolean`, `fail(id: string, error: NonNullable<Preparation['error']>): boolean`, `clear(): void`; `current: Preparation | null`. The model owns no paths before ready; handlers ignore wrong/old IDs. Keep this single-file owner, not an abstract transfer framework.
- `Bridge.ingestFile(path: string, operationId: string): Promise<DroppedFile>` now calls Task 3's `prepare_file` command with `{ path, operationId }`; `cancelFileCopy(operationId: string): Promise<void | null>` calls `cancel_file_copy`. Arguments match Tauri's camelCase mapping. Native cancellation is sent whenever current preparing owner is replaced/cleared; stale success is discarded natively by operation ID. Remove the old compatibility command only after all callers are migrated and tests pass.
- `UploadSeq.finishPreparation(success: boolean): void` matches Task 4 behavior; all frame/tick/choose consumers use disposition rather than elapsed upload duration. Keep existing sequence choreography, but label local work `Preparing file…` and `Ready`, never claim a network upload.

- [ ] **Step 1:** Add `late_copy_cannot_replace_new_drop`, `clear_and_pause_reject_completion`, `failure_leaves_no_prompt_path`, `only_ready_file_can_be_asked_or_shared`, `pending_sequence_never_checks`, `success_grows_once`. With a deliberately unresolved copy promise, advance ten seconds and assert no ready path, completion mark, completion sound or choose actions. Resolve A after starting B: only B can become current/ready. Reject B: controlled error, no raw path/error text.
- [ ] **Step 2:** Run `node --test tests/file-preparation.test.ts`; expected behavioral failures against the existing timed sequence/unconditional promise handler.
- [ ] **Step 3:** Implement the interfaces and integrate `swallow`, cancellation/back/pause/pagehide, bridge receipt, state notification and canvas display. Clear/supersede old ownership before awaiting native work; avoid callbacks changing a newer view. Transfer-copy cancellation is a native command, not merely ignored UI results. One-off error-recovery timeouts are cancelled or generation-guarded too. Do not publish original path into chat while copying, and do not send anything automatically. Explicit ask/share uses the leased ready native copy. Multi-item input is honestly rejected until shelf support.
- [ ] **Step 4:** Run `node --test tests/island-fsm.test.ts tests/file-preparation.test.ts`, TypeScript/Vite build and portable agent suite. Exercise the existing browser harness with injected deferred bridge promises, not fabricated native receipts; record that distinction. Then native Tauri slow-copy/hover/approval/cancel test on Windows.
- [ ] **Step 5:** Review/commit exact files with `fix: prevent stale and timed Tauri drop completion`; checkpoint docs list actual native/pending checks.

### Task 6: Foundation verification receipt and documented checkpoint

**Dependencies:** Review available completed tasks; missing native tasks stay pending, not checked off.

**Files:**
- Create: `docs/research/notch-foundation-verification.md`, `scripts/test-notch-foundation.sh`.
- Modify: `docs/DEVELOPMENT.md`, `docs/NOTCH_ROADMAP.md` status/receipt links only.

**Interfaces:**
- `bash scripts/test-notch-foundation.sh` runs portable FSM/preparation/copy checks and relevant build checks; exits nonzero on an actual failing executed check.
- `bash scripts/test-notch-foundation.sh --require-native` also requires real Mac/Windows native receipts; missing tools/receipts make the strict gate fail, not a synthetic pass. Receipt records command, commit, platform, result and scope without private payloads.

- [ ] **Step 1:** Add runner assertions: invalid flags exit 2; injected failed test yields failure; unavailable Swift/Windows with strict flag exits 1; available passing portable checks exit 0 but print pending native tasks. Do not infer a current native receipt merely from presence of a stale file.
- [ ] **Step 2:** Run the failing runner checks before implementing the composition script.
- [ ] **Step 3:** Wire existing/new smallest checks and write truthful receipt. Reuse available task-local toolchain/library setup; never repeat already completed inspector prerequisite work or change global tooling/accounts. Run central combined-diff review against spec and privacy boundaries; fix actual findings before proceeding.
- [ ] **Step 4:** Run `bash scripts/test-notch-foundation.sh`, strict variant and `bash scripts/test-agent-monitor.sh`; obtain real native checks before marking foundation complete. Measure actual Mac/Windows pointer/key feedback/frame times against spec; browser mock motion is not a measurement receipt. Full release remains blocked by remaining roadmap milestones.
- [ ] **Step 5:** Commit `test: document foundation regression and native acceptance gates`; push reviewed commits with `git push infinite-notch HEAD:refs/heads/feat/notch-expansion`, then compare local HEAD with `git ls-remote infinite-notch refs/heads/feat/notch-expansion`. No force, tag, app binary or release upload.

## Execution batches and review

1. Review this plan with the user. Their prior choice is bounded subagent-driven
   implementation; preserve it. No new-scope code starts before plan review.
2. First independent batch: Task 1 Tauri hover and Task 3 Rust copying (disjoint
   files). Native Swift tasks are not faked while runner access is absent.
3. Controller reviews each actual diff and runs combined checks. Task 5 follows
   the approved Task 1/3 contracts; don't let two workers write island/state files
   simultaneously. Tasks 2/4 may use a native Mac lane sequentially because they
   share AppState/controller ownership. Do not spawn review/research workers merely
   to meet activity counts.
4. Task 6 records completed and blocked paths and publishes a feature checkpoint,
   not a release claim. Each commit includes its real documentation receipt.

## Plan self-review (2026-10-04)

- Coverage: expansion foundation sections 4/5/10/13 are owned above. All remaining
  52-feature obligations stay mapped in the approved master design and roadmap;
  this plan does not implement their unfinished subsystems.
- Interfaces: Swift and TypeScript hover units are milliseconds at settings
  boundary; native copy IDs match bridge camelCase mapping; both sequence owners
  gate success on real preparation. Existing public drop result fields stay intact.
- Ownership: Tasks 1/3 can run in parallel. Tasks 1/5 and 2/4 are sequential where
  they share files. Native cleanup and frontend stale-receipt guards are both
  required; either alone is insufficient.
- Every Review Focus failure has named assertions in its owner task. Missing
  native compiler/device availability is a stop condition, not a test exemption.
- Plan status: **approved and partially executed**. Do not redispatch the reviewed
  Tauri/Rust source tasks; finish native acceptance and pending Swift work.
