# Coucou notch-app expansion — design and release contract

Date: 2026-10-04. Status: **written spec approved by the user** after review on
2026-10-04; the foundation implementation plan was subsequently approved.
No release approval is inferred from this document's existence. The user has
subsequently requested documented source checkpoints on their Infinite-Notch
GitHub repository; that does not authorize packaged releases or signing changes.

## 1. Outcome

Turn the uploaded notch-app feature list into working macOS/Windows functionality,
not a demonstration dashboard. Keep Coucou's existing SwiftUI/AppKit and Tauri
interfaces, Mochi, cards, typography, sounds and motion. Complete the previously
approved privacy-first agent inspector alongside this expansion.

Success requires the actual feature paths, safe file handling, secure native
transfers, responsive motion, accessibility and validated target-platform builds.
P0/P1/P2 determine sequence. All requested items stay in scope; a milestone or
partial platform implementation is never labeled the full completed release.
Missing hardware/API fields are unavailable, not invented.

Input: `notch-app-feature-spec.md`, attached on this session's request. Existing
code/API findings: [readiness inventory](../../research/notch-app-readiness.md).
Existing inspector contract: [approved design](2026-10-03-agent-session-inspector-design.md).

## 2. Decisions approved by the user

1. Built-in LocalSend protocol, not installed-app handoff: the island owns
   discovery, consent, actual progress, cancellation and receiving.
2. One shared Rust transfer engine, thin native bridges; preserve both existing
   UIs. Add TLS/server dependencies only where native/current facilities do not
   safely supply the required function. Never hand-roll TLS or cryptography.
3. Receive mode off by default; consent-first receiving. Favorite and trusted
   are different states. No implicit auto-accept from a display name or alias.
4. Temporary shelf; never delete originals. Transfer history is local/opt-in and
   separate from agent data, which stays memory-only with no activity storage.
5. Clipboard, calendars/accounts and system/device monitoring are opt-in. No
   clipboard polling, broad process/window/file inventory or capture to infer
   microphone/camera use.
6. Hover fully expands with optional delay; protected keyboard/drag/approval
   interactions cannot be collapsed by a mouse-leave timer.
7. Capability/signing/native-device limitations remain explicit release gates;
   no fake hardware values, simulated successful actions or OS-HUD replacement.

Ponytail applies throughout: trace current flows first, reuse them, use stdlib/
native/current dependencies, implement the smallest complete verified slice.
Security, file integrity, accessibility and requested behavior are never cut.

## 3. Architecture and boundaries

### Existing platform shells

- macOS: extend `NotchBuddy/Sources/App/`, `AppState`, island FSM/window controller,
  existing cards/pills and native drop surface. Keep bundle IDs and stable pill
  IDs. Project changes go through `NotchBuddy/project.yml`, not generated Xcode.
- Windows/Linux: extend existing TypeScript state/views/FSM/geometry and Rust
  Tauri commands/events. Keep Linux behavior working; Linux is a compatibility
  lane, not evidence of macOS or Windows feature completion.
- Do not replace the app framework or force unrelated UI restyling. Existing
  Claude/Codex interactive approval owners remain unchanged.

### Shared LocalSend core

Introduce one small native Rust crate for discovery, protocol validation,
certificate identity, consent sessions, streamed I/O and transfer lifecycle.
The Tauri shell calls it directly. macOS uses a narrow C ABI/static-library bridge
with explicit ownership, asynchronous event delivery and shutdown. SwiftUI never
owns sockets or TLS. All callbacks return to the correct native/UI executor.

Before committing this interface, demonstrate the bridge on actual macOS and
test start/stop/cancel/free across the boundary. No pointers cross into JavaScript;
no UI-thread blocking calls, unmanaged callback after shutdown, or retained
buffers whose owner cannot be identified. App Store sandbox permission support
must be tested separately, not assumed from the direct build.

Reuse existing Rust networking/TLS stack where it provides the function. A proven
server/certificate component may be added after its necessity, license, API and
minimal feature configuration are reviewed. Pin/reproduce dependencies. The core
has no telemetry, account service or cloud endpoint.

### Feature owners

- Island FSM owns expansion/collapse and combined interaction holds.
- Shelf owns user-selected temporary items, stable IDs and ready/error state.
  OS dragging/sharing owns the native exported file payload.
- Transfer core owns device roster, exact transfer/file IDs, byte counters,
  destination commits and cancel; UI presents snapshots and explicit actions.
