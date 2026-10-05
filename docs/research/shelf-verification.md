# Temporary shelf verification receipt

2026-10-05. [Approved shelf plan](../superpowers/plans/2026-10-05-temporary-shelf.md),
first slice S1a: regular-file native asset/lease lifetime. Not a completed shelf.

## Starting point and tests-first checkpoint

Planning source `04f8534f99ed3dc3ea40c1310155ff020cf5c11f` is independently
remote-verified. Native Mac/Windows/Linux baseline passes at `76b4ee2` are recorded
in [native qualification](native-qualification.md). User approved the remaining
feature, shelf and capability plans, including the proposed admission bounds.

Two disjoint implementers added real native read-consumer tests against current
copy/cancel owners. Production behavior is unchanged. The current owners have no
registered shelf lease API; the tests intentionally expose pathname loss during
disposal while a read consumer remains open. They check actual copied and original
bytes using synthetic explicitly owned fixtures, not mocked lease behavior.

| Target | Added executable test | Initial evidence |
| --- | --- | --- |
| Mac | `future_lease_lifetime_remove_keeps_open_consumer_path` (23rd preparation case) | Hosted behavioral RED pending; local `swiftc` unavailable |
| Windows/Linux | `files::tests::cancel_preserves_ready_path_until_native_reader_closes` | Hosted behavioral RED pending; local Cargo/Rust unavailable |

Expected RED is a real pathname-survival assertion after successful native copy,
consumer open/read and unchanged-original assertions. Compiler errors, fixture
failure, a skipped case or missing local tool are not behavioral RED. Ordinary
source checkpoints may intentionally carry these failing native tests while the
observed RED→GREEN cycle is performed; this is not a release or passing milestone.

Controller preflight: 109 Node TS/MJS tests, foundation 26 portable cases and
TS/Vite checks, and 66 Python relay tests passed before product changes. No local
Swift/Rust execution is claimed. No compiler/global account/runtime setup changed.

## Next required evidence

### Observed native RED: `e5ec070`

Exact source `e5ec0706b095d2e9d6aaf9ece98775ff16e0c9fc`.
[Mac run 37314194104](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37314194104)
passed the original 22 preparation cases, 21 hover cases and three unsigned app
builds, then failed the new 23rd case at its intended pathname-survival assertion
(exit 133). Setup, copy, held-consumer bytes and original integrity all succeeded.
[Tauri run 37314194122](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37314194122)
failed the intended pathname-openability assertion on **both** native targets:
Windows app-library 26 passed / 1 failed; Linux 29 passed / 1 failed. Existing
standalone native copy suites passed (12 Windows, 22 Linux). Cargo exited 101;
full Tauri build steps were skipped after that intentional RED, not verified.

This is actual behavioral RED, not a missing API/tool or fixture failure.
Registered native lease implementation is now admitted for S1a; GREEN remains
pending. No frontend shelf/OS export/native consumer qualification is implied.

### S1a source review of the uncommitted candidate

Reviewed on Linux with no local Swift/Rust toolchain, so this is a source review,
not compile or native evidence. The candidate was uncommitted and has since been
revised in place, so findings 1 and 3 below describe the state of the in-flight
working tree, not a committed revision; 2, 4 and 5 were confirmed against `e5ec070`
plus the real callers. Six read-only review passes covered the Rust native owner,
Rust compile risk, the Swift actor, the Swift test suite, CI/lockfile wiring, and a
full portable regression sweep. Fixes applied:

1. **Contract mismatch.** Rust spelled lease purposes `Preview/Export/Attachment`
   while the approved seam and the Mac candidate use `drag|share|mail|transfer`.
   Rust now uses the approved four, and one ceiling test cycles all four so a
   lease provably keeps the purpose it was acquired with.
2. **Unquittable app after failed native cleanup.** `lib.rs` called the
   result-discarding `owner.shutdown()` and then `handle.exit(0)` unconditionally,
   so a failed cleanup was invisible. The exit path now uses `shutdown_checked()`
   and logs the refusal. Two review passes then showed the first correction was
   also wrong: refusing to exit made a permanently failing cleanup (an unremovable
   *foreign* entry, which no retry can clear, and Windows has no reaper) brick the
   process forever. Cleanup now finishes and opens the exit gate either way: the
   failure is reported, never silent, and the app can always quit.
3. **Dead `ingest()`.** `CopyJob::prepare` had moved to `file_copy::copy_owned`,
   leaving the old free function unreferenced. Removed.
4. **Mac retry regression.** Caching `shutdownTask` made a failed sweep permanent,
   so the app's own "Try quitting again" prompt could never succeed. The cached
   task is now dropped when cleanup failed — and the `disposals` memo that would
   have made that retry hollow (it re-read a cached `false` instead of re-attempting
   the removal) is now cleared on failure too.
5. **New runner unregistered.** `scripts/test-shelf-storage.sh` is now a Mac
   workflow path trigger, step and summary row. The path filter was also collapsed
   from eight hand-enumerated scripts to `scripts/test-*.sh`, because enumeration
   is exactly how a new Mac-only runner gets silently skipped.

Also fixed from review: `ReadyLease::close` latched `released` before the lease
count was confirmed, so a failed decrement silently lost the lease; the shutdown
test un-sticked the very condvar wait it exists to prove, so a missing notify
would have passed; `readyReceipt` validated twice per lease with the first result
discarded; five unbounded `Task.yield()` spins and an unbounded `waitUntilPaused()`
would have turned any regression into a 30-minute job timeout instead of a failure;
the 4096 remove-tombstone bound had no test at all; and the 23rd preparation case
claimed a descriptor-alone lifetime RED that registered lease pinning now satisfies.

Second review round is not closed. Known accepted limits, deliberately not changed
here: native disposal runs under the global state lock (correct lock order, no
deadlock, but a latency ceiling), `cleanupFailed` is a process-wide latch that also
refuses unrelated preparations, `remove_content`/`remove_dir` verify identity
through a handle they drop before unlinking by name, and the Linux reaper skips an
operation directory containing any extra entry.

Portable re-checks after the fixes: 109 Node TS/MJS tests, 66 Python relay tests,
`tsc --noEmit`, `vite build`, `bash -n` on all 13 scripts, and workflow YAML parse.
Swift and Rust remain unexecuted locally, and one review predicts the Rust compiles
clean with dead-code warnings only for the not-yet-wired S2 commands.

Observe actual hosted RED before native asset/lease implementation. Then test real
registered acquire/remove/release lifetimes, unknown/duplicate/cross-asset IDs,
cancel/remove races, shutdown waiting, namespace substitution and bounded assets/
leases, followed by existing native full builds at the new source revision.

Folders, crash reaping, shelf UI, received references, LocalSend, real Finder/
Explorer/share/Mail consumer lifetimes, sandbox/accessibility/performance and
installer/signing/rights gates remain pending. An open read handle proves only
this native storage regression, not a qualified OS export/attachment consumer.
