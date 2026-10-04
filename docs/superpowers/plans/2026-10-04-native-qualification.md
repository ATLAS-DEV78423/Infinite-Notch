# Native Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`, as explicitly requested. Steps use checkbox (`- [ ]`) syntax for tracking. The controller performs research/review/tests; delegate only implementation.

**Goal:** Establish real, build-only macOS/Windows qualification and a Linux compatibility lane so the approved foundation can progress beyond portable evidence.

**Architecture:** Add thin qualification workflows around existing scripts, XcodeGen schemes and Tauri/Cargo commands. Keep packaging/publishing workflows untouched. Results are bound to actual checked-out revisions and runner/toolchain versions; a hosted compile/test pass cannot qualify native hardware/UI or the full release.

**Tech Stack:** Existing GitHub Actions, XcodeGen/Swift 6/Xcode, Node 24 LTS, Rust/Cargo/MSVC, Tauri 2 and existing locked dependencies. No new application dependency, service, framework or global configuration.

**Spec:** [Approved expansion design](../specs/2026-10-04-notch-app-expansion-design.md), sections 4/5/10/11/13/14; [approved foundation plan](2026-10-04-notch-foundation.md); [full release execution map](../../RELEASE_READINESS.md).

**Status:** Reviewed and approved by the user on 2026-10-04 through the plan-review
question ("Approve and continue"). Execution starts with the qualification-only
batch; no native pass or release approval is inferred. The user explicitly chose
subagent-driven development; do not ask them to choose the method again.

## Global Constraints

- Preserve source checkpoint `d537404` and the current feature branch/remote. Source pushes are ordinary, explicitly staged checkpoints; no upstream push/force/tag/release.
- Keep both native UIs, stable IDs, Mochi and existing Claude/Codex approvals. No new product behavior in the qualification-only batch.
- No new runtime dependency for the foundation; preserve Swift 6 strict concurrency and actual native target builds.
- Originals and existing destinations are never deleted or overwritten; synthetic file tests use owned runner-temp roots, not real inboxes.
- No telemetry, private-content logs, automatic sends or agent-data persistence. CI uses public source and invented fixtures only; never upload private inputs/configuration.
- Qualification jobs have `contents: read`, checkout credentials are not persisted, and no owner secrets/signing identities are consumed.
- No `pull_request_target`, release creation, tag manipulation, binary/installer/artifact upload or generated build-product cache. Existing `PUBLISH: false` stays false.
- Explicit standard runner labels, finite job timeouts and concurrency cancellation bound cost; no larger/paid or self-hosted runner enrollment without an owner decision.
- Hosted tests do not establish actual notched/display/OLE/hardware/sandbox-permission/accessibility/installer acceptance. Missing required evidence keeps strict gates nonzero.
- Two workers own disjoint workflow files. Mac foundation Tasks 2/4 follow sequentially once a usable real Swift/Xcode lane exists; do not redispatch completed Tauri tasks.

## Review Focus

1. A Windows native subprocess fails before another succeeds: its nonzero exit must fail the job, never be swallowed by PowerShell (Task 2 checks each external exit).
2. Tests accidentally pass from only a web build or stub resource configuration: require Windows-native standalone copy/app/relay tests plus full no-bundle Tauri build with real relay resource (Task 2).
3. Mac direct scheme compiles while sandbox-target code is broken: build both existing schemes with real Swift 6 settings, with unsigned build distinct from runtime sandbox acceptance (Task 1).
4. A successful run belongs to an old/different commit: bind receipt to actual checkout SHA, run ID/attempt and tool versions, inspect state before rerun (Task 3).
5. Manual qualification invokes upstream packaging and publicly exposes restricted assets: workflows must have no publish/upload path, no compiled-product cache and no owner credentials (Tasks 1–3 review/lint).

## Live preflight findings

Controller read-only checks on 2026-10-04:

