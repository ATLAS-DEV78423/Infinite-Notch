# Infinite-Notch release execution map

2026-10-04. **Planning document, not release qualification.** The user requested
full functionality/usability, explicit planning and subagent-driven development
with Ponytail. The [approved design](superpowers/specs/2026-10-04-notch-app-expansion-design.md)
remains the requirement authority. Nothing here removes P1/P2 features or relaxes
privacy, consent, file-integrity, native-performance or distribution requirements.

## Starting point and definition of done

Preserve source checkpoint `d537404a3d1bcadc804637f9a1f828c7af778e89` on
`infinite-notch` / `feat/notch-expansion`; upstream `origin` is not a delivery target.
The [foundation receipt](research/notch-foundation-verification.md) describes
implemented Tauri/Linux work, not completed Mac/Windows parity. The
[agent receipt](research/agent-inspector-verification.md) likewise remains partial.

A feature is complete only when its real user path passes on its requested
platforms, including denial/error/cancel, keyboard/screen-reader operation,
reduced motion and concurrent approvals. Unknown fields stay unavailable. A
disabled required capability is a blocker, not a functional implementation.
Compilation, fixture tests, native interaction and distribution are separate
evidence categories. No combined test count or milestone label completes release.

Use existing SwiftUI/AppKit, Tauri/DOM and the approved shared Rust transfer core.
Keep Mochi/cards/motion during development. Ponytail full is supplied by the
current session; `@dietrichgebert/ponytail` is referenced in local configuration.
Do not reinstall it, upgrade installed agents or alter global settings/accounts.
Delegate implementation only, with exact nonoverlapping files and no nested
agents; the controller owns investigation, review and integrated verification.
Load `omnirush-swarm` before any batch of three or more implementation agents.

## Execution order

Each downstream subsystem gets its own concrete file/interface/test plan before
implementation. Do not invent API contracts before their capability gates pass.
This map sequences the entire approved scope; the
[native qualification plan](superpowers/plans/2026-10-04-native-qualification.md)
is the first new executable plan, approved by the user on 2026-10-04. The already approved
[foundation plan](superpowers/plans/2026-10-04-notch-foundation.md) is not restarted.

| Stage | Implementation and dependency | Exit evidence / next plan |
| --- | --- | --- |
| 0. Native build access | Build-only hosted Mac/Windows and Linux compatibility checks; no packages/secrets/uploads | Exact-SHA real Swift/Xcode and Windows Rust tests/builds; fix observed failures. Then resume approved foundation Tasks 2/4 sequentially |
| 1. Complete foundation | Mac full-hover/holds/settings plus owned asynchronous copy and real readiness; Windows copy/restart safety and native input qualification | Deterministic timer/ownership tests and actual native drop/keyboard/approval cases. No UI timer generates readiness |
| 2. Temporary shelf | Safe files/folders/images/text, 32-item admission, order/remove/disable and native export leases | Duplicate/cancel/limits/reparse/disk tests; real Finder/Explorer and attachment-consumer drags; native open/share/Mail/Messages. Dedicated shelf plan after copy contracts qualify |
| 3. Secure LocalSend core | Shared Rust discovery, verified HTTPS identity, consent/session/token/path validation and streamed no-overwrite commits; narrow lifetime-owned Mac bridge | Actual Mac start/stop/cancel/free bridge test; spoof/traversal/token/size/checksum/disk failures; independent phone/desktop v2.2 exchange. Core plan before UI accepts transfers |
| 4. LocalSend UI/extras | Both shells' device picker, separate consent queue, truthful compact/detailed progress, cancel/retry and all transfer preferences | Core counters/terminal results match UI; default receive/history off; favorites never authorize trust; authenticated incoming auto-accept must qualify separately |
| 5. Media and system | Qualified source adapters/art/seek/controls; public native volume/brightness/power/CPU/Bluetooth/date capabilities | Real named sources and hardware, stale-source control rejection, no hidden polling/rendering, supported HUD replacement. Separate media/system plans; capability decisions first |
| 6. Calendars | Native system sources plus explicit Google read-only OAuth; upcoming/week/known-host meeting join | Real permission/revoke/offline flows, recurrence/all-day/DST/link checks and secure tokens; dedicated calendar plan after Windows system-calendar access qualifies |
| 7. Rich inspector | Continue existing agent plan: qualified rich sources, native ingress/lifetime bounds and SwiftUI Details | Real isolated agent turns, held-byte/control/pause/reset races, no private logs/storage/network; existing Claude/Codex approvals unchanged |
| 8. Compose and release | All above together: focus/accessibility, hardware motion/idle/memory, sandbox, clean install/upgrade/uninstall, rights/signing | Every coverage obligation and design section 13 passes against the intended release SHA; only then separately authorize packaging/publication |

