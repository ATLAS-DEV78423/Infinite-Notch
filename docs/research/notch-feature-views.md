# Notch feature views — what is built, what is verified, what is not

Snapshot: 2026-10-06, branch `feat/island-expansion` → `feat/island-features`.
Scope: the Tauri (Windows/Linux) shell of the notch-expansion feature set.

This file exists because **the honest state is layered**. Read section 1 before
assuming any row in section 3 is a working feature.

---

## 1. The one thing to understand first

A notch feature is two halves:

```
  native half (Rust / Swift)          UI half (TypeScript / DOM)
  ───────────────────────────          ──────────────────────────
  the real capability                 the island view
  • SMTC now-playing                  • title / artist / artwork
  • EventKit calendar                 • the event list
  • the LocalSend HTTPS engine        • device list, consent, progress
  • native file leases                • the shelf grid
            │                                   ▲
            └────── snapshot pushed on change ───┘
                   (FeatureStore in src/features/contract.ts)
```

**This branch delivers the entire UI half, plus the transport seam between the
halves. It delivers none of the native halves.**

That is not a shortcut — it is the only half that can be built and *proven*
without a macOS or Windows toolchain. Every UI row below is exercised by 72
assertions in a real browser. Every native row is absent, and no row in this file
claims otherwise.

The seam is deliberately narrow so the native work is mechanical rather than
creative: native pushes a plain snapshot into a store, the view renders it. A
view never fetches, never touches the filesystem, never reads the clipboard and
never captures audio.

---

## 2. Verification actually performed

