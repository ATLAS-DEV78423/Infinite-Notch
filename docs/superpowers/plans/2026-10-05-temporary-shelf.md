# Temporary Shelf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax; controller assigns exact disjoint implementation scopes and integrates shared files sequentially.

**Goal:** Turn the single ready-file flow into a bounded temporary multi-item shelf with safe cancellation, native open/export/share and working Mac Mail/Messages actions.

**Architecture:** Reuse `FilePreparation` and Rust `DropCopies`/`file_copy`, adding a native shelf registry and explicit leases rather than a second copy engine. Pure shell models contain item/asset identities and current display state, not authority to delete a path. Preserve the existing Drop tab/card and Mochi choreography.

**Tech Stack:** Existing Swift 6/Darwin/AppKit, TypeScript/DOM/Tauri, Rust stdlib/current Windows API crate and native dialogs. No shelf database, cloud service or framework migration.

**Spec:** [Expansion sections 5, 10, 13](../specs/2026-10-04-notch-app-expansion-design.md); [remaining-feature map](2026-10-05-remaining-features.md).

**Status:** User approved this written plan, including proposed text/image bounds, on 2026-10-05 through “Approve and continue”. S1a tests-first execution has started; no shelf/native-consumer completion is inferred. Native foundation build/tests passed at `76b4ee2`; real device and restart/export safety are additional shelf gates.

## Global Constraints

- At most 32 items. Defaults: enabled, original arrival order, memory-only rows; newest-first preference is independently persisted.
- Files/folders/dropped images/text/links are explicit inputs; dropping never opens, runs, chats, mails or transfers them automatically.
- Folders: 4096 entries, depth 64, safe relative hierarchy and empty directories; reject symlinks/reparse roots/ancestors/entries. Whole failed item has no ready partial tree.
- Originals, foreign copies and committed received files survive remove/clear/disable/exit. Native registry IDs, never frontend paths, authorize cleanup.
- Native serial preparation queue; no UI-thread copy/hash. Unknown byte progress is indeterminate; only matching live receipts become ready.
- Queue capacity is the remaining 32 admitted row slots, not another unbounded channel; one active worker per native shelf owner. Existing 4096 retired-operation pressure remains fail-closed until its native lifetime design is reviewed.
- Leases protect files while native consumers/transfers use them; row removal revokes display ownership before cancellation, not lease ownership.
- Existing approvals/questions block drag-preview replacement; aborted previews preserve ready selection, prompt/chat and Mail draft.
- No new persistence for shelf content; minimal crash ownership identity/lease markers may authorize cleanup but never reconstruct rows/history.
- Proposed admission bounds for review: one text/link item at most 1 MiB UTF-8; one dropped encoded image at most 16 MiB and 16 million decoded pixels. Reject explicitly, never truncate silently. These are new safety defaults, not copied feature-list requirements.

## Review Focus

1. A batch reaches capacity midway: accept first available slots in original order and report each rejected original index, never replace existing rows (S2).
2. Folder traversal meets a symlink, 4097th entry or depth 65: refuse the item, preserve originals/foreign entries, remove only owned partial tree (S1).
3. Remove/quit during export or Mail attachment read: retain leased native asset until actual lifetime completion; arbitrary grace timers are not proof (S3).
4. Crash marker/root substitution or an unrecognized old directory: preserve foreign data; reaping cannot restore shelf/UI content (S1).
5. Old copy finishes after clear/disable and a new item uses the same display name: old item cannot revive or alter the new one; ordinary updates cannot displace an approval (S2).

## Interfaces and ownership

Use UUID item, operation, asset and lease IDs. Mac native IDs use `UUID`; Rust stores validated UUID text and sends strings; UI never derives a filesystem path from an ID.

- `ShelfItem { id, generation, kind: file|folder|image|text|link, name, state: preparing|ready|failed, assetId?, size?, error? }`; no ready `assetId` before success. Received references also carry `ownership: received`, whose registered directory grant is not a temporary-copy delete right.
- `admit(inputs)` returns `{accepted: [{index,itemId}], rejected: [{index,reason}]}`; reasons include disabled/capacity/limit/invalid/denied/storage. Each original batch index has exactly one result.
- Native `prepare(itemId, operationId, selectedInput)` yields a registered `ShelfAsset {assetId, itemId, operationId, kind, name, size}`. File paths stay native except compatibility ready-chat receipts where the existing action requires them.
- Native `acquire(assetId,purpose: drag|share|mail|transfer)` yields `leaseId`; `release(leaseId)` is idempotent and only closes that registry lease. `remove(itemId)` cancels preparing work, removes the row, marks ready asset disposal pending, and waits for its last lease before deletion.
- `setEnabled(false)` and `clear()` invalidate all row generations, cancel queued/active preparation and request native owned disposal. They do not delete registered received-file references. `setNewestFirst(bool)` changes projection, not IDs/native order or selected asset.
- Tauri commands: `shelf_admit`, `shelf_cancel`, `shelf_remove`, `shelf_clear`, `shelf_set_enabled`, `shelf_open`, `shelf_begin_export`, `shelf_share`; use `itemId`/`assetId` at the boundary. Native code—not JS—starts/ends OS leases. No public arbitrary `delete_path` or generic shell command.
- Mac `ShelfStore` is MainActor display owner; `FilePreparation` retains native workers/assets. `ShelfActions` is AppKit action/lease owner. `AppState` delegates rather than duplicates row state.