Stages 2–4 are sequential where shelf/export/core contracts depend on one another.
Capability research for 5/6 can proceed while earlier code is built, without
starting speculative adapters. The rich inspector source/transport lanes may
proceed independently, but its Mac UI follows foundation changes to shared
`AppState`/FSM/controller files. Media/system/calendar workers must not concurrently
edit shared shell registration/state/settings files; integrate those centrally.

## First batch and review discipline

After reviewing the new native plan, start two implementation subagents together:
one owns Mac qualification, one owns Windows/Linux qualification. They do not
touch product behavior, release workflows, signing identities or public artifacts.
Controller reviews their actual diffs and syntax/security checks, then commits
explicit public paths and pushes normally to the existing feature branch.

Observe the resulting Actions run IDs and exact head SHA. No blind redispatch or
rerun after interruption; inspect existing runs first. Diagnose each real native
failure and give a fresh worker only the proven repair scope. Mac foundation
Tasks 2 and 4 run in order once a usable Swift/Xcode lane exists; do not duplicate
the completed Tauri Tasks 1/3/5. Each behavioral repair starts with a failing
regression; configured workflow checks are linted and exercised on real runners.

At each slice: spec review, code-quality/privacy review, smallest meaningful
checks, related existing checks, native evidence where available, documented
checkpoint. Prefer two disjoint workers; use three/four only when three/four
independent implementation parts genuinely exist. No extra research/test/review
agents to inflate activity. Required skills are loaded when their phase starts:
subagent-driven-development, test-driven-development, relevant OmniRush build/
feature/debug/test guide, verification-before-completion and Ponytail. Use the
swarm guide only when required; do not run every installed skill mechanically.

## Capability decisions that cannot be faked

| Gate | Required finding | If unavailable |
| --- | --- | --- |
| OS-HUD replacement | Public supported suppression/interception on both requested OSes, independently from value control | Full replacement stays blocked; request a specific scope decision, never hide the OS overlay with private/global hooks |
| Mac broad media | Per-source authorized metadata/control/seek/art for Music, Spotify, YouTube browser, podcast and local player | Explain the missing source/API; no private reader, browser scrape or implicit extension |
| Windows system calendar | Supported API/permission for the actual desktop packaging | Google/Cal.com cannot substitute for the requested system source |
| Trusted auto-accept | Actual incoming sender proves possession of the pinned identity, interoperable with real LocalSend clients | Manual consent remains enforced; claimed fingerprints/IPs/reverse connections are not proof |
| Mic/camera in-use | Public aggregate in-use state without capturing media or enumerating applications | Permission-granted cannot be displayed as in-use; unresolved capability remains visible |
| Native Rust Mac bridge | Correct callback/buffer ownership, asynchronous executor and cancellation/shutdown on actual Mac | No untested C ABI is wired into a release app |

These are sharp decision gates from the approved design, not permission to silently
drop features. If a required capability cannot exist under the approved safety
contract, present the conflict for a user decision before changing that contract.

## Full coverage routing

All 52 features plus the LocalSend settings row in design section 12 are routed
below. Priorities/platforms and exact safety bounds remain in that canonical
ledger. **No row below is native-qualified complete.** Partial means authored/
portable-tested only; pending includes extending or qualifying upstream behavior.
Add a revision/run/device receipt before changing a row to qualified.