- Local/remote branch both match full SHA `d537404a3d1bcadc804637f9a1f828c7af778e89`; only excluded `.opencode/` skill imports are untracked.
- `ATLAS-DEV78423/Infinite-Notch` is public, default branch `feat/notch-expansion`, connected viewer ADMIN. Actions permissions report `enabled: true`.
- Workflow source files exist on that remote branch, but the Actions API reports zero registered workflows/runs. No successful native run or reason for the empty inventory is assumed.
- Existing Mac `build.yml` filters `main`; Windows/Linux workflows build/package on tag/manual paths and manual runs upload public app artifacts. Do **not** dispatch them as a shortcut around asset/publication constraints.
- Current source declares macOS deployment 15.0, Swift 6 and XcodeGen `xcodeVersion: 27.0`; actual runner compiler/SDK is not yet qualified. Record installed versions; unsupported source/toolchain remains a real failure, not a reason to lower settings silently.
- Linux host has no standard-PATH Swift/Xcode/Rust; the prepared task-local Linux toolchain and prior scoped receipts remain intact.

Primary runner inventory: [GitHub runner-images](https://github.com/actions/runner-images)
(read 2026-10-04) lists standard `macos-26`, `macos-15`, `windows-2022`,
`windows-2025` and `ubuntu-22.04`. Initial jobs use `macos-26`, `windows-2022`
and `ubuntu-22.04`. The Windows label is **Server 2022**, not Windows 10/11
desktop acceptance. Xcode 27 is listed separately as preview; do not claim it is
installed on a standard GA image or silently enroll a larger runner.

## File ownership and interfaces

| Task / owner | Exact files | Contract |
| --- | --- | --- |
| 1 / Mac implementation worker | Create `.github/workflows/native-macos.yml` | Build-only workflow named `Native macOS qualification`; existing Swift checks and both app schemes |
| 2 / Tauri implementation worker | Create `.github/workflows/native-tauri.yml` | Build-only workflow named `Native Tauri qualification`; independent Windows/Linux jobs, real resources/full builds |
| 3 / controller | Create `docs/research/native-qualification.md` after actual runs; update this plan, `docs/DEVELOPMENT.md`, `docs/NOTCH_ROADMAP.md`, `docs/RELEASE_READINESS.md` with actual state | Minimal public command/revision/result receipts; no captured payloads or private logs |
| Follow-on / repair worker | Only files proven defective by the actual failing check | Behavioral reproduction and minimal repair; scope assigned after diagnosis, not guessed now |

Both workflows trigger on pushes to `feat/notch-expansion` for their source/test/
workflow paths, relevant pull requests and `workflow_dispatch`. Do not alter the
default branch or create tags just to register them. Record `git rev-parse HEAD`,
runner image/architecture and relevant tool versions in step summaries; never
dump full environment/context. Standard caches, if used, contain dependency
downloads only, not app products/fixtures/session data.

### Task 1: Mac compiler/tests and both native schemes

**Files:** Create `.github/workflows/native-macos.yml`. No Mac product code or release workflow edits.

**Interfaces:** Consumes `NotchBuddy/project.yml`, the existing five standalone Swift test scripts and current source. Produces an exact-revision Mac job with native test and separate scheme/configuration step results. Timeout 30 minutes; runner `macos-26`.

- [ ] **Step 1:** Identify the absent native baseline from the recorded preflight; inspect installed Xcode/Swift in the first job. Do not invent a failing native assertion before the workflow can run.
- [ ] **Step 2:** Implement the build-only workflow with read-only permissions, credential-free checkout, finite concurrency/timeout and existing XcodeGen installation/generation. Print only Xcode/Swift/XcodeGen versions and source revision; preserve source deployment/concurrency settings.
- [ ] **Step 3:** Run these exact existing checks as individual fail-fast steps: `bash scripts/test-screen-geometry.sh`, `bash scripts/test-safe-links.sh`, `bash scripts/test-chat-parsing.sh`, `bash scripts/test-plan-gauge.sh`, `bash scripts/test-ask-question.sh`. A missing/failing executable check fails its step.
- [ ] **Step 4:** Build `NotchBuddy` and `CoucouAppStore` Debug, then `NotchBuddy` Release, using `xcodebuild -project NotchBuddy/NotchBuddy.xcodeproj -scheme <scheme> -configuration <configuration> -derivedDataPath <owned-runner-temp-path> build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`. No signing, archive, app launch, upload or XcodeGen project commit. No `continue-on-error`, weakened concurrency flags or resource removal.
- [ ] **Step 5:** Validate workflow syntax with a task-local Actions validator, controller-review permissions/commands, then checkpoint only reviewed public source. After the combined push, observe the actual Mac steps and record errors/warnings/counts. This task passes only when those real steps succeed; VM compilation does not check notarization or runtime sandbox permissions.

### Task 2: Windows-native copy/workspace and Linux compatibility

**Files:** Create `.github/workflows/native-tauri.yml`. No product/packaging/release/configuration edits in this task.

**Interfaces:** Consumes `windows/{package-lock.json,Cargo.lock}`, existing standalone copy harness and Cargo app/relay targets. Produces independent `windows-2022` and `ubuntu-22.04` results with Node 24, existing native prerequisites and real relay resources. Timeout 45 minutes per job; one job failure cannot suppress observing the other.

- [ ] **Step 1:** Define native checks, not regex substitutes: Windows `rustc --edition=2021 --test tests/file-copy-rust.rs`, Cargo workspace tests, TypeScript/Vite and a full Tauri no-bundle build. Linux runs the existing standalone copy script and workspace tests/full build with existing GTK/WebKit/layer-shell prerequisites.
- [ ] **Step 2:** Implement both jobs with read-only/credential-free boundaries. Install existing npm dependencies with `npm ci --no-audit --no-fund` in `windows/`. On Linux reuse the exact prerequisite packages in existing `linux.yml`; do not install or alter tools on the user's host.
- [ ] **Step 3:** Run Node `tests/*.test.ts` via Bash glob expansion on both runners; run the unchanged POSIX-shaped `tests/*.test.mjs`, `bash scripts/test-agent-adapters.sh` and `python3 -B -m unittest discover -s tests -p test_agent_relay.py` on Linux. The existing shebang/signal/Unix-socket fixtures are not made native-Windows by selecting Git Bash. Their separate Windows producer/runtime acceptance stays pending; the Windows-native copy/app/relay/full-build gates still execute. These regressions are not native UI evidence.
- [ ] **Step 4:** Compile/execute the Windows standalone Rust harness in a newly created owned `$RUNNER_TEMP` directory, export its Windows-native path as `COUCOU_COPY_TEST_ROOT`, and remove only that fixture directory in `finally`. Use PowerShell `$ErrorActionPreference = 'Stop'` **and** explicit `$LASTEXITCODE` rejection after compiler/test executables; ordinary PowerShell error preference alone cannot prove native-command success. Run Linux `bash scripts/test-file-copy.sh` with the hosted compiler. Windows-skipped Unix-only tests are not Windows reparse/restart evidence.
- [ ] **Step 5:** In `windows/`, run `cargo build --release -p coucou-hook --locked` before `cargo test --workspace --locked`, then `npm run tauri -- build --no-bundle`. Use actual platform resource selection (Linux's existing config where required). Do not override `TAURI_CONFIG` to remove resources, suppress the full archive or call `npm run pack`. Each failure propagates, including a non-final native command. No compiled app/installer artifact or target cache is uploaded.
- [ ] **Step 6:** Lint/review both jobs and push only with the Mac task's reviewed checkpoint. Inspect each real OS result and actual test count, including compile/test/build warnings. A full hosted Linux build can close the previous local quota-limited archive gap for that SHA; a Windows Server build cannot close desktop OLE/Explorer/Defender acceptance.

### Task 3: Observe real runs, repair proven defects and record evidence

**Files:** Controller-owned `docs/research/native-qualification.md` (create after runs), this plan, `docs/DEVELOPMENT.md`, `docs/NOTCH_ROADMAP.md`, `docs/RELEASE_READINESS.md`. Any product repair gets a new exact file scope after the failing run identifies the defect.

**Interfaces:** Consumes actual GitHub workflow/run/job responses and checked-out revision; produces minimized public receipts with command, runner/architecture/toolchain, source SHA, run URL/attempt, observed test count, result, warning classification and evidence scope. Never produces a release-ready flag from fixture/build results.

- [ ] **Step 1:** Controller reviews combined workflow diffs, runs a task-local Actions validator and `git diff --check`, verifies no write/secrets/publish/artifact/cache-product path, then commits explicit files with `ci: qualify native builds without publishing artifacts`. Push normally to `infinite-notch` / `feat/notch-expansion`, compare `git rev-parse HEAD` with `git ls-remote` and record the source SHA.
- [ ] **Step 2:** Inspect `gh workflow list` and `gh run list --repo ATLAS-DEV78423/Infinite-Notch --commit <sha>` after the push. Capture actual matching run IDs before waiting. Push should trigger each applicable qualification workflow; do not also manually dispatch duplicate jobs. If no run appears, inspect the returned state/permissions/registration, then dispatch each known workflow once with `gh workflow run <returned-id> --ref feat/notch-expansion --repo ATLAS-DEV78423/Infinite-Notch` only if it is registered and no matching run exists. No retry following an uncertain dispatch without fresh observation.
- [ ] **Step 3:** Wait for each recorded run with `gh run watch <run-id> --exit-status --repo ATLAS-DEV78423/Infinite-Notch`. Read structured final job/step conclusions; inspect failing synthetic build/test diagnostics locally. Nonzero status, timed out/cancelled/skipped steps, zero discovered tests or different checked-out SHA cannot be recorded as passed. No product/session/secret payload is attached to receipts.
- [ ] **Step 4:** Diagnose an actual failure before changing code. For a source defect, write/run the smallest native regression, assign its isolated repair to a fresh implementation worker, review and rerun the affected native and portable checks. For runner/toolchain/Actions entitlement failures, report the exact prerequisite instead of lowering Swift/security settings or enabling paid/self-hosted infrastructure. Every new pushed fix is matched to its own new run IDs/SHA; old successful runs do not certify it.
- [ ] **Step 5:** Write `docs/research/native-qualification.md` with separate Mac tests/builds, Windows tests/builds and Linux compatibility results. Record untouched pending UI/hardware, Windows restart/reparse, sandbox, rich-agent and distribution gates. Update roadmap status, not feature-complete labels. Commit/push only reviewed source/tests/docs with a conventional logical commit, verify remote SHA, and leave private worker reports/skills/configuration excluded.

### Follow-on: Resume already approved Mac foundation tasks

Once Task 1 demonstrates an executable Swift/Xcode lane, resume
[foundation Task 2](2026-10-04-notch-foundation.md#task-2-swift-hover-ownership-and-settings-parity)
then [Task 4](2026-10-04-notch-foundation.md#task-4-swift-operation-owned-copy-and-truthful-readiness).
Their interfaces/file scopes/tests already exist in the approved plan; do not
invent a competing FSM/copy design here. Each is implemented by a fresh worker
and centrally reviewed; they cannot edit shared `AppState` concurrently.

The new pure Swift tests must run red against the old behavior on the native lane
before the production fix is reported green. Build/check revisions carry no
public app artifacts. If remote-only turnaround cannot establish the declared
red/green steps, keep that prerequisite explicit instead of claiming a local
Swift execution. Real pointer travel, focus/approval, native slow/cancel drop and
sandbox permissions still require an interactive Mac device.

Windows-native tests can then support a bounded Windows restart/reparse plan,
including crash-before-marker limitations, live export leases and cleanup-only
identity metadata. Linux `flock`/procfs behavior is not ported by assumption.
Native media/calendar/HUD/LocalSend capability tasks follow the release map,
not fabricated functional views.

## Self-review and handoff

- This plan implements only release-map stage 0 and unblocks previously approved
  foundation work. Every other expansion requirement remains mapped, not omitted.
- New source ownership is two disjoint workflows; controller handles shared docs
  and integrates observed repairs. No extra reviewers/tests are delegated as roles.
- External-command failure propagation, real resources/full archive, both Mac
  schemes, exact-revision run matching and no-binary-publication are explicit
  acceptance checks. Workflow validation is not called native execution.
- Hosted runner availability was checked in primary inventory; actual queue/
  compiler/OS outcomes remain unknown until execution. No native pass is recorded.
- Ponytail uses existing build/test tools and direct workflows; no orchestration
  service, Docker platform replacement or generic artifact/reporting framework.
- Written-plan review is complete; preserve the approved scope and chosen
  subagent-driven method during execution.

**Next action:** Execute the two scoped qualification workers together, centrally
review their actual changes and run native gates before resuming Mac foundation
product edits. The full release map was included in the approved review question.