- Media/system/calendar adapters own permissions and OS/account capability;
  views receive only fields needed for display. Display strings never authorize
  command execution or filesystem access.
- Agent inspector keeps its approved isolated agent/emitter/session contract;
  shelf/transfer history cannot be reused to persist agent observations.

## 4. Island interaction and smoothness

Hover moves hidden/compact to expanded overview. Delay is optional, default 0,
validated 0–1000 ms. Click or explicit alert bypasses hover delay. Leaving schedules
collapse after 300 ms to allow travel into the expanded panel; re-entry cancels
it. Existing user-selected long auto-close behavior is retained for explicit
opened interactions where appropriate, not used to ignore the new hover contract.

Timers are cancelled/replaced rather than stacked. Pausing, teardown, hide or
screen change invalidates obsolete callbacks. Approval pin, keyboard focus,
drag session, menu/dialog and inspector interaction holds combine independently;
releasing one cannot release the others. Transfers may continue collapsed and
show real compact progress; a routine update never steals focus or opens a view.

Preserve existing opening spring/closing curve where valid; reduced motion snaps
geometry and removes decorative loops without removing information. Keep one
Mochi. Distinguish greeting animation from normal hover; no late greeting timer
may collapse a newer interaction. Test pointer-entry/leave churn, keyboard-only
operation, multi-display scaling, notchless displays, sleep/wake and pause.

**Measured acceptance targets:** representative 60 Hz native devices have p95
visible frame time ≤16.7 ms in hover/drag/media/transfer scenarios and input
feedback ≤100 ms once a configured delay expires. Use the actual frame budget
for higher-refresh displays. Record hardware/workload and observed results.
Decorative rendering stops while hidden; authorized transfers/monitoring may
continue with bounded event-driven work. No synchronous copy/hash/network on UI
threads. Ordinary progress/data renders cap at 4 Hz; consent/terminal changes are
prompt. Stable keyed controls retain focus/selection/scroll.

## 5. Shelf and local file integrity

The shelf handles files, folders, explicitly dropped images and text/links.
Initially cap at 32 items with a visible capacity message; no silent replacement.
Preserve all items in a multi-item drop, or report per-item failure/capacity.
Use stable item IDs, newest-first preference and a disable toggle. Defaults are
enabled, original arrival order, no restart persistence.

Each item is preparing, ready or failed. Copy/hash work runs off the UI executor.
Show indeterminate work when byte progress is unknown. The current decorative
Mochi gulp is not a transfer byte gauge and cannot declare readiness. A user can
cancel/remove; old work cannot replace another item's state or revive removed
items. Each operation owns its temp files; clean them on failure/cancel/exit.

Store managed copies only in the app's private temporary shelf root, preserving
the selected originals. Exclusively reserve names; avoid check-then-write races,
never overwrite when suffixes exhaust, and never clean up an unowned file.
Reject symlinks/reparse points, including at the selected root, rather than
following them. Bound a folder ingest to 4096 entries and depth 64; exceeding
either fails that item with a clear limit message. Preserve safe relative
hierarchy; empty folders are preserved on the local shelf. Never recursively
delete outside a managed owned root. Copy into a unique per-operation directory
and atomically publish only the ready item. Reap only identified abandoned owned
operation directories on next launch after an abnormal exit; never scan general
temporary/download directories. A failed copy must not affect another operation.

Double-click explicitly opens the selected ready item with native OS handling;
it does not run an inferred shell command. Drag-out exports native files/folders
(AppKit file URLs/file promises; Windows shell file-drop data), not a text path.
Test actual Finder/Explorer and a supported attachment consumer such as WhatsApp
or Mail. The managed copy must remain readable for the lifetime of an active
drag/export lease, even when the shelf row is removed.

System share uses native UI: AirDrop/share sheet on Mac, supported Windows share
dialog. Mail/Messages are explicit destinations; no background sends. Received
files added to the shelf remain references to the user's save location; clearing
the shelf never deletes successfully received files. Quit removes temporary
shelf data after active leases are released. Private sandbox bookmarks/handles
are scoped to user-selected locations and revoked when no longer needed.

## 6. Built-in LocalSend

### Protocol scope and permission

Start with the documented v2.2 upload API, interoperating with compatible v2
clients. Public protocol references are in the readiness inventory. No plaintext
HTTP fallback or unencrypted browser-download mode. Protocol version changes
require explicit compatibility tests, not guessed aliases.

