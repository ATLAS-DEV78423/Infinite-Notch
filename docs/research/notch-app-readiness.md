# Coucou expansion: implementation inventory and release gates

2026-10-04. Research/coverage inventory, not an approved implementation plan or
passing release receipt. The uploaded `notch-app-feature-spec.md` supplies the
requested outcome; its priorities determine order, not permission to discard P2.

## Intent and confirmed decision

Deliver the requested notch/island features while preserving Mochi, existing
cards/motion, current agent approvals and the privacy-first inspector work.
Ponytail remains active: reuse native capabilities/current modules; no new UI
framework, service platform or speculative abstraction.

**User decision:** built-in LocalSend protocol, not installed-app handoff. The
island must own discovery, incoming consent, real transfer progress and cancel.
That initial decision approved the architecture, not an implementation by itself.

The user subsequently approved preserving both native UIs, one shared Rust
LocalSend engine, the staged delivery direction, and consent-first/temporary
shelf/opt-in defaults. The complete written contract is now
[the expansion design](../superpowers/specs/2026-10-04-notch-app-expansion-design.md);
The user approved that written spec on 2026-10-04. The detailed foundation plan
is now written; implementation-plan review remains pending.

## Current implementation compared with the attachment

| Requested area | Verified checkout evidence | Remaining work / gate |
| --- | --- | --- |
| Hover expansion and delay | Swift/TS island FSMs already own motion and holds. Hover currently reveals compact; click opens full view. | Spec requests full hover expansion. Design delay/leave behavior without breaking agent approval or keyboard/drag holds; timer/transition tests on both implementations. |
| Now playing and controls | `MusicController.swift` observes Apple Music, with title/artist/album and AppleScript play/pause/skip; GitHub build only. | No broad-source/Windows implementation, album art or seek. Qualify source permissions/APIs and stale-session controls. |
| Visualizer / compact media / favorites | Existing Mochi dance reacts to `musicPlaying`. | New media indicator/favorites; distinguish decorative play-state waves from real audio sampling. Real sampling requires explicit capture permission, not an implicit microphone loopback. |
| Volume and brightness HUD | Existing sound-volume preference controls Coucou sounds, not system output. | New hardware adapters and island HUD. Suppressing OS overlays is a separate capability gate, not proved by displaying a second overlay. |
| Battery / plug / detailed power | No battery/power collector found in app sources. | Event-driven OS APIs, unplug animation, missing-sensor states and batteryless desktops. Report watts/health/time only when supplied. |
| CPU / Bluetooth / date | No corresponding system collector found. | Opt-in bounded sampling; actual connected-device batteries only; local date/week start. No broad app inventories. |
| Mic/camera in use | Priority/platform unspecified in attachment. | Platform/privacy API qualification; never acquire/record media just to detect usage. |
| Upcoming / weekly system calendar | `CalcomPoller.swift` fetches configured Cal.com bookings, not system calendars. | EventKit/native Windows capability qualification, permission-denied states, recurrence/time zones/DST; Google Calendar OAuth for Windows. |
| Meeting join | Existing safe web-URL handling exists. | Parse known meeting URLs from permitted events; explicit click, no script/custom-scheme execution by default. |
| File shelf | Both platforms currently keep one dropped-file/chat context; first dropped URL/path only. | Bounded multi-item shelf; file/folder/image/text entries, remove/clear/order/disable, native drag-out and system share. |
| File safety | Rust `files.rs` copies into inbox, disallows folders, tries collision suffixes 2..999. Swift drop removes destination with the same name before copying. | No-overwrite atomic reservation; copy error/cancellation; safe temp ownership. Existing loop exhausts suffixes; concurrent callers can race. These are source-inspection risks, not yet failing-test receipts. |
| Drop progress | Swift `FileDropHandler` and TS `swallow` start a timed Mochi animation while copying asynchronously. | Do not reuse timed animation as a real transfer/copy byte gauge. Ready must depend on actual completion; late callbacks must not replace another drop. |
| Open / native file drags / share | macOS has email/share composition for a single context. Incoming Tauri path events exist. | Shelf double-click/open policy; actual native file payloads (not string paths); folder drags, AirDrop/Windows share; cross-app tests. |
| LocalSend discovery / send / receive | No LocalSend implementation found. | New opt-in native UDP + HTTPS subsystem, bounded device roster, consent, selected directory, integrity-safe writes, cancel and truthful progress. |
| LocalSend extras/settings | Existing settings/OS credential storage can be reused. | Favorites vs trust, text/link sending, address entry, PIN, receive-to-shelf, queue/history retention, naming/port/interface settings. |
| Agent inspector | Qualified V2 baseline; synthetic Tauri inspector; bounded producers/relay. Existing prior work is preserved. | Rich source normalization, true Hermes turns, transport lifetime, SwiftUI inspector and platform acceptance remain open. See [receipt](agent-inspector-verification.md). |

## Native API findings (primary sources)