### Exact file scopes

| Task | Mac | Tauri/Rust |
| --- | --- | --- |
| S1 storage | Modify `FilePreparation.swift`; tests `FilePreparationTests.swift`; new `ShelfStorageTests.swift`, `scripts/test-shelf-storage.sh` | Modify `file_copy.rs`, `files.rs`; create `shelf.rs`, `tests/shelf-storage-rust.rs`, `scripts/test-shelf-storage-rust.sh` |
| S2 model/UI | Create `ShelfStore.swift`, `ShelfView.swift`, `tests/ShelfStoreTests.swift`, `scripts/test-shelf-store.sh`; integrate AppState/drop/view/controller/settings only | Create `core/shelf.ts`, `views/shelf.ts`, `tests/shelf.test.ts`; integrate state/bridge/island/views/layout/settings/CSS; extend `windows/tests/agent-session-ui.ts` |
| S3 native actions | Create `ShelfActions.swift`, `tests/ShelfActionsTests.swift`; modify AppDelegate/project entitlements only where actual APIs require | Create `shelf_actions.rs`; modify `platform/windows.rs`, `platform/mod.rs`, native feature flags/capabilities and `lib.rs` only for registered actions |

All Mac names above live under `NotchBuddy/Sources/App/` unless prefixed `tests/` or `scripts/`; TS names under `windows/src/`; Rust names under `windows/src-tauri/src/`. Controller alone wires shared `lib.rs`, settings and native workflows after worker contracts pass.

### S1: Native storage, leases and recognized restart cleanup

**Consumes:** Existing no-follow copy/UUID/cancel primitives and the actual native lanes. Preserve single-file compatibility callers until S2 migration is verified.

**Produces:** Native `prepare/acquire/release/remove/shutdown` registry contract above. Ready files/folders/encoded image/text assets all have the same lifetime ownership; received-reference deletion is never admitted.

Execute S1 as three successive independently reviewed subtask pairs: **S1a** registered regular-file assets/leases/cancel; **S1b** folder and bounded materialized image/text ingest; **S1c** platform restart identity/lease cleanup. Each has its own RED/GREEN/commit. The first two-agent batch owns S1a only, not the entire storage/lease/reaper surface. S2 waits for all required storage contracts; an unsupported cleanup design stays a named blocker.

- [ ] Add real owned-root tests `folder_preserves_empty_hierarchy`, `folder_4097_or_depth_65_refused`, `symlink_and_reparse_tree_refused`, `same_name_batches_never_overwrite`, `remove_waits_for_last_lease`, `unknown_lease_has_no_cleanup_authority`, `crash_reaps_only_identity_matched_unleased_copy`, `cancel_before_admission_stays_cancelled`.
- [ ] Before implementation, observe the folder/lease assertions fail against current regular-file-only owners on the corresponding native runner. Missing APIs/compiler alone do not establish the old safety bug; retain existing baseline assertions.
- [ ] Extend existing workers to an explicitly bounded serial queue. Walk descriptor-relative tree entries without following links; stream regular files in 64 KiB chunks, track actual totals and revalidate selected/root/output identities before returning a usable asset. Preserve native no-overwrite atomic publication; never use suffix exhaustion or path-check-then-recursive-delete.
- [ ] Store exact registered cleanup entries and reference-counted opaque leases at the native owner. Cancel/remove shares the publish owner boundary. A lease cannot be released by an unrelated row/generation. Document native consumer completion evidence before admitting a purpose.
- [ ] Implement Mac/Windows recognized crash cleanup after actual identity/lease probes: bounded private root enumeration, 4096 inspected entries, no-follow fixed identity markers, live native lease, no content/source/display metadata. Reuse Linux's existing reaper where applicable. Crash-before-marker/unknown/substituted entries stay preserved; an unresolved platform design blocks cleanup qualification rather than expanding delete authority.
- [ ] Mac cleanup scans only a dedicated validated app-private shelf container beneath the canonical OS temp base, never the general Darwin temp directory or existing random foundation roots. Windows scans only its native-selected private shelf root. Previously unmarked foundation/legacy data stays untouched. Live and abandoned ownership are distinguished with qualified native leases before any cleanup.
- [ ] Verify focused native storage runners, existing copy tests, actual subprocess abnormal death, both Mac schemes and Windows/Linux app workspace/full builds. Then native permission-loss/disk-full/reparse/parent-swap cases. Record each platform separately.
- [ ] Controller reviews exact task files; commit `feat: add bounded native shelf assets and export leases`. Do not mark S1 complete until required native ownership tests pass.

