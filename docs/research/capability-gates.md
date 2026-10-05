# Capability gates G1–G5 — findings and decisions needed

**Snapshot:** 2026-10-05. Primary-source research, no code written. Full per-agent
reports with every citation are available on request; this file is the decision
summary.

These gates ran *before* implementation on purpose. They found that a meaningful
part of the 53-row requested list **cannot be built as requested** on public APIs.
Per the approved roadmap, genuine public-API conflicts are escalated for an explicit
decision rather than silently dropped or faked with a proxy.

## Summary

| Gate | Features | UNBLOCKED | PARTIAL | BLOCKED |
| --- | --- | --- | --- | --- |
| G-MacMedia | 3–18 | 12, 13, 14, 15 | 4, 5, 8, 9, 16 | **3, 6, 10, 18** |
| G-Calendar | 19–22 | — | 19, 21, 22 (macOS) | **19, 21, 22 (Windows), 20** |
| G-WinShell | 9, 10, 11, 22, 25, 29, 32 | 22, 32 | 9, 11, 25, 29 | **10** |
| G-LocalSend | 30–53 | 16 | 30, 37, 38, 43, 45, 46, 49 | **52** |
| G-Inspector | I1/I2 | OpenCode most fields | Hermes ~1/3 | Hermes cwd/previews/gauge |

## Decisions needed

Each of these is a real conflict. None can be resolved by writing better code.

**D1 — macOS 18, mic/camera in-use indicator: no public API exists.**
`AVCaptureDevice.authorizationStatus` is *permission*, not use. There is no public
aggregate in-use boolean for either device. The only mechanism is
`kAudioHardwarePropertyProcessObjectList` + `kAudioProcessPropertyIsRunningInput`
(macOS 15), which is a per-process inventory exposing PID and bundle ID — banned by
the contract — and it has **no camera counterpart at all**.
*Decision:* drop 18, or explicitly relax the no-process-inventory rule for audio only
and accept that the camera half is still undeliverable. **Recommended: drop.**

**D2 — macOS 3/6/8, broad now-playing and media sources: no public API reads another
app's playback.** Apple defines `MPNowPlayingInfoCenter` as "for media that *your app*
plays". `MPNowPlayingSession` **does not exist on macOS** (iOS 16+ only), which
contradicts the request's premise. `MPRemoteCommandCenter` commands are scoped to "when
your app is the Now Playing app". The one cross-app surface, `MediaRemote.framework`,
is in `/System/Library/PrivateFrameworks/` — **private, rejected**. The existing
AppleScript path is not a partial implementation; it is the only permitted route.
*Decision:* cap at Apple Music, or accept a hand-written per-app adapter layer where
each app needs its own Automation grant.

**D3 — macOS 10, brightness HUD: no public brightness setter exists on macOS 15.**
`NSScreen.brightness` does not exist; `UIScreen.brightness` is iOS/Catalyst only;
`IOGraphicsLib.h` documents no brightness symbol; CoreDisplay has no public header.
*Decision:* drop, or reduce to a launcher that opens System Settings → Displays.

**D4 — 9, volume HUD "replacement", both platforms.** Setting volume is public and
clean on both. **Suppressing the OS overlay is not publicly possible on either
platform** — `MPVolumeView` (the iOS mechanism) has no macOS availability, and no
public Win32 API suppresses the Windows OSD (`IVolumeService` exists in no public SDK
header — undocumented, rejected).
*Decision:* accept "we own the value, the OS overlay still appears for hardware-key
changes", or withdraw the feature.

**D5 — Windows 10, brightness: no public unelevated API for the laptop panel.**
`WmiSetBrightness` declares no `Privileges` qualifier but Microsoft documents access
denied as UAC-dependent; Dxva2 `SetVCPFeature` targets external monitors and Microsoft
explicitly does not recommend it for arbitrary monitors.
*Decision:* drop for internal panels, or accept elevation (which the contract forbids
requesting for a normal action).

