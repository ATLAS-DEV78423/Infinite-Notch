# Native qualification — actual results and open gates

2026-10-04. **Development evidence, not release readiness.**
[Release map](../RELEASE_READINESS.md),
[approved native plan](../superpowers/plans/2026-10-04-native-qualification.md) and
[foundation contract](../superpowers/plans/2026-10-04-notch-foundation.md) remain
binding. Preserve completed source/native checks; do not restart them on resume.

## Build-only baseline: `677da24`

Exact tested source: `677da24e71702aa6f78a4668675252e0f84e8143`.
These new workflows were centrally reviewed, actionlint 1.7.12 passed, and the
normal source push automatically started the runs below. No manual dispatch,
signing, tag, release, packaged artifact or compiled-product cache was created.
Jobs used read-only checkout, existing source/dependencies and invented fixtures.

| Lane | Actual result | Run / evidence scope |
| --- | --- | --- |
| macOS ARM64 | Five existing Swift scripts passed; unsigned NotchBuddy Debug, CoucouAppStore Debug and NotchBuddy Release built successfully | [Run 37220416837](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37220416837), job 111489440389; compiler/tests only, not app interaction or sandbox permissions |
| Windows Server 2022 | 81 TypeScript checks passed; standalone native copy harness compiled but 5 tests passed / 5 failed with controlled `Storage` errors | [Run 37220416852](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37220416852), Windows job 111489440431; relay/workspace/full-build steps were correctly skipped, **not passed** |
| Ubuntu 22.04 | Node/MJS, adapter/Python relay, standalone copy, actual release relay, full Cargo workspace tests and full no-bundle Tauri build passed | Same [run](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37220416852), Linux job 111489440346; closes the previous local quota-limited full-build gap for this revision only |

The combined Tauri workflow correctly concludes failure because its Windows job
failed; the independent Linux job success is not hidden by that overall status.

### Actual Mac toolchain and warnings

Recorded macOS 26.6.2 (25G83), ARM64, image `macos26` / `20260907.0351.1`,
Xcode 26.6, Apple Swift 6.3.3, XcodeGen 2.46.0. Compiler output contains
`-swift-version 6`; XcodeGen's `xcodeVersion: 27.0` metadata is not a claim that
Xcode 27 was installed. Source language/deployment/security settings were not
lowered or removed to obtain the build.

Existing source warnings include main-actor access from notification/timer
closures (`IslandRootView`, `IslandViewContent`, `IslandWindowController`,
`SettingsView`), deprecated application activation, an unused greeting variable
and App Store unreachable paths. AppIntents extraction is skipped because there
is no framework dependency. Checkout@v4 also receives a Node-20 deprecation
annotation, and the hosted service notes ARM64 capacity constraints. These are
recorded, not suppressed or described as a warning-free release.

The five existing scripts are screen geometry (13 cases), safe links (15 cases),
chat parsing, plan gauge and ask question. Successful script execution does not
test the new full-hover requirement or native copy readiness on Mac.

### Windows failure and root-cause gate

Recorded Node 24.21.0 and Rust/Cargo 1.98.1 on the Server 2022 runner. The
compiled Windows handle path is executable, but successful copying is broken:

- `concurrent_same_name_preserves_bytes`
- `thousand_duplicates_do_not_overwrite`
- `cancel_removes_only_owned_partial` (initial ready copy)
- `invalid_or_reused_id_refused` (initial ready copy)
- `large_file_streams_exact_bytes_in_chunks`

All return `Storage`; cancellation/failure/conflict paths passed. This is actual
RED evidence, not an absent compiler. The controller traced all copy callers
through the shared owner and Windows publication function. A Windows-only native
publication regression now exposes the raw OS error number/kind using synthetic
data; its hosted result must identify the cause before a production fix.
No raw selected-file path/content, credentials or private agent payload is logged.
Do not loosen sharing, no-follow, no-overwrite or ancestor pinning on a guess.

## Test-first follow-on: `516bd3c`