| Feature | Stage | Current evidence / required acceptance |
| --- | --- | --- |
| Expand on hover | 1 | Partial Tauri; Mac parity and both native travel/focus cases pending |
| Delayed open | 1 | Partial Tauri; exact 0–1000 ms, stale timer and independent holds on both shells |
| Now-playing display | 5 | Existing Mac Music-only path; named sources/Windows metadata pending |
| Playback controls | 5 | Existing limited Music controls; target-source confirmation and seek boundaries |
| Audio visualizer | 5 | Pending decorative playback wave; paused/hidden/reduced-motion stop |
| Broad source support | 5 | Pending source-by-source capability/permission/control qualification |
| Media favorites | 5 | Pending explicit Windows selections; no listening-history inference |
| Collapsed media indicator | 5 | Pending current artwork/play state, no stale source after switch |
| Volume HUD replacement | 5 | Pending actual system control plus independent supported OS suppression gate |
| Brightness HUD replacement | 5 | Pending selected-display capability/value plus independent OS suppression gate |
| Mouse-wheel volume | 5 | Pending Windows opt-in target-only/precision/clamp behavior |
| Battery indicator | 5 | Pending real percentage/charging/power source; unavailable on batteryless devices |
| Battery details | 5 | Pending supplied units/estimates only; absent/stale/multiple-battery cases |
| Plug / unplug animation | 5 | Pending native event/debounce; no duplicate animation spam |
| CPU monitor | 5 | Pending opt-in visible aggregate sampling ≤1 Hz; stop/reset/sleep checks |
| Bluetooth devices | 5 | Pending opt-in connected-only roster; real battery/unknown/disconnect handling |
| Date display | 5 | Pending locale/zone/midnight/clock-change behavior |
| Mic / camera in-use indicator | 5 | Pending public aggregate capability decision; no capture/application inventory |
| Upcoming events | 6 | Pending real native sources, selected calendars/range, recurrence/denial/offline |
| Google Calendar integration | 6 | Pending Windows explicit OAuth PKCE/state/read-only scope/secure tokens/revoke |
| Weekly view | 6 | Pending locale/system/Sunday/Monday preference, all-day/DST/overlap cases |
| Join meeting | 6 | Pending parsed exact HTTPS Zoom/Meet/Teams host/path, explicit click only |
| File shelf / tray | 2 | Pending bounded 32 items/files/folders/images/text; no silent dropped batch items |
| Open from shelf | 2 | Pending explicit ready native file open; never inferred shell execution |
| System share | 2 | Pending actual supported Mac/Windows share UI with ready/export lease |
| Message / mail sharing | 2 | Existing single-context Mac mail path; explicit multi-item ready attachments pending |
| Shelf ordering | 2 | Pending stable item IDs and original/newest-first preference |
| Disable shelf | 2 | Pending cancel/clear with active lease protection, originals/received files untouched |
| Correct file drags | 2 | Pending native file payload/lease evidence in Finder/Explorer and attachment consumer |
| Nearby device list | 3/4 | Pending bounded opt-in local discovery, expiry/interfaces/firewall/busy states |
| Send from shelf | 4 | Pending explicitly chosen ready data/peer; no send on shelf drop |
| Drop-to-send | 4 | Pending explicit send target and safe multi-item preparation/consent |
| Send text / clipboard | 4 | Pending explicit one-time read/preview/send; no clipboard polling/history |
| Favorites | 4 | Pending explicit ranking/preferences; favorite cannot authorize auto-accept |
| Manual address | 4 | Pending validated local address/interface/port; no arbitrary advertised URL fetch |
| Incoming request prompt | 4 | Pending separate bounded consent queue; cannot occupy agent approval owner |
| Auto-accept trusted devices | 3/4 | Pending incoming authenticated possession proof; manual consent until qualified |
| Save location | 3/4 | Pending native choice/bookmark/handle, permission/free space and safe commits |
| Received files to shelf | 4 | Pending opt-in references; clear never deletes committed saved files |
| Visibility toggle | 3/4 | Pending default-off, bind/advertise/permission and immediate stop-new-requests |
| Live progress in collapsed island | 4 | Pending actual core counters ≤4 Hz; routine update does not expand/focus |
| Detailed progress view | 4 | Pending real bytes/size/speed/ETA; unknown stays unavailable |
| Multi-file queue | 3/4 | Pending bounded sequential per-file states/partial failure; no unbounded workers |
| State labels | 4 | Pending waiting/sending/receiving/completed/declined/cancelled/failed from core |
| Cancel transfer | 3/4 | Pending local I/O/token/callback revocation and honest best-effort remote cancel |
| Retry failed | 4 | Pending explicit new session/consent; valid source lease or reselect, no history path read |
| Completion notification | 4 | Pending verified commit/ack terminal event; explicit open/reveal, no focus theft |
| Transfer history | 4 | Pending independent opt-in ≤50 batches/7 days, immediate clear/off and no private payloads |
| Encrypted transfers | 3 | Pending HTTPS-only pinned identity, first contact/change confirmation and downgrade rejection |
| Device naming | 4 | Pending user preference and bounded untrusted alias display; not identity |
| Optional PIN | 3/4 | Pending interoperable preparation query/rate limiting; PIN/URL never logged |
| Permission prompts | 3/4 | Pending explanation-before-bind/save plus actual OS denial/revoke; no repeated prompt loop |
| LocalSend settings (section 6.5) | 4 | Pending name/visibility/save/favorites/trust/shelf/history/port/interface settings with safe defaults |

