# Platform Capability and Downstream Plan Gates

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` for any approved prototype implementation. Steps use checkbox (`- [ ]`) syntax. The controller performs primary-source research, reviews native evidence and writes downstream plans.

**Goal:** Establish real supported capabilities for LocalSend, broad media, system HUD/status, calendars and aggregate device use before promising or implementing unsupported features.

**Architecture:** Use the existing shells/native APIs and minimal owned probes. Separate build/API availability, actual user permission/device behavior and cross-device interoperability. A successful probe freezes a narrow source contract for its own subsystem plan; failure stays an explicit full-feature blocker.

**Tech Stack:** Existing Swift 6/Xcode lanes, Rust/Tauri Windows/Linux lanes, installed `windows` crate/current networking client stack, documented Apple/Microsoft/LocalSend/Google APIs. No private frameworks, injected browser readers, global hooks or infrastructure enrollment.

**Spec:** [Approved expansion sections 3, 6–10, 13](../specs/2026-10-04-notch-app-expansion-design.md), [execution map](2026-10-05-remaining-features.md), existing [source inventory](../../research/notch-app-readiness.md).

**Status:** User approved this gate plan with the execution map and shelf plan on 2026-10-05 through “Approve and continue”. These tasks qualify contracts, not product-ready feature claims. Old inventory facts are leads, not current supported-runtime evidence. Product subsystem plans follow accepted results; no guessed library/API is installed merely to fill a planning box.

## Global Constraints

- Use only publicly documented, license-compatible APIs, minimum requested permissions and owner-authorized accounts/devices.
- No transcript/browser-profile/process/application inventory or capture for inference. Read only synthetic probes or explicitly selected authorized source fields.
- Minimized public receipts contain version/API/enum/count/result, never raw private URLs, metadata, files, tokens, credential values or captured user content.
- Keep HTTPS-only LocalSend and incoming proof/consent requirements. Invalid/unsupported/denied is not success; favorites and reverse connections cannot authorize auto-accept.
- Preserve read-only no-upload native workflows and both Mac schemes. Prototype native code is kept out of production builds until its subsystem plan is reviewed.
- Existing Mac/Windows builds do not establish desktop permission/hardware behavior. If native devices or owner OAuth setup are unavailable, state exactly which gate is blocked.
- Do not weaken sandbox/concurrency/OS security, change global settings/install agents or start a service against real user data to pass a probe.

## Review Focus

1. A prototype compiles on hosted Server 2022 but fails on intended desktop packaging: distinguish package capability/runtime grants (G2/G4).
2. A media source or peer changes identity before a delayed control/reply: stale operation must fail, never act on the new target (G1/G2).
3. OS value control exists but overlay suppression does not: do not report HUD replacement (G3).
4. Claimed incoming LocalSend fingerprint passes string matching without private-key proof: auto-accept remains blocked (G1).
5. A calendar source exposes read access but token revoke or range filtering does not clear data: reject the contract before UI integration (G4).

## Uniform evidence contract

Controller writes one receipt per G task under `docs/research/` with fields:
`target`, `minimumOS`, `testedOS`, `packaging`, `api`, `permission`, `sourceVersion`,
`checkedSHA`, `commands`, `capability: supported|unsupported|denied|unverified`,
`actualResult`, `cleanup`, `blockingRequirement`, `nextPlan`.

Public API documentation alone yields `unverified` runtime capability. Tests use invented identities/content; devices/accounts receive only explicit human-consented synthetic actions. Keep raw probe state outside the worktree. No result is promoted by source text assertions or silent skipped tests.

### G1: LocalSend dependencies, Mac bridge, TLS and incoming identity proof

**Files:** Receipt `docs/research/localsend-capabilities.md`; isolated probe sources `tests/native/localsend-bridge/{Cargo.toml,src/lib.rs,BridgeProbe.swift}` and `scripts/test-localsend-bridge.sh` only after approval. Future production `windows/transfer-core/` is not created by a documentation-only gate.

**Consumes:** Current Rust workspace uses Tokio networking/runtime and reqwest with rustls TLS as a client; neither is a qualified receiving HTTPS server/certificate identity solution by itself. Existing native shelf leases are a separate dependency.

**Produces:** Qualified minimal library/license/version/features decision; observed protocol/client contract; native start/event/cancel/shutdown/free ownership receipt. C ABI signatures are frozen only after actual probe results, not declared supported now.

- [ ] Read exact v2.2 `/prepare-upload`, `/upload`, `/cancel`, discovery/version/fingerprint/PIN/checksum contracts from [LocalSend protocol](https://github.com/localsend/protocol/blob/main/README.md). Record revision and compatibility; reject documented plaintext/browser-download modes under our spec.
- [ ] Compare existing dependencies with minimum proven HTTPS-server/TLS/certificate/token/hash components; review license, security maintenance, Mac/Windows support and minimal features. Record exact pins/lockfile proposal; never hand-roll cryptography or disable verification globally.
- [ ] Specify and implement a throwaway bridge owner: asynchronous start, owned callback context, copied bounded event bytes, opaque operation IDs, cancel, shutdown/join, single buffer-free responsibility. Prove callback-after-shutdown, double-release refusal, start/stop loop, cancel during callback and actual buffer lifetime on Mac. Keep sockets/production storage out of this first ABI lifetime probe.
- [ ] Execute real Swift/Rust probe checks and both target link/build forms; then exercise local-network permission denial/revoke and sandbox receiving permission on actual Mac. Gate the production ABI if runtime ownership/permission is not proven.
- [ ] With independently installed compatible phone and desktop clients, exercise HTTPS identification, request preparation/partial acceptance, synthetic byte exchange, supplied checksum mismatch and optional PIN. Record actual versions, not only same-process fake clients.
- [ ] Inspect documented incoming authentication and actual client connection behavior. Forged claimed fingerprint, same IP/device alias and successful reverse connection must not trigger trust. Auto-accept requires incoming possession proof interoperable with real clients; if unavailable, request an explicit protocol/scope decision while preserving manual consent.
- [ ] Controller writes the dedicated LocalSend-core plan: core events/IDs/lifetime, native directory and secure identity handles, discovery expiry, strict tokens/path commits, queue/progress/cancel, interoperability. Only then may L1/L2 workers own the real crate; L3 follows real core events and shelf leases.

Expected probe assertions: after shutdown returns, callback count cannot increase; each owned buffer is freed exactly once; forged peer never receives an auto-accepted session/token; HTTPS downgrade never obtains a file lease. Missing devices leave the corresponding runtime gate blocked.

### G2: Broad media sources and acknowledged target controls

**Files:** Receipt `docs/research/media-capabilities.md`; opt-in probe tests `tests/native/media/MediaProbe.swift`, `tests/native/media/windows-media.rs` when approved. No edits to `MusicController.swift` until M1's plan freezes its integration.

**Consumes:** Existing direct-build Apple Music notifications/automation, currently excluded from App Store; Windows GSMTC primary API family, not yet enabled/qualified in current feature flags.

**Produces:** Per-source/target matrix for stable identity, title/artist, art, play state, duration/position, play/pause/skip/seek and observed permission/acknowledgment. Each field is reported/unavailable with a reason, never inferred by audio capture.

- [ ] Read [Microsoft GSMTC](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager) and documented per-source Mac APIs; distinguish own-app metadata publishers from cross-app readers. Confirm exact desktop packaging/minimum OS/capability requirements.
- [ ] Define a minimal source identity snapshot and action with expected source generation; test stale seek/control after source switch, unknown/live duration and two simultaneous sources before implementation.
- [ ] Probe Apple Music, Spotify, YouTube browser playback, podcast and local player on requested platforms. Explicit source-specific integration/automation permission is required; no browser scrape/profile access or implicit extension. Respect actual user playback—synthetic test tracks and human-approved controls only.
- [ ] Record actual action acknowledgment, art format/size/timeout restrictions and disconnect/revoke cleanup. If only sending a command is observable, do not equate it with successful playback change.
- [ ] Write M1/M2 implementation plans using qualified APIs only: adapter ownership/source IDs, in-memory bounded art, seek capability, decorative playback wave, compact indicator and explicit Windows favorites. Missing broad-source support remains a requirement blocker, not a fallback marked complete.

### G3: System control and independent HUD suppression

**Files:** Receipt `docs/research/system-capabilities.md`; isolated probes `tests/native/system/SystemProbe.swift`, `tests/native/system/windows-system.rs` after review. Product `SystemStatus.swift` / `system_status.rs` follow Y1/Y2 plans.

**Consumes:** Native Core Audio/Windows endpoint families, documented selected-display brightness and power/aggregate/connected-device APIs. Existing app sound-volume preference is not system volume.

**Produces:** Separate capability records for value notifications/control and safe OS-HUD suppression, with selected endpoint/display IDs and actual native permission/hardware evidence.

- [ ] Verify primary OS APIs for system audio/mute/output switching, internal/external display brightness and minimum OS/permissions. Separately locate supported overlay interception/suppression; an island overlay beside the OS overlay does not qualify replacement.
- [ ] Add actual target-switch/value-confirmation, absent-battery and denial probes. Exercise human-approved hardware keys/sliders/display/output changes; do not globally hook keys, disable services, edit system files or use private APIs.
- [ ] If public overlay suppression is absent or does not work on required hardware, record blocked Volume/Brightness HUD replacement and request a specific design/scope decision before Y1 claims it delivered. Continue only independently qualified features, not a deceptive substitute.
- [ ] Qualify power fields/units and multi-battery semantics; connected-only Bluetooth battery/change events; aggregate CPU delta/reset behavior and local date/zone notifications. Unknown supplied watts/health/ETA stay unavailable, not zero.
- [ ] Write Y1/Y2 plans: target-bound controls, opt-in Windows wheel only over intended island target, event-driven power/plug debounce, visible opt-in CPU ≤1 Hz, connected-device clear/disable and midnight/zone reset. Include hidden-work/reduced-motion and actual hardware regressions.

### G4: Native calendars and legitimate Google OAuth

**Files:** Receipt `docs/research/calendar-capabilities.md`; isolated EventKit/Windows probes `tests/native/calendar/CalendarProbe.swift`, `tests/native/calendar/windows-calendar.rs` when approved. OAuth inputs remain secure external owner configuration, not repository fixtures.

**Consumes:** EventKit target read-access/purpose-text APIs, a documented Windows desktop system-calendar access path, existing native secure stores and safe web URL handling. Cal.com is preserved but cannot substitute for either system source.

**Produces:** Qualified per-source permission/query/change/revoke contract; legitimate registered Google redirect/read scope/PKCE/state/token ownership design; only the minimal normalized in-memory calendar fields.

- [ ] Read primary EventKit macOS and Windows calendar API/package documentation. Prove actual selected-calendar read access and denial/revoke behavior on the intended desktop/sandbox packaging; hosted compilation is insufficient.
- [ ] Define synthetic calendar fixtures with scoped event IDs, instant times/all-day dates/source zone, recurrence exceptions and meeting URLs. Query only upcoming seven days or visible week, maximum 1000 expanded instances; prove overflow, disable and permission loss clear content/subscriptions.
- [ ] Ask the owner for legitimate Google desktop client setup through secure configuration only when implementation requires it. Design system-browser consent, registered redirect, PKCE/state, minimum read-only event scope and native secure tokens; no key in chat/frontend/URLs/logs/repository.
- [ ] Test OAuth stale/wrong-state callback and revoke/sign-out cleanup locally with invented tokens; real authorization/expiry/offline behavior requires the explicitly connected test account. No repeated background sign-in windows.
- [ ] Write C1/C2 plans after system-source proof: source-scoped queries, token refresh ownership, recurrence/all-day/DST/week-start rules and exact parsed HTTPS meeting hosts/paths. Google success cannot clear missing Windows system-calendar acceptance.

### G5: Aggregate microphone/camera in-use state

**Files:** Receipt `docs/research/device-use-capabilities.md`; metadata-only native probes under `tests/native/device-use/` if a primary supported API is identified. No capture/session recording code is authorized.

**Consumes:** Public aggregate OS in-use state only; permission-granted and known device existence are not use indicators.

**Produces:** Supported aggregate state plus disable/revoke notification behavior, or an explicit required-capability conflict for user review.

- [ ] Find primary native APIs exposing aggregate in-use state without recording/loopback capture or application/process enumeration; confirm actual packaging/permission applicability.
- [ ] If supported, prove inactive→active→inactive while the human runs a synthetic capture in their own test app, with Coucou never opening the capture device. Denied/unavailable/disabled must clear old indicators.
- [ ] If unsupported, write the exact conflict; keep Both/P2 coverage assigned and request a scope/design decision. Do not infer from app lists, audio samples or granted permissions.
- [ ] Carry only a proven metadata subscription into Y2's reviewed contract; no polling/capture fallback.

## Completion, stop conditions and next plans

A G task passes only the capability statements it actually observed. Mixed supported/unsupported results are per-field/per-platform, not one green bucket. Missing hardware/account/runtime remains pending. A required unsupported capability blocks the full feature unless the user explicitly changes the contract.

After receipts, write and review separate LocalSend-core/UI, media, system and calendar implementation plans with concrete files/signatures/tests/commands. Preserve the existing inspector plan and continue its unfinished real-runtime/ingress gates independently; do not write another competing protocol. The full dependency/feature routing lives in [the program map](2026-10-05-remaining-features.md).

No probe sends real files or makes real account changes without explicit authority. No public binaries, tags, uploads, global hooks or paid/self-hosted runners are implied by plan approval. Each prototype stays isolated, leaves a runnable check, and is either discarded or deliberately integrated through its reviewed subsystem plan—not relabeled as product implementation.