Every number here was produced by running the command, on this revision, in this
session. Nothing is inherited from a prior receipt.

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm exec -- tsc --noEmit` (in `windows/`) | **exit 0**, no diagnostics |
| Production build | `npm exec -- vite build` | **clean**, 47 modules (was 38) |
| Portable behaviour | `node --test tests/*.test.ts tests/*.test.mjs` (repo root) | **109/109 pass** |
| Relay suites | `python3 -B -m unittest discover -s tests -p 'test_*.py'` | **83/83 pass** (includes the 66 agent-relay checks) |
| Feature-view contract | headless Chromium against `windows/tests/feature-views-ui.html` | **72/72 pass**, `data-result="passed"` |

The 72 checks are not smoke tests. Each one is a rule from `handoff.md` §8 or
`notch-app-feature-spec.md`, and each fails if the view regresses. Examples that
actually caught a bug during development:

- *"100% buffered bytes without a native commit is NOT reported complete"* —
  enforces "bytes buffered locally are not remote completion". The view derives
  the completed state only from native's `completedAtMs`.
- *"only the cryptographically verified device is labelled verified"* — enforces
  "device alias/IP or favorite is not authenticated trust".
- *"received item offers no removal"* — enforces "received-to-shelf items are
  references, not temporary delete rights".
- *"absent battery sensors render Unavailable, never 0 or a fake estimate"* —
  enforces the battery-details rule for machines that report no health.
- *"overflow beyond 32 is reported by the view, never silently dropped"* —
  enforces "report per-item failure/capacity, not silent truncation".
- *"audio visualizer declares no capture API"* — enforces "no capture for
  decorative audio wave".

### Reproducing

```sh
cd windows
npm install
npm exec -- tsc --noEmit
npm exec -- vite build

# feature-view contract suite (needs a browser)
npm exec -- vite --port 5199 --host 127.0.0.1      # `npm run dev` also runs cargo
chromium --headless --virtual-time-budget=40000 --force-prefers-reduced-motion \
  --dump-dom http://127.0.0.1:5199/tests/feature-views-ui.html

# or open it and click through:
#   http://127.0.0.1:5199/tests/feature-views-ui.html
#   ?view=shelf | devices | transferConsent | transferProgress | nowPlaying | ...
```

Screenshots in `images/` were captured with `--force-prefers-reduced-motion`.
That flag is required **only** because headless virtual time does not advance CSS
transitions; see section 6.

---

## 3. Feature coverage, honestly split

Legend: **UI done** = the island view exists, is registered, and is covered by the
72 checks. **Native needed** = the row cannot function without a native capability.

### 3.1 Media (spec §2)

| # | Feature | UI | Native needed |
| --- | --- | --- | --- |
| 3 | Now-playing display | ✅ title/artist/album, artwork-or-nothing, literal text | SMTC (Win) / MPNowPlayingInfoCenter (Mac) |
| 4 | Playback controls | ✅ prev / play-pause / next, seek slider | transport commands |
| 5 | Audio visualizer | ✅ decorative canvas bars, no capture | **nothing** — decorative by contract |
| 6 | Broad source support | ◻ `source` field displayed only | per-source capability probe |
| 8 | Collapsed media indicator | ✅ thumb + wave in the 288×32 rail | now-playing snapshot |

Row 5 is the one media feature that needs no native half at all: the spec forbids
capturing amplitude, so it is a decorative animation driven by the `playing`
boolean. It is honest about being decorative.

### 3.2 System HUD and status (spec §3)

| # | Feature | UI | Native needed |
| --- | --- | --- | --- |
| 9 | Volume HUD replacement | ✅ glyph, bar, %, mute-aware | system volume + **OS HUD suppression gate** |
| 10 | Brightness HUD replacement | ✅ same | per-display brightness + suppression gate |
| 11 | Mouse-wheel volume | ◻ | wheel event path in `island.ts` |
| 12 | Battery indicator | ✅ % + charging + power source | battery status |
| 13 | Battery details | ✅ every absent sensor renders `Unavailable` | wattage / health / time-to-full |
| 14 | Plug / unplug animation | ✅ transition-driven, reduced-motion aware | power-source notifications |
| 15 | CPU monitor | ✅ opt-in only, ≤4 Hz re-render | aggregate sampling at ≤1 Hz |
| 16 | Bluetooth devices | ✅ chips with per-device battery | connected-device enumeration |
| 17 | Date display | ✅ formatted from native-resolved numbers, no timezone drift | nothing — `Date` is enough |
| 18 | Mic / camera in-use | ✅ chip only while in use | public aggregate in-use API |

Row 17 is fully complete on the UI side: it needs no native capability.

Rows 9 and 10 are the spec's honest trap. The UI half is done, but until the OS
overlay is actually suppressed the user sees *two* HUDs. `handoff.md` §9.5 flags
this as a capability gate, and the UI deliberately does not pretend otherwise.

### 3.3 File shelf (spec §5)

| # | Feature | UI | Native needed |
| --- | --- | --- | --- |
| 23 | File shelf / tray | ✅ grid, 32 cap, drop highlight | multi-item ingest + S1a leases |
| 24 | Open from shelf | ✅ double-click **and** Enter | open-with-default-app |
| 25 | System share | ✅ action dispatched | platform share sheet |
| 26 | Message / mail sharing | ◻ Windows v1 has no mail path | Mail / Messages |
| 27 | Shelf ordering | ✅ arrival order default, newest-first opt-in, stable | — |
| 28 | Disable shelf | ✅ off state, drops refused | — |
| 29 | Correct file drags | ◻ browser `DownloadURL` only | **real OLE / Finder drag-out** |

Row 29 is the spec's "must attach the real file, not a text path" rule. The view
sets `DownloadURL` and `text/uri-list`, which is the correct browser behaviour
and is verified. But a real attachment drag into WhatsApp or Mail needs the
native side; the view dispatches `shelf-drag` for exactly that bridge and says so
in a comment.

### 3.4 LocalSend (spec §6) — UI only

Every row's UI is built. **No row functions**, because the entire native half —
discovery, the HTTPS v2.2 engine, receiving, transfer — does not exist yet.

| # | Feature | UI status |
| --- | --- | --- |
| 30 | Nearby device list | ✅ online state, type, favourite, verification |
| 31 | Send from shelf | ✅ target picker, dispatches `transfer-send` |
| 32 | Drop-to-send | ✅ dispatches, **never auto-sends** |
| 33 | Send text / clipboard | ✅ button only — never reads the clipboard itself |
| 34 | Favorites | ✅ pinned, and visually *not* trust |
| 35 | Manual address | ✅ address + port validated before dispatch |
| 36 | Incoming request prompt | ✅ sender, files, total, live countdown, Accept/Decline |
| 37 | Auto-accept trusted | ✅ refuses to auto-accept without identity proof |
| 38 | Save location | ✅ typed path + Clear (no fake folder picker) |
| 39 | Received to shelf | ✅ marked as references, no delete affordance |
| 40 | Visibility toggle | ✅ **defaults off** |
| 41 | Live progress (collapsed) | ✅ SVG ring in the rail |
| 42 | Detailed progress | ✅ name, %, transferred/total, speed, ETA |
| 43 | Multi-file queue | ✅ per-file rows, 1024 cap reported |
| 44 | State labels | ✅ all seven real states |
| 45 | Cancel transfer | ✅ per-row |
| 46 | Retry failed | ✅ explicit fresh-request only |
| 47 | Completion notification | ✅ driven by native `completedAtMs` only |
| 48 | Transfer history | ✅ 50 cap, 7-day retention, 60 s terminal display |
| 49 | Encrypted transfers | ✅ **non-HTTPS is refused with no send path** |
| 50 | Device naming | ✅ settings field |
| 51 | Optional PIN | ◻ no PIN field crosses the seam on purpose |
| 52 | Permission prompts | ✅ refusal state is rendered; native explanation flows needed |
| 53 | Settings (§6.5) | ✅ all nine controls, honest defaults |

Every bound in the contract is enforced **in the UI** and asserted:
8 waiting requests, 1024 files, 120-second consent deadline, 50 history batches,
60-second terminal display with history off, 32 shelf items.

Row 51 is a deliberate omission, not an oversight. `PendingRequest` has no PIN
field, so no secret can cross the seam. Adding one would put a PIN into a
snapshot object that gets logged, serialised and diffed. The mask-and-reveal
control belongs on the native side.

---

## 4. Where the code lives

| Path | Lines | Owns |
| --- | --- | --- |
| `windows/src/features/contract.ts` | 115 | `FeatureStore`, 4 Hz throttle, byte/duration formatters |
| `windows/src/features/media.ts` + `.css` | 306 + 233 | rows 3, 4, 5, 8 |
| `windows/src/features/system.ts` + `.css` | 350 + 193 | rows 9–18 |
| `windows/src/features/shelf.ts` + `.css` | 427 + 259 | rows 23–29 |
| `windows/src/features/transfers.ts` + `.css` | 1053 + 545 | rows 30–53 |
| `windows/src/core/layout.ts` | +22 | 9 new view names and their geometry |
| `windows/src/views/views.ts` | +22 | registers the 9 builders |
| `windows/src/island/island.ts` | +58 | the compact status rail |
| `windows/src/style.css` | +42 | rail styles + a reduced-motion fix |
| `windows/tests/feature-views-ui.{ts,html}` | 560 | the 72 contract checks |

Each feature module owns exactly two files and imports nothing from the shared
shell. The shell wires them in one place each. That was a deliberate constraint:
it is what let four modules be written in parallel without a single merge
conflict, and it keeps every new view's blast radius to its own directory.

### The compact status rail

The new features needed a navigation entry point, and `CLAUDE.md` forbids
restyling the header or the overview. So the entry point is new UI: four chips in
the compact 288×32 slot, each holding a feature's own indicator, each expanding
into that feature's view.

The rail takes pointer events only while the island is compact, so a hidden
island can never swallow a click, and its indicators stop syncing once expanded —
the "decorative rendering stops when hidden" half of the 0% CPU contract.

---

## 5. Bugs found and fixed while building

Recorded because each was a real defect, not a test artefact.

1. **`FeatureStore` listener signature** — the store declared
   `Set<() => void>` but subscribed `(urgent: boolean) => void`, and stored an
   `urgent` field nothing read. Two agents independently reported it before I ran
   tsc. Fixed in `contract.ts`.
2. **Mochi drawn on top of file names** — the first `VIEW_LAYOUTS` draft put
   `botX: 36..44`, and the feature cards use the full card width, so the character
   covered the first characters of every filename. Visible immediately in a
   screenshot. All nine views now declare `botDiameter: 0`, following the existing
   `greeting` precedent. Giving Mochi a home in these views needs a design pass
   that does not collide with content — it is **not** solved here.
3. **Views too short for their own content** — 160–240px heights hid most of a
   transfer queue. Raised to 176–288px, all within the existing 320px panel.
4. **`.view` missing from the reduced-motion block** — a real accessibility gap,
   not a test artefact: the island cross-faded and scaled on every view change even
   for users who asked for reduced motion. Added `.view, .view.on { transition: none }`.

---

## 6. Known limitations of the verification itself

Stated so the receipts are not over-read.

- **Not a native test.** These are DOM checks against synthetic snapshots. No
  Swift and no Rust was compiled or executed, because neither toolchain exists on
  the machine that built this. See section 7.
- **Headless CSS transitions do not advance.** Screenshots require
  `--force-prefers-reduced-motion`; without it the `.view.on` fade never starts and
  every capture is blank. This is a limitation of virtual time, not of the app.
- **No real rAF.** The harness drives the production `frame()` with a synthetic
  clock, because headless virtual time does not reliably deliver animation frames.
  The springs, geometry and view sync are the real ones; only the clock is fake.
- **Screenshots are static.** Motion, the plug/unplug animation and the visualizer
  are verified by assertion (reduced-motion honoured, tick-driven, stops when
  hidden), not by watching them run.
- **Single viewport.** Geometry was checked at the panel's design size only.
  Notched, notchless and multi-display placement remain unverified — the existing
  `IslandScreenGeometry` tests cover the old views only.

---

## 7. What is still missing, and the order to build it

The whole native half. Concretely, in dependency order:

1. **Shelf S1a reconciliation** — `handoff.md` §6. The uncommitted candidate on
   `feat/notch-expansion` has never been compiled; the Rust and Mac purposes are
   also spelled inconsistently (`Preview/Export/Attachment` vs `drag/share/mail/transfer`).
   Resolve that contract before any shelf view depends on it.
2. **Shelf native ingest** — folder / bounded text / bounded image items, so the
   grid has more than files. Bounds already agreed: 4096 entries / depth 64 for
   folders, 1 MiB UTF-8 for text, 16 MiB / 16 Mpx for images.
3. **Shelf native actions** — open, share, reveal, and the real drag-out bridge
   behind the `shelf-drag` / `shelf-open` / `shelf-share` events already emitted.
4. **System native** — volume, brightness + HUD suppression, battery, CPU sampling,
   Bluetooth, mic/camera. Two capability gates are genuinely open: OS HUD
   suppression, and a public aggregate mic/camera in-use API.
5. **LocalSend engine** — the shared Rust core, then discovery, then
   send/receive/consent/progress. HTTPS-only, no plaintext fallback, no subnet
   sweep, defaults off. This is the largest single piece of remaining work and it
   gates rows 30–53.
6. **Mochi placement for the new views** — a design pass, not a bug.

Nothing in that list is a UI problem. The views, the seam and the contract
enforcement are done and tested; what remains is the platform work, and it is
where the real difficulty in this project has always been.

---

## 8. Contract rules these views enforce

The single most important property of this layer: **a view may only render what
native reported.** It never invents, interpolates or completes a value.

| Rule | How it is enforced |
| --- | --- |
| Unavailable stays unavailable | `UNAVAILABLE` literal; never `0`, `—` or an estimate |
| A favourite is not trust | "Favourite" and "Verified identity" are separate labels; only a real `verifiedIdentity` earns the second |
| No capture for decoration | visualizer reads one boolean; no `getUserMedia`, no `AudioContext` |
| No automatic action on drop | drops dispatch an intent; opening/sending needs a click |
| Bytes buffered ≠ complete | completed state comes only from native `completedAtMs` |
| Receiving and history default off | asserted in the store defaults |
| No silent truncation | every cap (8 / 1024 / 32 / 50) states its overflow |
| Received files are references | received rows have no remove affordance at all |
| One active batch, bounded consent | 8 waiting, 120 s deadline, no code path that sends after expiry |
| No secrets in the seam | no PIN or token field exists in any snapshot type |
| No untrusted markup | device names and filenames go through `textContent` only |