The rich OpenCode/Hermes inspector and existing Claude/Codex regression are
additional stage-7 requirements, not substitutes for any expansion row above.
Canonical strict checks remain red while required acceptance is missing.

## Usability and release acceptance

For every affected card/action, record the real action and its observed result,
not just that a button exists. Check loading/empty/unknown/denied/offline/error,
cancel/retry, selected-owner stability, native accessibility name/role and visible
keyboard focus. Background changes never replace a request, reset scroll or steal
focus. Exercise combined transfer + media + inspector + existing approval cases.

On representative Mac and Windows devices: native 60 Hz p95 visible frame time
≤16.7 ms (actual budget for other refresh rates), configured-delay-excluded input
feedback ≤100 ms, ordinary progress ≤4 Hz, no hidden decorative rendering,
memory plateau over repeated open/clear/transfer cycles and no UI-thread copy/
hash/network. Record hardware, OS, build revision, workload and measurements.
Hosted headless jobs cannot supply notched-display, hardware-key, screen-reader,
Bluetooth/battery, installer or cross-device LocalSend evidence.

Distribution prerequisites are owner-controlled:

- [Asset rights](../LICENSE-ASSETS.md) do not permit publishing derivatives with
  Coucou/Mochi/icon/sounds without written permission. Renaming alone is not a
  license. Preserve them in development; permission or an explicitly approved
  asset replacement is required before public binaries.
- Mac signing/notarization and separate App Store entitlements/sandbox review
  require authorized identities. Do not reuse the upstream signing team as the
  fork's owner or request secrets in chat.
- Windows signing/Defender clearance must resolve the existing publication
  pause. `PUBLISH: false` stays false; do not weaken SmartScreen/OS security to pass.
- Google Calendar needs the owner's legitimate desktop OAuth configuration and
  user consent, supplied through secure configuration, not committed credentials.
- Test clean install/upgrade/uninstall, versions, relay/bridge inclusion, secret/
  preference survival and owned temp cleanup. Do not tag/publish/install globally
  merely because tests/builds are green.

Before calling the intended release ready, reconcile every row against a current
receipt, rerun strict privacy/native gates, review the entire composed diff and
confirm no unresolved required capability/distribution blocker remains. If owner
access/rights are missing, name the exact prerequisite; do not claim completion.