Exact source: `516bd3c748483635a10e57f090e1f2b52778f2f6`.
Two scoped implementation workers added tests only, with central diff review:

- `tests/IslandStateMachineTests.swift` and `scripts/test-island-fsm.sh` compile
  the existing pure FSM in real Swift 6 and assert default hover reaches `.home`.
  The old `.petit` behavior is the expected behavioral failure, not a missing API
  or compiler surrogate. No product FSM/settings/controller fix has been made.
- A Windows-only `cfg(test)` publication regression in `file_copy.rs` exercises
  real native handles, byte preservation and collision refusal, reporting only
  numeric OS error/kind if publication fails. Production behavior is unchanged.

Available controller checks: actionlint and shell syntax passed; all 109 existing
Node TS/MJS checks passed. Earlier task-local validator/Rust directories were
no longer present after interruption; a checksum-verified task-local validator
was supplied again. A missing local compiler is not RED/PASS, and no unnecessary
global tool install or prepared-runtime reconstruction was performed.

Automatically started [Mac run 37221964781](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37221964781)
and [Tauri run 37221964705](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37221964705).
At this receipt's initial observation they were in progress; actual follow-on
RED/GREEN outcomes were subsequently observed without duplicate dispatch:

- Mac's existing five checks and three builds passed again. The new pure FSM
  assertion compiled/executed and failed with `default mouseEntered() expected
  .home, got petit` (exit 133): actual behavioral RED for approved foundation Task 2.
- Windows's native probe failed with Win32 error **87 / InvalidInput** at rename
  publication, making 5 pass / 6 fail. No Windows workspace/full-build pass exists.
  The descriptor-only repair uses the documented full destination path/NULL root
  form inside the still-pinned directory, terminated UTF-16 and a length excluding
  the terminator. No sharing/pinning/no-overwrite rule is relaxed; GREEN remains
  required before calling that candidate verified.
- Linux completed its full test/build lane successfully for `516bd3c` as well.

### First Windows candidate: `57f2d2a`

[Run 37223046065](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37223046065)
tested `57f2d2a301985c64e05ddeb411761afbeaaa602e`. Linux again passed its full lane.
Windows still failed 5/11 tests at publication; the native probe changed from
error 87 to **32 / sharing violation**. The full-path Win32 descriptor candidate
was therefore **not a verified repair**; Windows workspace/full-build remain
unexecuted. Retain this failure rather than silently replacing its receipt.

The next candidate uses the documented user-mode `NtSetInformationFile` native
same-directory/simple-name form. It avoids Win32 DOS/current-directory target
resolution and target-parent reopening while preserving all pinned handles,
no-follow/sharing restrictions and no-overwrite publication. It validates the
simple target name and translates only native status codes into controlled
errors; no new dependency, driver, global hook, current-directory change or
relaxed pin is introduced. Actual native GREEN is still required.

