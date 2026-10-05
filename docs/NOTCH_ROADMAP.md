# Infinite-Notch development roadmap

Source fork of [Coucou](https://github.com/Louis-CFM/coucou). **Development only;
not release-ready.** This roadmap sequences the approved expansion. It is not a
claim that planned features already work. Preserve the existing app until a
separately approved rebranding/asset-rights decision; never publish a packaged
derivative with restricted upstream assets without permission.

## Canonical documents

- [Approved full design and 52-feature coverage ledger](superpowers/specs/2026-10-04-notch-app-expansion-design.md)
- [Checkout/API inventory](research/notch-app-readiness.md)
- [First executable foundation plan](superpowers/plans/2026-10-04-notch-foundation.md)
- [Full release execution map and feature routing](RELEASE_READINESS.md)
- [Approved next native qualification plan](superpowers/plans/2026-10-04-native-qualification.md)
- [Actual native qualification results and remaining failures](research/native-qualification.md)
- [Remaining features: application, dependencies and execution](superpowers/plans/2026-10-05-remaining-features.md)
- [Next implementation slice: temporary shelf](superpowers/plans/2026-10-05-temporary-shelf.md)
- [Native capabilities that gate downstream implementation](superpowers/plans/2026-10-05-platform-capability-gates.md)
- [Existing agent-inspector plan](superpowers/plans/2026-10-03-agent-session-inspector.md)
- [Agent verified/pending receipt](research/agent-inspector-verification.md)
- [Build, verification, privacy and contribution guide](DEVELOPMENT.md)

The user approved built-in LocalSend, one shared Rust transfer engine, both native
UIs, staged delivery and the written master spec on 2026-10-04. The foundation
implementation plan was also approved. Bounded implementation and centralized
review/checks produced the first partial checkpoint; see
[the foundation receipt](research/notch-foundation-verification.md).

## Delivery map

| Stage | Dependencies | Work / required evidence | Current status |
| --- | --- | --- | --- |
| A: Reliability foundation | Reviewed first plan | Full hover/delay/independent holds, collision-safe owned copying, truthful ready state, cancellation/stale callback checks | Tauri/Linux and Mac hover compiler/test gates pass; Mac owned preparation and Windows full/native interaction gates pending; see native receipt |
| B: Multi-item shelf | A copy contracts | 32-item temporary files/folders/images/text shelf, remove/clear/order/disable, real native drag-out/open/share/Mail/Messages, bounded traversal and export leases | Not implemented; dedicated plan follows A |
| C: LocalSend core | Safe native file handles; qualified dependencies/bridge | Opt-in multicast roster, direct/manual address, HTTPS identity, prepare/upload/cancel, consent/save/safe partial commits, byte/integrity tests | Not implemented; native bridge/auth probes needed |
| D: LocalSend native UI | B and real C events | Devices, send/drop-to-send, incoming prompt, visibility, compact/expanded real progress, seven state labels, cancel, queue/retry/completion | Not implemented; no timed fake progress |
| E: Transfer extras | C/D security and lifecycle | Explicit text/clipboard, favorites, authenticated trust/auto-accept, receive-to-shelf, PIN, opt-in local history/retention, name/port/interface settings | Not implemented; incoming identity proof gate |
| F: Media | Qualified native source capabilities | Art/title/artist, play/pause/skip/seek, broad sources, decorative waveform/compact indicator, Windows favorites | Mac Apple Music baseline only; rest pending |
| G: System HUD/status | Qualified actual target APIs/hardware | Real volume/brightness and OS-overlay suppression, wheel volume, battery/details/plug animation, CPU, connected Bluetooth, date, mic/camera candidate | Not implemented; suppression/in-use capability gates |
| H: Calendar | Permission/source/OAuth qualification | System calendars, Windows Google, upcoming/week/week start, safe one-click meeting join, recurrence/time-zone cases | Cal.com baseline only; new scope pending |
| I: Rich agent inspector | Existing approved privacy/host contracts | Rich V2/Hermes source qualification/producers, native ingress ordering/lifetime, SwiftUI inspector, composed approval regression | Partial synthetic/baseline evidence only |
| J: Native polish/release | All required coverage rows and I | Target devices/builds, accessibility, frame/input/idle measurements, independent LocalSend clients, sandbox, signed packaging/license checks | Blocked; no app release is authorized |

Priority controls order inside each stage, never erases P1/P2 scope. Media/system/
calendar are independent after qualification and may overlap the shelf/transfer
path under their own reviewed contracts. Do not put the whole roadmap into one
worker prompt or prebuild frameworks for later stages.

## Required qualification decisions before downstream plans

| Gate | Probe and evidence needed | Fail-closed outcome |
| --- | --- | --- |
| Mac Rust bridge | Native static-library linking; start/stop/cancel/free; sandbox-selected directory access | No unsafe callbacks or claimed Mac transfer integration |
| LocalSend incoming trust | Actual official v2 client TLS/proof behavior, forged claimed fingerprint/IP requests | Manual acceptance remains; auto-accept unresolved until proof or explicit revised scope |
| Mac broad-source media | Public/source-specific access to named players, actual art/control/seek, browser permissions | No private framework or invented global Now Playing API |
| OS HUD replacement | Documented interception/suppression on supported Mac/Windows, actual hardware test | Do not call a second overlay replacement; obtain scope/capability decision |
| Windows system calendar | Documented API for actual desktop package and consent | Google integration is not a silent substitute |
| Mic/camera candidate | Public aggregate in-use signals without capture or application inventory | No recording or permission-as-use inference |
| Distribution | Owner-approved signing, Defender clearance, artwork rights | Source checkpoints only; publishing pause retained |

These are investigation tasks, not known API selections. Record minimized findings
in `docs/research/` centrally. When a gate changes architecture or reduces requested
behavior, get the user's decision before finalizing that subsystem's plan.

## Checkpoint policy

- Target: `https://github.com/ATLAS-DEV78423/Infinite-Notch.git`.
- Branch: `feat/notch-expansion`. Preserve the original `origin` remote.
- Commit one reviewed logical change at a time with conventional messages and
  actual checks in the receipt. Push ordinary feature commits, never force push.
- Exclude local credentials/configuration, inbox attachments, private recovery
  notes/logs, caches, build output and qualification runtime state. Public docs use
  stable source/test references, not copied private memory.
- Push does not mean release. A failing/unavailable strict gate stays red and is
  documented; don't modify the gate merely to make a checkpoint appear qualified.
- Keep upstream copyright/license notices. This source fork is permitted by the
  code license; see [the asset restrictions](../LICENSE-ASSETS.md) before packaging.

## Completion rule

Each implementation task must name its exact files/interfaces, reproduce its
regression before the fix, implement the minimum complete flow, run real checks
and get a scoped review. Update coverage with results, not intentions.

Full completion requires all 52 rows and settings in the master spec, plus the
rich agent inspector and native release/security/performance gates. No unit-test
count, browser screenshot or milestone label substitutes for real device evidence.
Mac/Windows execution and account/signing access are missing from this Linux
workspace; their absence is recorded, not silently treated as optional.