Receive visibility is off initially. Enabling it requests the applicable native
local-network/server permissions with an explanation before binding/advertising.
Disabling stops new incoming requests and announcements immediately; accepted
active transfers may finish unless the user cancels them. Distinguish visibility
from stopping an already accepted transfer. On exit all sessions/workers close.
Send-only discovery is initiated only by opening Send to; any temporary protocol
identification/listening necessary to discover peers is disclosed and cannot
silently make receive mode available. No background subnet scan. Manual IP entry
is available when multicast fails; validate address/interface/port and never use
an untrusted advertised arbitrary URL as a generic request target.

Join selected local-network interfaces, bound roster to 128 peers, expire stale
announcements and debounce refresh. Default discovery: `224.0.0.167:53317`.
Handle port conflict, interface loss, firewall/privacy denial, disconnected Wi-Fi,
IPv4/IPv6 support differences and multiple adapters without claiming discoverability
when the socket could not start. Favorites rank first; unknown type uses a generic
icon. Alias is untrusted text, not identity or proof a device is local/trusted.

### TLS and trust

Use library/platform cryptography and HTTPS exclusively. Persist this app's
private identity in OS secure storage; only public device preferences belong in
ordinary settings. Compute certificate fingerprints as defined by the protocol.
Validate the peer certificate identity on the actual connection; never globally
disable certificate checks. Bind pinned/trusted peers to previously explicitly
confirmed certificate identity, not UDP alias or IP. First contact is untrusted;
an advertised self-signed fingerprint alone is not authenticated ownership proof.
Explain changed identities and require confirmation again. No silent trust reset.

Incoming authentication is a separate feasibility gate: the documented HTTPS
upload fields do not themselves prove possession of the sender's private key.
Qualify actual client-certificate/proof behavior against real LocalSend clients
before enabling trusted auto-accept. Matching a claimed fingerprint, IP or a
successful reverse connection to a device is insufficient proof of the incoming
requester's identity. If interoperable proof is absent, incoming transfers still
require manual consent; the requested auto-accept feature remains an unresolved
release gate, not a weakly authenticated substitute. A protocol extension or
scope exception requires a separate user decision.

Optional PIN uses the supported preparation query parameter with rate limits;
never log the URL/PIN. Favoriting does not enable auto-accept. Auto-accept requires
a separate explicit trust action for verified identity and applies only while
receive mode is on; it never permits executable launching or bypasses safe writes.

### Receive safety and consent

Preparation parses bounded metadata only and presents sender, selected filenames,
file count and total size. Require an explicit Accept/Decline unless a separately
trusted-device rule applies. Allow partial accept where the protocol supports it.
Pending requests expire cleanly, have bounded queue/rate limits and never occupy
Claude/Codex approval channels. Start with one active batch, at most 8 waiting
requests, 1024 files and 1 MiB preparation metadata per batch, and a 120-second
consent deadline. Reject excess explicitly, not by evicting an accepted transfer.
Select save directory through native user choice;
validate permissions/free space before accepting; unavailable storage refuses.

Validate filenames/relative paths against traversal, absolute paths, separators,
Windows reserved/alternate-stream names, case collisions, Unicode/control abuse,
symlinks/reparse points and existing destinations. Do not flatten away hierarchy
silently. Use per-file cryptographically generated tokens tied to accepted session,
file identity, peer and expiry. Requests cannot write beyond their accepted
size/file limits, be replayed under another peer/session, or upload unaccepted files.

Stream to exclusively created owned partial files, not unbounded memory. Enforce
actual byte totals and optional supplied SHA-256; checksum mismatch is failure,
not success. Commit atomically without overwriting existing files; duplicate
names use a safe policy shown to the user. Only fully verified committed files
appear as completed. Remove only owned partials on cancellation/failure. Clear
tokens/PINs/queued display metadata at session teardown. No remote content is
opened/executed automatically. Explicit completion click may open/reveal a file.

### Sending, progress and lifecycle

Send from ready shelf items by device choice/drag or drop-to-send selection.
Send only user-selected data. Clipboard/text/link sending reads current content
once after an explicit action and shows what will be sent; no clipboard history.
Folders are represented through the protocol's verified relative file convention,
with empty-folder/symlink behavior documented rather than guessed.