- [LocalSend protocol v2.2](https://github.com/localsend/protocol/blob/main/README.md):
  UDP multicast defaults to `224.0.0.167:53317`; direct transfers use
  `/api/localsend/v2/prepare-upload`, per-file `/upload`, and `/cancel`.
  HTTPS fingerprint is SHA-256 of the certificate. Preparation allows accept,
  partial accept or reject; uploaded checksum mismatch uses 422. An optional
  incoming PIN is supported. [Changelog](https://github.com/localsend/protocol/blob/main/CHANGELOG.md)
  distinguishes v2.1 PIN support from v2.2 checksum behavior.
- Protocol documentation also defines unencrypted HTTP and browser-download
  mode. Those modes contradict the uploaded HTTPS-only requirement and must not
  be silently enabled. Discovery is not authenticated proof of a trusted peer;
  aliases/fingerprints announced on UDP cannot alone authorize auto-accept.
- The HTTPS upload request's claimed fingerprint is not proof of the sender's
  private key. Actual authenticated incoming-peer behavior must be qualified
  against LocalSend clients before trusted auto-accept can be enabled. A reverse
  connection to the claimed device does not authenticate the incoming caller.
- [Windows GSMTC session manager](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager)
  provides playback metadata/control for applications participating in SMTC,
  current-session change events, and requires API/capability qualification for
  the target desktop package. It does not promise all arbitrary audio sources.
- [Apple MPNowPlayingInfoCenter](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter)
  sets metadata for media **your own app plays**. It is not evidence for a public
  cross-application read API. Broad macOS-source support needs separate source
  adapter/API validation; no private global-reader implementation is approved.
- [Apple calendar access](https://developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui)
  distinguishes access levels; its example is iOS-oriented and is not a macOS
  entitlement/runtime receipt. Qualify the target macOS EventKit access flow.
- [Google Calendar API](https://developers.google.com/calendar/api/guides/overview)
  provides calendars/events and recurring-event data with OAuth authorization.
  Existing Cal.com API keys do not grant this access. Desktop OAuth client setup,
  minimum read scope, revocation and token storage are implementation gates.

Source facts above describe API possibilities, not completed app integrations.

## Release blockers verified in this workspace

- Host is Linux. Swift/Xcode and an actual Windows execution environment are
  absent. Portable tests and Linux compilation cannot qualify macOS/Windows
  hardware APIs, dragging, screen readers, native motion or installers.
- The existing agent-inspector strict acceptance gate correctly remains red.
  Previously passing baseline tests do not complete rich source/lifetime work.
- Windows workflow deliberately sets `PUBLISH: false`; the documented unsigned
  installer/Defender issue has not been resolved by any local test. Signing and
  clearance require the owner's release process; no setting will be flipped
  merely to show a green release.
- macOS release workflow is an unsigned build check. Actual signing/notarization
  is separate (`scripts/release.sh`). The App Store target has client-network and
  selected-file entitlements but no network-server/calendar entries today;
  LocalSend receiving and calendar access need reviewed entitlement changes and
  sandboxed-device tests. `MusicController` is excluded from that target today.
- Source README/assets distinguish MIT code from separately licensed Coucou
  name/Mochi/media. This session may improve the checkout; public distribution of
  a fork requires confirming name/assets rights, not assuming code license covers
  them. No publishing, tagging, signing-identity changes or remote CI runs have
  been authorized/performed by this inventory.

## Proposed decomposition (design candidate, not execution approval)

1. **Reliability foundation:** actual hover behavior/holds; collision-safe file
   ingestion; truthful copy-ready state; deterministic cancellation and old-
   callback rejection. Keep the previously approved inspector work progressing.
2. **Shelf:** bounded multi-item model plus existing-style UI; file/folder/text
   ingest; native drag-out/open/share. Its native file handles feed LocalSend.
3. **Secure transfer:** native LocalSend discovery and streamed HTTPS transfer;
   consent-first receiving and safe destination commits; real progress/cancel;
   interoperability before trusting favorites, retries or history.
4. **Media and system:** source-qualified media, controls/art/seek/compact view;
   capability-qualified HUD/power/status widgets. UI/fake data alone is not proof
   a system control works.
5. **Calendar:** consent-based system calendars, configured Google OAuth,
   time-zone-correct upcoming/week views and explicit meeting links.
6. **Complete prioritized extras:** P1 then P2 from the uploaded spec, including
   favorites/trust/PIN/history/advanced settings; no priority silently discarded.
7. **Native polish and packaging:** concurrent media/transfer/agent cases,
   reduced motion, keyboard/screen reader, multi-display/hardware conditions,
   battery/idle/performance measurement, signing/install/update/uninstall checks.

Dependencies: safe ingestion → shelf → transfer UI; TLS identity/consent/file
validation → receiving; real byte counters → progress/speed/ETA; explicit source
capabilities → controls. Independent platform/data implementations may run in
parallel after their reviewed contracts exist. Existing UI is extended, not
rewritten. Unsupported platform/hardware APIs stay explicit unresolved gates;
they are not converted into fake functionality or silently removed requirements.

## Proposed smoothness acceptance (targets, not measured results)

- Preserve one Mochi and existing geometry/card style. No unrelated redesign.
- No synchronous copying, hashing or networking on UI threads. Rendering stops
  while hidden; authorized background transfers/agent monitoring are separately
  bounded, not mistaken for decorative idle work.
- Representative 60 Hz devices: p95 visible frame time ≤16.7 ms in the exercised
  hover/drag/media/progress scenarios; input feedback ≤100 ms. Measure both native
  implementations. Use the actual display refresh budget when testing 120 Hz.
- Ordinary progress/list updates at most 4 Hz; terminal outcomes and consent
  changes immediate. Render keyed rows without moving keyboard focus or scroll.
- File ready/completed is tied to real I/O and acknowledgements. No timer may
  report a transfer complete. Missing values read as unavailable, never zero.
- No focus theft for routine updates, no lost/overwritten files, no plaintext
  transfer fallback, no accepted stale callbacks after cancellation/teardown.
- Release receipt requires real target builds/devices, consent-denial cases,
  independent LocalSend send/receive round-trips, and tested packaging. A green
  unit suite alone is insufficient. Cross-device discovery must be tested beyond
  same-process/same-machine fixtures.
