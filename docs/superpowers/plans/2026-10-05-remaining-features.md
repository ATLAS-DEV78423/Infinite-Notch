# Remaining Features Application and Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`, preserving the user's selected method. Steps use checkbox (`- [ ]`) syntax. Delegate implementation only; the controller owns investigation, review and verification.

**Goal:** Deliver every remaining feature from the 52-feature list plus LocalSend settings in usable native macOS/Windows flows, without restarting completed work.

**Architecture:** Preserve SwiftUI/AppKit and Tauri, existing cards, Mochi and agent approvals. Extend the qualified copy owners into a temporary shelf; build one shared Rust LocalSend engine after native bridge/TLS qualification. Media, system and calendar work use source-qualified native adapters, not simulated widgets.

**Tech Stack:** Swift 6, AppKit/SwiftUI, existing TypeScript/DOM/Tauri 2, Rust workspace, native secure stores, existing test runners. Networking additions require dependency/license review; no new UI framework.

**Spec:** [Approved expansion contract](../specs/2026-10-04-notch-app-expansion-design.md), all sections; [approved inspector contract](../specs/2026-10-03-agent-session-inspector-design.md).

**Status:** User approved this execution map and the linked shelf/capability plans on 2026-10-05 through “Approve and continue”. Existing subagent-driven method preserved. This is the complete execution map, not permission to implement unresolved platform capabilities or publish binaries. Shelf S1a starts first; later slices receive reviewed concrete interfaces after their capability gates.

## Global Constraints

- All 52 features plus settings remain required. P0/P1/P2 order delivery; none is silently omitted.
- Keep stable IDs, one Mochi, current motion/style and existing Claude/Codex approvals.
- Shelf: 32 items, original arrival order, enabled initially, no restart persistence; folders at most 4096 entries and depth 64.
- No overwrite/deletion of originals, foreign entries or committed received files. No ready/completed state from a timer.
- Native copy/hash/network work stays off UI executors; ordinary data renders at most 4 Hz; terminal/consent updates are prompt.
- LocalSend: HTTPS-only v2.2, receive/history initially off; discovery `224.0.0.167:53317`, at most 128 peers.
- Consent: one active batch, eight waiting requests, 1024 files, 1 MiB metadata and 120-second deadline. Favorites are not authenticated trust.
- History: independent opt-in, at most 50 batches / 7 days; history off leaves terminal/Retry display for at most 60 seconds. It never authorizes file reads.
- Calendars: only selected sources, upcoming 7 days / visible week, at most 1000 expanded instances per range. Tokens stay native; no calendar enrichment of agent/chat.
- CPU: opt-in visible aggregate sampling at most 1 Hz. No process inventory or mic/camera capture to infer use.
- Agent observations remain minimized, temporary and memory-only; no logs, persistence, analytics, external transmission or interactive approval replies.
- Builds/tests, native usability, hardware performance and distribution are different gates. Signing, rights, sandbox and Windows publication pauses stay intact.

## Review Focus

1. Remove/disable/quit while Finder, Explorer or Mail still reads a managed file: keep its active native lease; never free it from a frontend timeout (S3).
2. A favorite spoofs a trusted sender or switches certificates: manual consent/identity-change confirmation; no auto-accept by claimed fingerprint (G1, L2).
3. Media/transfer updates arrive while an agent approval has keyboard focus: no view replacement, combined independent holds and stable consent controls (L3, M2, R1).
4. Event recurrence crosses DST or a lookalike meeting URL includes a trusted brand: preserve dates/instant ordering and reject false hosts (C2).
5. Pause/unload/exit races native callbacks: revoke at the feature owner, clear affected content and reject delayed ingress; frontend clock checks alone are insufficient (I2, R1).

## Verified starting point

Source: `76b4ee2f3f3b4344ad38605a87c0dac795306e2a`, branch `feat/notch-expansion`, delivery remote `infinite-notch`; upstream `origin` untouched.