Transfer states: waiting for acceptance, sending, receiving, completed, declined,
cancelled, failed. Each batch has exact transfer/file IDs and per-file state.
Real counters drive collapsed bar/ring and expanded bytes/percent/speed/ETA;
unknown size/rate/ETA remains unavailable. Count transport acknowledgement/commit
separately from bytes buffered by the sender; 100% sent is not remote completion.
Queue sequential files initially rather than unbounded concurrency; overlapping
requests have explicit bounded busy/queue behavior.

Cancel stops local I/O and best-effort signals protocol cancel, invalidating
callbacks/tokens; it cannot convert a failed cancellation into success. Retry
requires explicit click and a new preparation/consent session; never reuse an
expired token or automatically resend a declined request. Report short controlled
reasons (offline, declined, network lost, storage, integrity), not raw URLs/errors.
Completion animation follows a true terminal result and does not force focus.

### History and preferences

History is off initially and requires separate opt-in. When enabled, retain at
most 50 batch entries for 7 days by default: direction, display filenames, sizes,
status, time and device label. Never file contents, agent records, tokens/PINs,
full endpoint URLs or a general filesystem inventory. Clear history and turning
history off immediately remove it. Settings permit a shorter retention interval.
History alone cannot authorize retry/file read. One-click Retry is available
while an explicit selected-source lease is still valid: revalidate source and
peer, create a new preparation session, and renew receiver consent. Once the
lease is gone (clear/exit/source removal), prompt to reselect rather than reopen
a path from history. Keep completed display/Retry rows for at most 60 seconds
when history is off; no bytes are retained solely for history.

Preferences cover name, visibility, save location, favorites, independently
trusted auto-accept list, receive-to-shelf, history retention, validated port and
chosen local interfaces. Secrets live in OS stores; no telemetry/activity logs.
Native file reads and network transmission are legitimate here only for explicit
file-transfer actions, not permission to export agent display observations.

## 7. Media

Use Windows GSMTC for participating applications. On Mac, preserve the current
Apple Music adapter and qualify documented source-specific capabilities for
Spotify, browser playback (including YouTube), podcasts and local players.
`MPNowPlayingInfoCenter` publishes the app's own playback; it is not a qualified
global-reader API. No private-framework dependency, browser-profile inspection,
page-content scraping or unapproved browser extension is introduced to pretend
all sources work. Any necessary new source integration needs the user's explicit
enablement. App Store support needs its own sandbox/permission evidence.

Each current source supplies stable source/session identity, title/artist, art,
playing/paused state, timeline and capability flags. Control actions target the
displayed source identity; a source switch invalidates old seek/control work.
Play/pause, next/previous and seek must work against the named source or be
visibly unavailable with a reason. Don't optimistically report a successful
action merely because the command was sent. Unknown duration disables seek;
live streams never get an invented end time. Preserve timeline accuracy across
pause, seek, source change and sleep without constantly querying all players.

Artwork uses bounded native/current-source data in memory, with a placeholder
when absent. Remote art is fetched only as part of a configured permitted source,
over HTTPS, with size/type/time limits; untrusted metadata cannot turn the app
into an arbitrary URL fetcher. A collapsed playing indicator shows miniature
art and a play-state wave. Expanded controls follow existing card style.

The requested visualizer is a decorative animated bar/wave driven by playback
state, labeled as such; it is not an audio-amplitude measurement. Stop it when
paused/hidden and honor reduced motion. Actual audio-reactive capture would be
a separate explicit permission/design, not an implicit microphone recorder.
Windows favorites store only explicitly chosen track/playlist identifiers and
labels. Activating one uses a validated provider URL/action through the OS;
ordinary now-playing activity is not saved as listening history.

**Acceptance:** independently exercise Apple Music, Spotify, a YouTube browser,
podcast and local-player paths on their requested platforms. Record actual
metadata/control/art/seek support and permission behavior per source. Provider
omission or a disabled required control is an unresolved requirement, not full
broad-source qualification. Qualify two simultaneous sources and source exit;
controls must not jump to a different player after an asynchronous update.

## 8. System HUD and status

System volume is distinct from Coucou's sound-volume setting. Use documented
native audio endpoint notifications/control (Core Audio on Mac, endpoint APIs
on Windows); react to keyboard/hardware changes, output switches and mute. The
HUD updates the existing island briefly without stealing keyboard focus. Use
actual confirmed values. Mouse-wheel volume is a Windows opt-in: over the
compact/media volume target, not scrolling a list/seek control; clamp and support
precision wheels. Never consume wheel events outside the island.