Primary API contracts:
[NtSetInformationFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile)
(explicitly documents user-mode naming) and
[FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
(same-directory names and target-directory sharing constraints).

### Mac hover candidate after actual RED

The scoped foundation Task 2 implementation now contains 21 deterministic pure
FSM cases: default/delayed full hover, exact leave/reentry boundaries, explicit
auto-close, independent owners, queued stale callbacks, greeting/hide holds,
external synchronization, preference clamping and actual countdown deadlines.
Native controller inputs/settings/ownership are wired without a new framework;
keyboard, drag, menu, approval and future inspector owners remain separate.

Central review corrected countdown scheduling: its TimelineView is constructed
only while expanded with a real deadline, at 4 Hz; hidden/held/deadline-free paths
do not keep that timeline ticking. Other app-wide hidden rendering/performance
still requires native measurement, not an inference from this code path.

Local compiler execution is unavailable. Source/available shell checks are not
Swift GREEN; the new source must pass the real Swift runner and all app builds
before its native build/test gate is recorded complete. Native input/focus,
accessibility, screen changes and hardware interaction remain unqualified.

### Actual result: `4e9468a`

Exact source `4e9468afdc090c93e05b4d64482de73ec32e5d70`, independently matched
to remote HEAD. Existing runs were inspected after interruption, not redispatched.

- [Mac run 37229193086](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37229193086),
  job 111515071815: **success**. All five existing Swift scripts, **21** real
  Swift 6 FSM cases and all three unsigned builds passed on the recorded
  Xcode 26.6 / Swift 6.3.3 ARM64 lane. The actual compact-hover RED at `516bd3c`
  and this GREEN establish the compiler/pure-test gate, not native usability.
- [Tauri run 37229193143](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37229193143),
  Linux job 111515071962: **success**. 109 Node TS/MJS, 25 adapter checks,
  22 standalone copy, 29 app-library and 10 relay tests; full no-bundle build passed.
- Same run, Windows job 111515071857: **10 passed / 1 failed** standalone
  tests after 81 TypeScript passes. Real native publication, invalid-target and
  collision checks now passed. Relay/workspace/full build were still skipped.
  The sole failure is `large_file_streams_exact_bytes_in_chunks`.

The remaining Windows fixture writes/syncs 16 MiB but retains its writable handle
across ingestion. Native source opening intentionally forbids live writers; the
fixture must close its finished writer. A test-only correction and a Windows
held-writer refusal/after-close copy regression preserve that production safety
policy. This is not another publisher change or an all-tests-green claim.

Mac foundation Task 4 now starts with a test-only actual-engine assertion that
ten seconds without an I/O receipt cannot show check/choose/completed progress.
The new runner does not yet compile a future actor; native behavioral RED must
be observed before product copying/readiness changes. Owned-copy, real input,
sandbox and hardware acceptance remain pending.

### Full Windows/Linux build lane: `0331a4f`

Exact source `0331a4f27f276c13208bc8bd26fa0c64cc287868`.
[Tauri run 37230164506](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37230164506)
completed **success**; both jobs actually ran to completion, without rerunning an
uncertain dispatch. Windows job 111517976258 passed **12** standalone copy cases,
**26** app-library and **10** relay tests, its 81 TypeScript checks, actual
release-relay build and full no-bundle Tauri/TypeScript/Vite build. The finished
writer was closed in the fixture; its new held-writer denial test passed without
relaxing production source sharing. Native success/collision publication is now
verified within these fixtures. Actual image: `win22` / `20260927.320.1`, X64,
Rust/Cargo 1.98.1. Standalone unused reaper types/functions and app unused reaper
result fields remain warnings; Windows restart cleanup is still unsupported.

Linux job 111517976423 also passed its full lane. Server 2022 builds are not
Windows 10/11 desktop, Explorer/OLE, screen-reader, crash/reparse or signing proof.

[Mac run 37230164507](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37230164507),
job 111517976401, passed all three unsigned builds, prior five checks and 21 hover
cases, then the new readiness assertion compiled and **failed behaviorally**:
`check=1.0, chooseAlpha=1.0, progress=1.0` after ten seconds without an I/O result
(exit 133). This is the intended Task 4 RED, not a failed compiler surrogate.

The subsequent reviewed Task 4 candidate contains an owned Swift actor/Darwin
worker, exclusive descriptor-anchored copies, bounded cancellation/admission,
current-UUID ready-only context/actions and receipt-driven Mochi completion.
It removes destructive inbox replacement, original-path ready context, timed
progress/ticks and orphaned copy work. Twenty actual actor/owner/frame cases
are wired into the existing real native runner; their GREEN and the changed
app builds remain pending. A source review/local Node pass cannot certify them.

Controlled shutdown awaits native workers; ready copies are retained across UI
clearing. Mac abnormal-exit reaping and export/consumer exit leases are **not**
implemented or qualified by this candidate. Sandbox grants, real input, slow
disk/cancel/permission loss and hardware/accessibility remain required.

### Mac preparation candidate result: `3f0ab1d`

Exact source `3f0ab1d831c7ff5292b562ac19ecc47d8d45c9cb`.
[Mac run 37235374610](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37235374610)
passed all three unsigned app builds, five prior checks and 21 hover cases, but
the native preparation binary failed a real-worker barrier assertion (exit 133).
No complete preparation-suite GREEN is claimed. Buffered output did not identify
the failing case/error; fixed, content-free test diagnostics now name the current
case and real setup/checkpoint stage before any assertion trap.

Central review also identified a separate path-usability gap between native
publication and receipt delivery. The applied narrow follow-up revalidates the
actual ready namespace/content after publication; an actual-worker ancestor-swap
test verifies refusal rather than delivery through a substituted namespace.
It does not grant path-based cleanup or claim continuous hostile same-user race
protection after the final check. This change and the now-22-case diagnostic suite
still require their own actual native result.

[Tauri run 37235374615](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37235374615)
completed **success** for the same SHA: Windows and Linux full lanes passed.
The interrupted fix's applied files were preserved and its missing diagnostic/
report remainder resumed; no old run or completed implementation was repeated.

### Trusted-base diagnostic and repair after `b771cc8`

At `b771cc84a6e644ccad1442e108b83b4d5c919d68`,
[Mac run 37301891212](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37301891212)
again passed all app builds and 21 hover cases. The readiness frame case now
passed, but the first basic actor copy failed `invalidSource` **before source
fstat**, not inside publication or a barrier. No full preparation GREEN exists
at this revision. [Tauri run 37301891200](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37301891200)
passed both complete platform lanes.

The traced cause is Apple's documented `URL.resolvingSymlinksInPath` behavior:
it can strip `/private`, recreating the `/var` or `/tmp` system alias that the
no-follow directory walk correctly rejects. The test fixture and trusted
Darwin-selected production temp base used that helper. The narrow repair uses
POSIX `realpath` with balanced freeing **only for those trusted bases**. Selected
source URLs and caller-supplied actor roots remain unnormalized and no-follow.
Primary contract: [Apple URL resolver](https://developer.apple.com/documentation/foundation/nsurl/resolvingsymlinksinpath).

The real native default-root regression checks canonical ancestors, exact
synthetic copies and owned shutdown. Review corrected its cleanup so failed
prepare/read paths await shutdown before throwing, and assertions occur after
cleanup. There are 22 top-level cases plus a named nested base subcheck. Fresh
109 Node checks, shell syntax, whitespace and source review passed; actual Swift
execution/builds of this repair remain required. No safety flag was relaxed.

### Verified follow-on: `76b4ee2`

2026-10-05. Exact source `76b4ee2f3f3b4344ad38605a87c0dac795306e2a`.
[Mac run 37306093916](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37306093916)
completed **success**: five original checks, 21 hover cases, **22 preparation
cases** (including the nested trusted-base/default-root subcheck), and unsigned
NotchBuddy Debug, CoucouAppStore Debug and NotchBuddy Release. The trusted-base
repair's real native suite is now GREEN, not just source-reviewed.
[Tauri run 37306093879](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37306093879)
also completed **success**, both Windows/Linux full jobs. Existing source warnings
are not reclassified as absent; hosted passes remain compiler/fixture evidence.

Both running watchers completed. Planning the remaining features does not repeat
these jobs or declare interactive/sandbox/crash/export/signing acceptance complete.

## Still not qualified

Mac native hover/input, sandbox and real owned-preparation interaction acceptance;
Windows broad reparse/restart cleanup and native command/OLE/Explorer delivery
beyond the passing hosted copy/workspace/build fixtures;
rich agent sources/ingress/lifetime and SwiftUI Details;
the full multi-item shelf/LocalSend/media/system/calendar/extras scope.

Actual notched/notchless displays, minimum supported OS, desktop Windows 10/11,
permissions/sandbox, VoiceOver/Narrator, attachment/share consumers, cross-device
LocalSend, hardware sensors/HUD suppression, frame/input/idle/memory targets and
clean install/upgrade/uninstall remain pending. Hosted build jobs do not supply
that evidence. Asset permission, owner signing/notarization and Defender clearance
remain mandatory before public binaries; existing publication pauses stay intact.