- Mac [37306093916](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37306093916): five original checks, 21 hover cases, 22 preparation cases and three unsigned app builds passed.
- Windows/Linux [37306093879](https://github.com/ATLAS-DEV78423/Infinite-Notch/actions/runs/37306093879): both complete test/build jobs passed.
- Existing Tauri inspector/baseline adapters and Linux crash cleanup are preserved. Mac/Windows crash reaping, real desktop/sandbox/lease/input acceptance and rich-agent ingress are not thereby complete.
- Read [actual receipts](../../research/native-qualification.md), not obsolete missing-tool statements in historical planning notes. No old job is redispatched for reassurance.

## Approach and dependency order

Recommended: **native vertical slices with honest gates**. A shelf row must prepare, cancel and export safely before transfer UI consumes it. Independently qualified adapters can progress alongside transfer backend work without touching shared shell state.

Rejected alternatives: a frontend-only feature dashboard cannot prove actual actions; a wholesale shared-UI rewrite discards existing working native behavior and adds migration cost.

```text
F1 reconcile native/hardware gaps → S1 storage → S2 shelf models/UI → S3 native export/share
G1 bridge/TLS/client proof ───────────────────────────────→ L1 core → L2 consent/send → L3 UI/settings
G2 media source capability ──────────────────────────────→ M1 adapters → M2 UI/controls
G3 system capability ────────────────────────────────────→ Y1 controls → Y2 status
G4 calendar/OAuth capability ────────────────────────────→ C1 adapters → C2 views/join
G5 aggregate mic/camera capability ───────────────────────→ Y2 if safely supported
existing inspector qualification ────────────────────────→ I1 sources → I2 native ingress/SwiftUI
all slices + no unresolved required capability ──────────→ R1 compose → R2 installer/rights/signing
```

G1–G5 are the [capability plan](2026-10-05-platform-capability-gates.md). S1–S3 are the [detailed shelf plan](2026-10-05-temporary-shelf.md). Foundation and inspector retain their existing plans; never redispatch completed tasks.

## File ownership and review boundaries

| Lane | Backend/source ownership | Shared integration (serial only) |
| --- | --- | --- |
| Shelf Mac | `FilePreparation.swift`, new `ShelfStore.swift`, `ShelfView.swift`, `ShelfActions.swift` | `AppState`, drop/controller, settings/layout, shutdown |
| Shelf Tauri | `file_copy.rs`, `files.rs`, new `shelf.rs`, `core/shelf.ts`, `views/shelf.ts` | `lib.rs`, state/bridge/island/layout, settings |
| LocalSend | proposed `windows/transfer-core/`, thin `LocalSendBridge.swift` and native `transfers.rs` | Cargo/project resources, secure store, shell state/settings/consent |
| Media | current `MusicController.swift`, new `MediaSession.swift`; native `media.rs`, pure `core/media.ts` | state/card/header/settings, target-bound command routing |
| System | new `SystemStatus.swift`, native `system_status.rs`, pure `core/system-status.ts` | status/HUD/card registration, opt-in/settings |
| Calendar | new `CalendarStore.swift`, `CalendarView.swift`; native `calendar.rs`, `core/calendar.ts` | secure store, permissions/OAuth, card/layout/settings |
| Inspector | existing OpenCode/Hermes adapter scopes; prior plan's `AgentMonitor.swift`, `AgentSessionView.swift`, ingress scopes | HookServer/pipe/state/FSM only after shared owners are free |

Proposed new paths are planned deliverables, not existing APIs. Freeze their concrete signatures in each subsystem plan after capability evidence. No parallel agents may edit a shared integration cell concurrently.

## Execution batches

1. F1: reconcile successful hosted runs and remaining native device obligations; do not restart foundation code.
2. S1: two disjoint Mac/Rust storage implementers; controller reviews ownership/races. S2 models can be implemented per shell only after S1 contracts freeze. S3 native export follows lease tests.
3. G1–G5: controller gathers primary/native facts and writes minimized receipts. Any prototype implementation has its own approved probe scope, no user account/config changes.
4. L1 core and a proven M1 platform adapter may run in parallel. L2/L3 depend on shelf leases, bridge ownership and interoperable core; no fake transfer screen precedes those gates.
5. Y1/Y2 and C1/C2 can run alongside independent backends after qualified capability contracts. Integrate shared state/cards/settings sequentially.
6. I1's OpenCode/Hermes implementation lanes are disjoint; I2 native ingress/UI follows the corresponding shell's shared-file integration. Existing producer/relay fixes remain intact.
7. R1/R2 validate all requested features together. No tag/release/package upload without separate owner authority.

Use normally two implementation agents per genuine independent batch, not extra reviewers/research roles to manufacture activity. Load `omnirush-swarm` before any batch of three or more. Controller maintains plan-specific private ledgers and records current SHA, actual task outputs, review findings and verification IDs.

## Downstream task contracts

These are bounded work packages, not fictitious supported APIs. Each gets its own reviewed implementation plan before product edits; G tasks must settle dependencies/capabilities first. Every package follows test → observed RED → minimal implementation → actual GREEN → central review → explicit source checkpoint.

| Task | Deliverable and consuming contract | Required regression/native evidence |
| --- | --- | --- |
| F1 | Record current native successes; enumerate remaining crash/lease/device gates | Same-SHA job steps/counts, original-safe native input/sandbox checklist; no complete-foundation label |
| L1 | Shared crate: bounded discovery, HTTPS identity, native event ownership | Peer 128/129; plaintext/changed-cert refusal; port/interface loss; Mac ABI start/cancel/stop/free; actual phone+desktop discovery |
| L2 | Preparation/consent/token and streamed commit pipeline, shelf source leases | 8/9 waiting, 1024/1025 files, 1 MiB boundary, 120 s expiry; wrong peer/file/token, traversal/ADS/case collisions, checksum/length/disk-full; decline/partial accept/cancel before/after commit |
| L3 | Device picker, send/drop target, separate consent, compact/details progress, all preferences/extras | Seven real states, unknown ETA, 4 Hz renders, explicit clipboard preview, source-lease retry/reselection, history 50/7 days/off/clear, favorites never authorize trust; concurrent Claude approval |
| M1 | Per-source identity/capability snapshots, target-bound acknowledged actions, bounded artwork | Apple Music/Spotify/YouTube/podcast/local player on each requested platform; unknown/live duration, delayed control after source switch, permission revoke, two concurrent sources |
| M2 | Existing-style media card/compact art/wave and Windows explicit favorites | Wave stops paused/hidden/reduced motion; favorite activation validated; no listening history; no focus theft on track update |
| Y1 | System volume/selected-display brightness plus separately proven OS overlay replacement; opt-in Windows wheel | Output/display switch, confirmed value/mute, precision/clamp, wheel over list unaffected; real hardware key/overlay suppression receipt |
| Y2 | Event-driven power/plug, visible opt-in CPU, connected Bluetooth, local date, qualified aggregate mic/camera | Batteryless/unknown units/stale values, duplicate plug, CPU reset/sleep/1 Hz, disconnect clearing, midnight/zone change; no media capture or app inventory |
| C1 | EventKit and proven Windows system source, separate Google read-only OAuth/native tokens | Real grant/denial/revoke, PKCE/state/registered redirect, expired/offline/sign-out clearing; Google cannot satisfy missing system source |
| C2 | Source-scoped upcoming/week/meeting join with selected calendars | 1000/1001 instances, DST/all-day/recurrence exceptions, source/calendar duplicate IDs, Sunday/Monday/system week; exact Zoom/Meet/Teams HTTPS host/path lookalikes |
| I1 | Resume existing rich-source qualification/adapters, not completed baseline/relay work | Actual isolated V2 and Hermes turns, reported counters/cwd/approvals only, memory/queue bounds, teardown while lookup/child outstanding |
| I2 | Real native ingress/order/lifetime and SwiftUI Details under existing inspector contract | Held bytes after pause/resume and after replay-marker expiry, emitter/session isolation; immediate hidden/open Details clearing; 640×280 view, Back/Escape/hold/VoiceOver |
| R1 | Compose all owners/cards/settings/permissions and native accessibility/performance | Transfer+media+calendar+Details+real approval; focus/scroll stable; pause cancels chosen active transfers; no hidden render loops; 60 Hz p95 ≤16.7 ms, input ≤100 ms, memory plateau |
| R2 | Target-specific install/upgrade/uninstall, resource inclusion, rights/signing/security | Stable IDs/preferences/secrets; relay/Rust bridge included; clean temp/services teardown; owner rights/signing/notarization/Defender receipts, separate distribution authority |

## Exact feature coverage

F1 retains the already authored hover work for native qualification. Every other row is planned, not implemented by this document. Platform/priority remain in the approved spec.

| Feature | Execution owner |
| --- | --- |
| Expand on hover | F1, R1 |
| Delayed open | F1, R1 |
| Now-playing display | G2, M1, M2 |
| Playback controls | G2, M1, M2 |
| Audio visualizer | M2 |
| Broad source support | G2, M1 |
| Media favorites | M2 |
| Collapsed media indicator | M2 |
| Volume HUD replacement | G3, Y1 |
| Brightness HUD replacement | G3, Y1 |
| Mouse-wheel volume | Y1 |
| Battery indicator | Y2 |
| Battery details | Y2 |
| Plug / unplug animation | Y2 |
| CPU monitor | Y2 |
| Bluetooth devices | Y2 |
| Date display | Y2 |
| Mic / camera in-use indicator | G5, Y2 |
| Upcoming events | G4, C1, C2 |
| Google Calendar integration | G4, C1 |
| Weekly view | C2 |
| Join meeting | C2 |
| File shelf / tray | S1, S2 |
| Open from shelf | S3 |
| System share | S3 |
| Message / mail sharing | S3 |
| Shelf ordering | S2 |
| Disable shelf | S2, S3 |
| Correct file drags | S3 |
| Nearby device list | G1, L1, L3 |
| Send from shelf | S3, L2, L3 |
| Drop-to-send | L2, L3 |
| Send text / clipboard | S2, L3 |
| Favorites | L3 |
| Manual address | L1, L3 |
| Incoming request prompt | L2, L3 |
| Auto-accept trusted devices | G1, L2, L3 |
| Save location | L2, L3 |
| Received files to shelf | S2, L3 |
| Visibility toggle | L1, L3 |
| Live progress in collapsed island | L3 |
| Detailed progress view | L3 |
| Multi-file queue | L2, L3 |
| State labels | L2, L3 |
| Cancel transfer | L2, L3 |
| Retry failed | S3, L2, L3 |
| Completion notification | L3 |
| Transfer history | L3 |
| Encrypted transfers | G1, L1, L2 |
| Device naming | L3 |
| Optional PIN | G1, L2, L3 |
| Permission prompts | G1, L1, L2, L3 |
| LocalSend settings (section 6.5) | L3 |

I1/I2 are additional inspector obligations, not a substitute for any of these 53 rows.

## Verification and checkpoints

- [ ] For each slice, record failing behavior using real module/native fixtures; a missing executable or source grep is not behavioral RED.
- [ ] Run owned focused tests plus `node --test tests/*.test.ts tests/*.test.mjs`, relevant TS/Vite/Cargo/native Swift checks, and both existing native workflows at the new SHA.
- [ ] Extend `scripts/test-notch-foundation.sh` / `scripts/test-agent-monitor.sh` only when their new executable checks exist. Strict modes remain nonzero while real acceptance is missing.
- [ ] Record hardware/source/client versions and minimized enum/count results in subsystem receipts. Never retain private payloads, files, token URLs, or raw agent/calendar/transfer diagnostics.
- [ ] Controller reviews spec, code quality, trust boundaries and all shared-file integration; stage only owned source/test/docs paths. Ordinary checkpoints may go to the authorized feature remote; no force/tag/release.
- [ ] A row becomes complete only after requested-platform user paths, denial/cancel/error, accessibility, reduced motion and composition pass. A disabled required capability is a blocker, not success.

## Prerequisites requiring user/owner action

Interactive Mac/Windows 10/11 devices, actual media sources/hardware, and a phone plus second desktop for LocalSend; legitimate Google OAuth client configuration; written asset rights and authorized signing/notarization/Windows clearance. No credentials are requested in chat. A public API conflict must be presented for a specific scope/design decision, never silently patched with private APIs or removed.

## Review handoff

Review this program map, the shelf task plan and capability gate plan. The existing execution method remains subagent-driven. Approval starts only the next dependency-safe implementation batch; it does not authorize binaries, new accounts/extensions/global hooks, unsafe capability substitutions or reopening finished work.