Brightness requires actual per-display capability: laptop panel vs external
monitor, permission state and selected display. Do not equate a dark overlay
with brightness control. Validate changes/notifications on supported hardware.
Suppressing the OS volume/brightness overlay is a separate P0 feasibility gate:
only a supported documented interception/suppression path is acceptable. Showing
Coucou next to the OS overlay is explicitly not replacement. If no safe supported
path exists, report the conflict for a user decision; don't patch system files,
disable OS services, install a global keyboard hook or use private APIs silently.

Battery uses native power-change events and provides percentage, charging and
power-source state; batteryless desktops read unavailable. Plug/unplug gets a
short debounced animation (no repeat spam on duplicate notifications). Watts,
health, time-to-full/empty are shown only when supplied with defined units and
meaning. Unknown, stale estimates and multi-battery aggregation must not be
displayed as zero or confused with current rate/design capacity. External display
and charge-limited battery cases require actual hardware tests.

CPU means aggregate system usage, not a process inventory. Opt-in sampling at
most once per second while its visible card is active; stop otherwise. Handle
first-sample/reset/sleep deltas. Bluetooth means connected devices only, with a
real reported battery level or unavailable. Enumerate only after enablement,
subscribe to relevant changes, and stop/clear on disable. Do not infer a battery
from remembered last values after disconnect. The date card is local day/month,
using the user's locale/time zone and reacting to midnight/clock/zone changes.

The uploaded mic/camera indicator has no platform/priority assignment. Track it
as a Both/P2 candidate until public target-OS APIs prove aggregate in-use state.
Permission-granted is not in-use; listening/recording to detect use is forbidden.
No list of applications using the devices is collected. It remains an explicit
capability decision if either OS cannot expose the requested state safely.

**Acceptance:** exercise hardware keys, sliders, endpoint/display changes,
plug/unplug, unavailable sensors, Bluetooth connect/disconnect, sleep/wake and
disable. Denial/unsupported states must not trigger repeated permission prompts.
Verify native HUD suppression separately from value display and control.

## 9. Calendars and joining meetings

Use macOS EventKit with the target OS's required read-access permission and
purpose text. On Windows, qualify a documented system-calendar access path for
the actual desktop package; Google Calendar is an additional account adapter,
not automatic proof of system-calendar support. Existing Cal.com bookings remain
their own configured integration, not a substitute for either requirement.

Google uses a desktop OAuth flow with PKCE/state validation, system-browser
consent, a registered redirect and minimum read-only event scope. Client setup
requires an authorized Google project/account; do not invent one or collect
credentials in chat. Keep refresh/access tokens in native secure storage, not
the frontend, URLs, logs or repository. Token expiry/revocation disconnects and
clears display data; sign-in is explicit, not a repeated background popup.

Fetch only selected calendars and the shown range: upcoming 7 days and the
visible week, with at most 1000 displayed expanded instances per range and a
clear limit message. Upcoming sorts by start time, shows ongoing/all-day events
appropriately and offers explicit calendar selection. Event IDs are scoped by
source/calendar. Handle recurrence exceptions, cancellations and duplicates
without merging distinct calendars' events merely by title. Use source time
zone rules and actual instant ordering; all-day dates must not shift a day when
the user's zone changes. Weekly view supports system/Sunday/Monday start and
persists only the chosen preference. DST boundaries get deterministic checks.

Event display is local/in-memory: title, start/end, calendar label and validated
meeting link. No attendees, full descriptions, activity history, external
calendar export or prompt enrichment. If scanning event location/description is
necessary for meeting-link extraction, perform it locally within the explicitly
authorized calendar request and discard it immediately; don't persist the text
or send it to a model. Network requests go only to the authorized account source.

Recognize known HTTPS meeting hosts/paths (Zoom, Google Meet, Teams) using parsed
URLs and exact host boundaries, not a substring containing a brand name. Join
opens the validated link only on click through the existing safe URL handler.
No automatic joining, embedded credentials, arbitrary custom-scheme execution
or redirect-derived trust. Nonmeeting URLs remain ordinary explicit links or
unavailable, never shell commands.

Native change events or bounded account refresh update active views; no provider
webhooks/public server for this feature. Hide unrelated calendar text immediately
on disable/sign-out/permission loss; routine refresh cannot steal focus. Display
empty, access-denied, offline/stale and loading distinctly. Turning off the card
stops its background work. A denied permission opens OS settings only on click.