**D6 — Windows 29, real file drags: feasible, but not from the webview.** The Win32
source-drag path is fully documented (`OleInitialize` → `CF_HDROP` `IDataObject` →
`IDropSource` → `DoDragDrop`, holding the data object until `DoDragDrop` returns).
WebView2 exposes **no** host API to supply or intercept a drag's `IDataObject`; Tauri
and wry implement receive-side only. A native drag-handle window is **required**.
*Decision:* approve a small native drag-handle window, or accept 29 unimplemented on
Windows.

**D7 — Windows 25, system share: cannot hold the shelf lease until real completion.**
`IDataTransferManagerInterop::ShowShareUIForWindow` is fire-and-forget with no
completion signal, and `ShareCompleted` is documented as *optional telemetry*, not a
read-completion guarantee. *Decision:* approve materialising a **separate owned
attachment** per share with its own lifecycle, rather than borrowing the shelf copy.

**D8 — Windows calendar (19, 21, 22): no viable public route.** WinRT
`Appointments` needs the restricted `appointmentsSystem` capability, which Microsoft
says "in most cases won't be approved", **and** package identity that Tauri 2's
MSI/NSIS output does not have. Outlook COM is broken by New Outlook. MAPI is
documented "not supported". There is **no public Win32/COM calendar enumerator**, and
`CalendarPicker` — commonly assumed to exist — **does not exist** in the current WinRT
surface. Only Graph or Google over OAuth remain.

**D9 — 20, Google Calendar: blocked on an owner account action.** Requires the owner
to create a Google Cloud project, enable the Calendar API, configure the OAuth consent
screen and create a Desktop-app client. `calendar.events.readonly` is a *sensitive*
scope requiring Google OAuth app verification. **No agent can perform any of this.**

**D10 — 52, LocalSend permission prompts: not buildable as specified.** Apple documents
both the request API and the state query as nonexistent; Windows raises its prompt
from the firewall service with no app-side control, and cannot distinguish *denied*
from *never prompted*. *Decision:* ship an honest degraded prompt that reports state
only by inference, drop 52, or document the Windows `LocalPolicyMerge`-disabled case
as unsupported. **This must not be quietly degraded.**

**D11 — LocalSend 45, cancel: protocol has no remote byte-level abort.** Cancel must be
**locally authoritative**; the peer's acknowledgement is advisory. Resumable transfer
is **absent from the protocol entirely**.

**D12 — LocalSend 37, auto-accept: the v2.2 spec does not require client
certificates**, so any conforming peer that omits one is unverifiable. Auto-accept can
only mean "skip re-prompting a device whose fingerprint I already pinned", never
"trust a device I marked favourite".

## Owner actions only the owner can perform

- macOS: grant calendar access; App Store privacy declaration covering calendar data.
- Windows/Google: Google Cloud project, Calendar API, OAuth consent screen, Desktop
  client, and app verification if shipping beyond 100 users.
- Windows/Graph (if pursued): Entra app registration and possibly tenant admin consent.
- Real hardware sessions: a Mac with a battery, a Windows laptop panel, an external
  DDC/CI monitor, and an interactive unelevated Windows desktop. **No CI lane can
  prove UAC, TCC, firewall prompts, DDC/CI or OLE drop targets.**

## What this means for sequencing

Features that are **not** blocked and can proceed once S1a is green: media control
surface for Apple Music, battery indicator/details, plug/unplug animation, aggregate
CPU, Bluetooth paired-device connected state, macOS calendar 19/21 with a validated
meeting-URL matcher, Windows native open, mouse-wheel volume via **raw input** (not
`WH_MOUSE_LL`, which needs a separate DLL and can be silently removed), and the
OpenCode inspector's rich fields.

**G-Inspector found a defect in our own adapter:** it reads `ctx.location.directory`
(the plugin instance's location) rather than the session's own reported
`event.data.location.directory`. Apple explicitly warns these differ. That is a
correctness fix available now.

Nothing here weakens the privacy or safety contract, and no proxy was proposed to
paper over a blocked capability.