Minimal lease assertion, run against the real owner rather than a mock:
```text
asset = prepare(syntheticFile); lease = acquire(asset.id, drag)
remove(asset.itemId); assert(nativeReadable(lease) && !displayContains(asset.itemId))
release(lease); assert(!ownedCopyExists(asset.id) && originalBytesUnchanged())
```

### S2: Bounded multi-item model and both real shelf views

**Consumes:** S1 receipts and native cleanup authority. Single-item FilePreparation remains a compatibility action only while migration is incomplete.

**Produces:** The 32-item `ShelfItem` store, explicit batch admission, selected-ready action state, enabled/order preferences and received references; both native Drop views read the same lifetime semantics.

Execute **S2a** pure store/admission/generation tests before **S2b** platform input/view wiring, then **S2c** shared settings/approval/lifetime integration. Each subtask has a separate reviewable behavioral result; no worker receives all shell files at once.

- [ ] Add `thirty_third_item_reports_index`, `batch_never_drops_silent_tail`, `late_copy_after_remove_never_revives`, `disable_cancels_queue_not_active_lease`, `newest_first_preserves_selection`, `text_and_image_limits_are_explicit`, `received_reference_clear_preserves_file`, `approval_blocks_preview_not_other_rows`.
- [ ] Observe pure/model RED using `node --test tests/shelf.test.ts` and the new real Swift `scripts/test-shelf-store.sh`; test original capacity/receipt behavior, not source wording. DOM fixture checks actual stable nodes/keyboard state.
- [ ] Implement native input admission before allocating/copying: materialized user drops only, file/folder selection, bounded UTF-8 text and encoded image decoding. No general pasteboard polling, implicit clipboard imports or URL fetches. Text/link native assets are explicit `.txt` payloads; links are not automatically opened. New input preferences/limits require the reviewed defaults above.
- [ ] Implement shell stores with item+generation correlation; UI paths cannot decide cleanup. Key rows by stable IDs, retain selection/focus/scroll on 4 Hz progress batches, and show per-item preparation/failure plus clear capacity messages. Ready-only native actions stay disabled otherwise.
- [ ] Extend existing Drop tab into shelf, retaining upload gulp as decorative feedback for the accepted item. Aborted drag preview never snapshots or destroys existing chat/draft/context. Existing approval/question owner retains priority. Add keyboard open/remove/reorder and accessible state labels.
- [ ] Reuse the current Drop card/window dimensions with a scrollable keyed shelf list; do not repurpose the 640×280 inspector exception or enlarge/rewrite unrelated views. Test the 32-row list with keyboard focus/scroll retained after reorder and incoming receipts.
- [ ] Persist only `shelfEnabled` (true) and `shelfNewestFirst` (false); old native settings/UserDefaults load these defaults. Never persist rows/asset paths or text. Register received-file references only from a trusted native committed-transfer receipt, not arbitrary frontend paths.
- [ ] Verify Node/Swift store checks, TS/Vite, normal/reduced-motion composed DOM fixtures and all native builds. Native Mac/Windows multi-drop/cancel/approval/disable cases remain required even with green fixtures.
- [ ] Controller integrates shared files serially, commits `feat: add temporary multi-item shelf to both native shells`, and records actual/pending evidence.

Example admission boundary:
```text
store contains 31 rows; admit([A,B,C])
assert(acceptedIndexes == [0] && rejectedCapacityIndexes == [1,2])
assert(rowCount == 32 && allOriginalRowsStillPresent())
```

### S3: Native open, real drag-out, system share and Mac Mail/Messages

**Consumes:** Registered ready asset IDs and native leases; selected originals and received-reference grants remain native-owned.

**Produces:** `open(itemId)`, native export/share actions and consumer-confirmed lease release. `acquire(assetId,transfer)` becomes the only LocalSend ready-source seam; this task does not implement transfers.