**Acceptance:** real consent/revoke flows, each requested source, offline/expired
OAuth, overlapping events, recurrence exceptions, all-day and DST weeks, changed
week start, and malicious lookalike meeting links. Native calendar unavailable
on Windows remains a gate even if the Google adapter passes.

## 10. Privacy, lifecycle and composed UI

Agent privacy rules are unchanged: no prompts/responses/transcripts, file bodies,
diffs, raw arguments/results/errors, terminal/environment enrichment or activity
persistence. Current bounded replay markers do not establish native ingress or
post-expiry safety. Resolve those prior gates under the existing approved plan;
never use transfer history as an agent display store.

Explicit shelf/drop/transfer actions are a distinct authority to read selected
files/text and send only to the chosen peer. No automatic upload to chat, email,
cloud/model or LocalSend follows simply from dropping onto the shelf. Transfer
and calendar/private OS content is excluded from diagnostic logs and crash
attachments, as are credentials and query tokens. Public qualification receipts
contain minimized structural/enum/count results, not private payload captures.

Pause means pause all feature monitoring/rendering and discard temporary display
data; never silently delete committed received files or originals. If transfers
are active, explain that pause cancels them and require that choice; decline
keeps the current running state. Cancelling revokes work before clearing views.
Shelf disable clears temporary rows/cancels preparation but does not abruptly
destroy a file still leased by an explicitly active export/transfer; the UI shows
that active work until its lease ends. History is separately managed. OS/account
monitor disable clears its content and subscriptions immediately. Exit cancels
native I/O, stops callbacks/subscriptions and releases owned temp/secure handles.

All asynchronous work is owned by a feature/operation generation. Teardown,
source change or cancel invalidates late completions before they mutate state.
Do not solve held-byte/ingress races merely with a frontend timestamp; native
delivery order/admission must be proved at the owner boundary. A memory-bound
pressure condition rejects new work without evicting ongoing trusted state.

Existing Claude/Codex approvals take interaction priority; never replace a
pending approval with transfer consent. Incoming transfer requests get a
separate request queue and stable controls; unavailable display time can end
in an honest timeout/decline. No one action answers both domains. Media/HUD/date
updates cannot reset scroll/focus or hide any request. Details, Back/Escape,
settings, drag targets and keyboard shortcuts continue working together.

Use native accessibility roles/names, visible focus, adequate contrast and
keyboard equivalents for hovering/drag actions. Screen readers get restrained
terminal/request announcements, not four progress announcements per second.
Reduced motion disables decorative loops and keeps actual transfer state.

## 11. Delivery slices and dependencies

This document is the expansion's master design/release contract, not one giant
worker assignment. The implementation plan must divide it into bounded native
vertical slices with file ownership, failing checks, commands and stop conditions.
Existing approved inspector work has its own plan; preserve/reuse it rather than
redispatch completed prerequisite repairs.

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| Foundation | Full hover/delay/holds; collision-safe asynchronous copying and true readiness | Timer/race tests plus actual drop/hover on both native shells; existing approvals preserved |
| Shelf | Multi-item local shelf with safe files/folders/text, native drag-out/open/share | Originals untouched, cancel/remove/exit safe, real attachments on each OS |
| LocalSend core | Shared Rust discovery/TLS/consent/file pipeline and native bridge | Mac bridge lifetime demonstrated; spoof/path/token/disk/cancel checks; independent v2 clients exchange exact bytes |
| LocalSend UI | Both native device/consent/progress/cancel views and compact activity | State/bytes match core; receive visibility and pause semantics verified; simultaneous agent approvals safe |
| Media/system | Qualified source controls/art/seek and hardware HUD/status | Actual named sources/hardware/permissions; HUD replacement feasibility resolved |
| Calendars | System/account upcoming/week/join paths | Native consent, real OAuth/source evidence, recurrence/zone/link checks |
| Prioritized extras | Favorites, text, trusted auto-accept, PIN, manual addresses, history and preferences; remaining P1/P2 | Each coverage row passes or has an explicitly approved scope change; no silent omission |
| Release | Rich agent inspector plus composed native performance/privacy/accessibility/packaging | Every required gate in section 13 green with evidence |

Safe ingest precedes shelf, which precedes transfer actions. Real native core
events precede progress UI; TLS/consent/path validation precedes receive activation.
Media, system and calendar implementations can proceed independently after their
capability facts/contracts are qualified. Foundations are the first executable
slice; platform and unrelated backend pieces may be delegated in parallel only
under a reviewed plan with disjoint ownership. No publishing/tagging is inferred.

## 12. Attachment coverage ledger

Each row is an obligation, **not an implemented/passing feature**. Unassigned
attachment fields are proposed explicitly below, not erased. LocalSend applies
to both requested native platforms. Section numbers identify the contract;
section 13 supplies the evidence required to mark any row complete.

| Feature | Priority | Platform | Contract |
| --- | --- | --- | --- |
| Expand on hover | P0 | Both | 4 |
| Delayed open | P1 proposed | Both proposed | 4 |
| Now-playing display | P0 | Both | 7 |
| Playback controls | P0 | Both | 7 |
| Audio visualizer | P1 | Both | 7: decorative playback wave, no capture |
| Broad source support | P0 | Both | 7: source-by-source native qualification |
| Media favorites | P2 | Win | 7 |
| Collapsed media indicator | P1 | Both | 7 |
| Volume HUD replacement | P0 | Both | 8: OS suppression gate |
| Brightness HUD replacement | P0 | Both | 8: control and OS suppression gates |
| Mouse-wheel volume | P2 | Win | 8 |
| Battery indicator | P1 | Both | 8 |
| Battery details | P2 | Both | 8: unavailable where sensors absent |
| Plug / unplug animation | P1 | Both | 8 |
| CPU monitor | P2 | Both | 8 |
| Bluetooth devices | P2 | Both | 8 |
| Date display | P2 | Both | 8 |
| Mic / camera in-use indicator | P2 proposed | Both candidate | 8: public in-use capability gate |
| Upcoming events | P0 | Both | 9: system sources, not only Cal.com/Google |
| Google Calendar integration | P1 | Win | 9 |
| Weekly view | P2 | Both | 9 |
| Join meeting | P1 | Both | 9 |
| File shelf / tray | P0 | Both | 5 |
| Open from shelf | P1 | Both | 5 |
| System share | P1 | Both | 5 |
| Message / mail sharing | P2 | Mac | 5 |
| Shelf ordering | P2 | Both | 5 |
| Disable shelf | P2 | Both | 5, 10 |
| Correct file drags | P1 | Both | 5: native attachment evidence |
| Nearby device list | P0 | Both | 6: discovery |
| Send from shelf | P0 | Both | 6: sending |
| Drop-to-send | P0 | Both | 6: sending |
| Send text / clipboard | P1 | Both | 6: explicit preview/action only |
| Favorites | P1 | Both | 6: favorites are not trust |
| Manual address | P2 | Both | 6: address validation |
| Incoming request prompt | P0 | Both | 6: separate consent owner |
| Auto-accept trusted devices | P2 | Both | 6: incoming identity proof gate |
| Save location | P0 | Both | 6: native choice and safe writes |
| Received files to shelf | P2 | Both | 5, 6 |
| Visibility toggle | P0 | Both | 6: off initially |
| Live progress in collapsed island | P0 | Both | 6: real counters |
| Detailed progress view | P0 | Both | 6 |
| Multi-file queue | P1 | Both | 6: per-file state, bounded sequential work |
| State labels | P0 | Both | 6: all seven specified labels |
| Cancel transfer | P0 | Both | 6 |
| Retry failed | P1 | Both | 6: one click while valid source lease exists |
| Completion notification | P1 | Both | 6: true completion, explicit open/reveal |
| Transfer history | P1 | Both | 6: optional local retention/clear |
| Encrypted transfers | P0 | Both | 6: HTTPS only, no downgrade |
| Device naming | P1 | Both | 6 |
| Optional PIN | P2 | Both | 6 |
| Permission prompts | P0 | Both | 6 |
| LocalSend settings (section 6.5) | P0–P2 by corresponding feature | Both | 6: name, visibility, save, trust, retention, port/interface |

## 13. Evidence and release gates

### Smallest meaningful development checks

Each implemented slice leaves a runnable regression check that fails for the
behavior it changes, preferably extending the existing Node/Python/Swift/Rust
checks. Use synthetic/public fixtures, never private content captures. A failed
test is diagnosed before changing production behavior. Review the combined diff
and preserve unrelated uncommitted work. Run existing frontend/native/agent
checks relevant to each change, then the composed suite. A skipped unavailable
check is recorded as skipped/pending, never passed.