Execute **S3a** explicit ready-native open, **S3b** real drag-out plus consumer lease, then **S3c** system share/Mail/Messages and termination ownership. Share implementations wait for actual consumer-lifetime evidence; S3a does not authorize S3c implicitly.

- [ ] Add actual native action tests `open_rejects_nonready_or_unknown_id`, `native_drag_payload_is_file_not_text`, `row_remove_during_export_keeps_asset`, `quit_waits_for_drag_owner`, `share_cancel_releases_only_own_lease`, `received_open_has_no_delete_authority`. Use synthetic owned paths/receipts, not real inbox data.
- [ ] Verify RED against current absent drag-out/share or lifetime behavior using native tests plus a recipient harness; a source enum test alone cannot establish a usable file drag.
- [ ] Mac: AppKit file URL/file promise export and NSWorkspace explicit open; supported NSSharingService/AirDrop/Mail/Messages callbacks. Windows: existing OLE/native shell integration with real file-drop data and supported desktop share invocation after capability qualification. No shell interpolation or text-path payloads. Linux preserves existing behavior; unsupported sharing is explicit and not substituted for Windows proof.
- [ ] Validate asset and current native grant at action time, acquire lease before OS handoff, and retain identity through native completion. If a consumer callback does not prove the read is finished, use a separately materialized native attachment with proven ownership/lifetime; do not release based on elapsed time. Report unsupported lifetime/platform contracts before enabling the action.
- [ ] Preserve explicit upstream Mail send behavior; no automatic sending. Multi-item attachment failure is visible, not silently sent without the selected item. Quit cancels preparation/transfers and waits actual active export owners; committed received files are never swept.
- [ ] Exercise Finder/Explorer plus Mail or another actual supported attachment consumer: drop, verify exact bytes, remove shelf row mid-consumption, cancel, close, repeat, then quit/upgrade. Record native access-denied and sandbox file-grant behavior. Test keyboard/screen-reader equivalents and multi-monitor scaling.
- [ ] Controller reviews lease callbacks and native authority; commit `feat: add leased native shelf open drag and sharing`. Native share/OLE/consumer gates cannot be checked off from build success.

## Integration and execution handoff

### Exact verification entrypoints

| Slice | Command introduced/run by its owner | Passing evidence |
| --- | --- | --- |
| S1 Mac storage | `bash scripts/test-shelf-storage.sh` and `bash scripts/test-file-preparation.sh` | Actual owned-root Swift/Darwin assertions, including real crash subprocess, pass |
| S1 Rust storage | `bash scripts/test-shelf-storage-rust.sh`, `bash scripts/test-file-copy.sh`; in `windows/`: `cargo test -p coucou --lib --locked` | Standalone pure storage harness and native app registry tests pass; platform-only cases separately observed |
| S2 Mac model | `bash scripts/test-shelf-store.sh` | Pure real shelf owner rules pass in Swift 6, not a mock AppState |
| S2 TS/model/UI | `node --test tests/shelf.test.ts`; in `windows/`: `npm exec -- tsc --noEmit` and `npm run build` | Nonzero failures propagate; browser harness passed marker and no failed DOM assertions |
| S3 Mac actions | Add `scripts/test-shelf-actions.sh` compiling `ShelfActionsTests.swift` against native action owner | Real native lease/action routing tests pass, plus separately recorded Finder/Mail/share consumer run |
| S3 Windows actions | in `windows/`: `cargo test -p coucou --lib shelf_actions::tests --locked` | Native OS payload/action owner tests pass, plus separately recorded Explorer/attachment/share consumer run |
| All native builds | Existing `Native macOS qualification` and `Native Tauri qualification` workflows, extended with real new runners | New exact SHA, all relevant steps succeeded; no omitted resource, upload, sign or suppressed failure |

Create S3's action runner with its owning tests, not beforehand as an empty passing check. Native consumer proofs are manual/recipient-harness obligations, not inferred from these command exits.

Only S1 Mac and Rust scopes are initially independent. S2 waits for frozen S1 contracts; S3 waits for native leases. Within S2, platform UI workers remain disjoint, while controller/state/settings integration is sequential. Shared source/history is never copied into private skill files or vice versa.

Extend existing build-only workflows with each real runner when it exists; preserve read-only checkout, all three unsigned Mac builds, full Windows/Linux resources and no artifact uploads. Run composed foundation/agent checks to protect existing behavior. Write `docs/research/shelf-verification.md` with command, revision, actual native device/consumer and limits, never private filenames/content.

Approval of this plan also reviews the proposed bounded text/image admission defaults; it does not approve service account changes, public distribution, background file scanning or a LocalSend send on drop. Complete S1–S3 native gates before claiming the shelf delivered; downstream transfer code may consume only the reviewed native lease contract.