Spec/file checks verify all attachment features have coverage, Markdown links
resolve locally, no placeholders or ambiguous fake-completion paths remain, and
the diff has no whitespace errors. These checks validate this document only;
they do not prove product behavior. The user must review this written spec before
the detailed implementation plan is written; that plan then needs review and
an execution-method choice before new-scope product changes.

### Native/security acceptance

- Build real macOS Swift 6 direct and sandboxed targets and Windows 10/11 Tauri
  target, including Rust bridge packaging; no new warnings. Run actual native
  tests, not just TypeScript preview or Linux Rust tests. Preserve Linux builds.
- File tests include simultaneous duplicate drops, exhausted names, cancellation,
  large files, folder limits, symlink/reparse parent swaps, disk full, permission
  loss, active drag followed by remove/exit, partial batch failures and restart
  cleanup. Committed files/originals are never lost or overwritten.
- Transfer tests include plaintext downgrade rejection, changed/spoofed peer
  identities, forged fingerprint/auto-accept requests, malformed/oversized metadata,
  traversal/ADS/reserved/case-colliding names, expired/stolen/wrong-file tokens,
  checksum/length mismatch, port conflicts, revoked visibility, cancellation
  around commit, network/sleep/interface loss and no sensitive output logging.
- Independent actual LocalSend v2 clients on a second device must discover,
  send and receive exact synthetic bytes with Coucou. Test a phone and another
  desktop, multi-file/folder behavior, PIN/trust support, decline/partial accept,
  throughput/progress, lost connections and mixed client versions. Pin the
  observed client/protocol versions in minimized reproducible receipts.
- Actual Mac/Windows tests cover native media sources/controls, system calendar,
  hardware/HUD suppression, dragging/sharing, permissions, sandbox/local network,
  keyboard, VoiceOver/Narrator, contrast/reduced motion, multiple monitors and
  concurrent media/transfer/agent approval. Source/sensor capability states are
  explicit; an unresolved P0 capability blocks the full release.
- Rich OpenCode/Hermes producers, native ingress/lifetime, SwiftUI inspector and
  existing Claude/Codex regression acceptance must pass the prior strict gate
  (`bash scripts/test-agent-monitor.sh --require-platform-checks`). Previously
  passing baseline registration/dispatch and synthetic DOM checks are insufficient.

### Performance and distribution

Measure section 4 frame/input targets on representative target hardware with
repeatable workloads. Record idle CPU/rendering timers, memory plateau across
repeated open/clear/transfer cycles and continued responsiveness during streamed
large transfers. Distinguish explicitly active network work from idle decorative
rendering; idle rendering must stop. Fix regressions before packaging.

Verify clean install/upgrade/uninstall, stable IDs/preferences/Keychain, bundle
version agreement, relay/bridge inclusion, and no leftover services/temp files.
Mac direct distribution requires owner-authorized signing/notarization. App Store
entitlements/review compatibility are separate. Windows signing/Defender clearance
must resolve the current publishing pause; don't flip `PUBLISH` to hide it. Check
the separately licensed Coucou/Mochi/assets rights for public fork distribution.
Never commit/push/tag/publish or use signing/account credentials implicitly.

**Current constraints, not exceptions:** this workspace is Linux, without Xcode
or a native Windows runner; the agent rich/runtime gates and full native archive
build remain incomplete. Signing/accounts and cross-device evidence are absent.
Development can proceed on authorized portable slices once the plan is reviewed;
the full release remains blocked until actual missing checks are supplied.

## 14. Review decisions and stop conditions

The written-spec review includes the proposed delay/leave timings, shelf/batch
bounds, mic/camera candidate assignment, decorative wave, temporary retry lease,
history retention and pause/cancel behavior. These are proposed implementation
defaults, not facts that the attachment already specified. User approval of this
written document locks them for the plan; changes remain possible explicitly.

Capability probes must stop and report an unresolved requirement rather than
quietly weaken it: safe OS-HUD replacement, Mac broad media, Windows system
calendar, authenticated incoming auto-accept, mic/camera in-use and native Rust
bridge support. Do not claim these probes have passed. They are concrete
qualification tasks in the next plan, not placeholders filled with invented APIs.

At every milestone report changed files, actual passing/failed/skipped commands,
user-visible result and next gate. Maintain the release coverage ledger with
receipts. Keep working through clear authorized tasks; request help only when
missing native access, an account/permission or a capability/scope decision truly
prevents the next step. Full release readiness requires all obligations above,
not a milestone label or a green portable test count.
