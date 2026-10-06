# Notch / Dynamic Island App: Feature Spec

A combined feature list drawn from existing macOS and Windows notch / "Dynamic Island" apps (Boring Notch, NotchNook, NotchDrop, Dockside, Tuneful, NotchFlow, QuakeNotch, DynamicWin, Dynamic Edge, Windowsland), plus LocalSend file sharing.

**Platform tags:** `[Mac]` `[Win]` `[Both]`
**Priority tags:** `P0` core, `P1` important, `P2` nice to have

---

## 1. Core Island Behavior

| Feature | What it should do | Platform | Priority |
|---|---|---|---|
| Expand on hover | Island sits collapsed at the top of the screen and expands smoothly when the cursor hovers over it. Collapses when the cursor leaves. | Both | P0 |
| Delayed open | Optional delay before expanding so accidental mouse passes don't trigger it. | TBD | TBD |

---

## 2. Media

| Feature | What it should do | Platform | Priority |
|---|---|---|---|
| Now-playing display | Show title, artist and album art for whatever is playing. | Both | P0 |
| Playback controls | Play/pause, next, previous, and seek from the island. | Both | P0 |
| Audio visualizer | Animated bars or wave line while audio plays. | Both | P1 |
| Broad source support | Work with Spotify, Apple Music, browsers (YouTube), podcasts and local players. Use system media APIs where possible (macOS Now Playing, Windows SMTC). | Both | P0 |
| Media favorites | Quick-access list of favorite tracks or playlists. | Win | P2 |
| Collapsed media indicator | Show small cover art and a wave animation in the collapsed island while playing. | Both | P1 |

---

## 3. System HUD and Status

| Feature | What it should do | Platform | Priority |
|---|---|---|---|
| Volume HUD replacement | Show volume changes inside the island instead of the default overlay. | Both | P0 |
| Brightness HUD replacement | Same for brightness. | Both | P0 |
| Mouse-wheel volume | Scroll over the island to change volume. | Win | P2 |
| Battery indicator | Show battery percentage and charging state. | Both | P1 |
| Battery details | Charging wattage, time to full, time until empty, and battery health (handle machines that don't report health). | Both | P2 |
| Plug / unplug animation | Short animation when power is connected or removed. | Both | P1 |
| CPU monitor | Show live CPU usage. | Both | P2 |
| Bluetooth devices | Show connected device name and its battery level. | Both | P2 |
| Date display | Show day, date and month. | Both | P2 |
| Mic / camera in-use indicator | Show an indicator when the microphone, the camera, or either one is in use. | TBD | TBD |

---

## 4. Calendar

| Feature | What it should do | Platform | Priority |
|---|---|---|---|
| Upcoming events | List the next events from the system calendar. | Both | P0 |
| Google Calendar integration | Sign in and show Google Calendar events (needed on Windows). | Win | P1 |
| Weekly view | Optional week-based view with a configurable week start (system, Sunday, Monday). | Both | P2 |
| Join meeting | Detect meeting links (Zoom, Meet, Teams, etc.) in an event and open them in one click. | Both | P1 |

---

## 5. Files and Shelf

| Feature | What it should do | Platform | Priority |
|---|---|---|---|
| File shelf / tray | Drag files, folders, images or text onto the island to hold them temporarily. Drag them back out later. | Both | P0 |
| Open from shelf | Double-click an item to open or launch it. | Both | P1 |
| System share | Share shelf items through AirDrop (Mac) or the Windows share dialog. | Both | P1 |
| Message / mail sharing | Drop files to share via Mail, Messages and similar apps. | Mac | P2 |
| Shelf ordering | Option to place newest items first. | Both | P2 |
| Disable shelf | Turn the shelf behavior off completely. | Both | P2 |
| Correct file drags | Dragging out of the shelf must attach the real file, not a text path, in apps like WhatsApp. | Both | P1 |

---

## 6. LocalSend File Sharing (new)

LocalSend is an open-source, cross-platform app for sending files over the local network without internet or accounts. The island should let users send to nearby devices and watch transfers live.

### Integration approach (decide before building)

- **Option A: Implement the LocalSend protocol directly.** The island discovers devices and transfers files itself. Most seamless, but more work and you must track protocol changes.
- **Option B: Hand off to the installed LocalSend app.** Simpler, but status reporting depends on what LocalSend exposes, which may be limited.

The requirements below assume Option A. If Option B is chosen, the status features (6.3) may need to be reduced.

### 6.1 Discover and send

| Feature | What it should do | Priority |
|---|---|---|
| Nearby device list | Show LocalSend devices on the same network with name and device type. Refresh automatically. | P0 |
| Send from shelf | Drag a shelf item onto a device (or choose "Send to...") to start a transfer. | P0 |
| Drop-to-send | Drop a file on the island and pick a target device from a quick panel. | P0 |
| Send text / clipboard | Send copied text or links to a device. | P1 |
| Favorites | Pin frequently used devices to the top. | P1 |
| Manual address | Add a device by IP when discovery fails (e.g. on restrictive networks). | P2 |

### 6.2 Receive

| Feature | What it should do | Priority |
|---|---|---|
| Incoming request prompt | When a device wants to send, show the sender, file names and total size in the island with Accept / Decline. | P0 |
| Auto-accept trusted devices | Optional auto-accept for favorites. | P2 |
| Save location | Choose where received files go. | P0 |
| Received files to shelf | Optionally drop received files onto the shelf for quick use. | P2 |
| Visibility toggle | Turn "receive mode" on or off so the device isn't discoverable unless wanted. | P0 |

### 6.3 Transfer status

| Feature | What it should do | Priority |
|---|---|---|
| Live progress in collapsed island | Small progress ring or bar while a transfer runs, like a Dynamic Island live activity. | P0 |
| Detailed progress view | In the expanded island: file name, percent, transferred / total size, speed, and time remaining. | P0 |
| Multi-file queue | Show each file's state in a batch. | P1 |
| State labels | Waiting for acceptance, Sending, Receiving, Completed, Declined, Cancelled, Failed. | P0 |
| Cancel transfer | Cancel an active transfer from the island. | P0 |
| Retry failed | One-click retry on failure, with a short reason (device offline, declined, network lost). | P1 |
| Completion notification | Brief animation or notice on success. Click to open the file or reveal it in the folder. | P1 |
| Transfer history | List of recent sent and received items with status, time and device. Clear history option. | P1 |

### 6.4 Security and trust

| Feature | What it should do | Priority |
|---|---|---|
| Encrypted transfers | Use the encryption LocalSend provides. Don't send over plain HTTP. | P0 |
| Device naming | Let the user set the name other devices see. | P1 |
| Optional PIN | Support a PIN for incoming transfers if LocalSend offers it. | P2 |
| Permission prompts | Clearly request local-network access (required on macOS) and explain why. | P0 |

### 6.5 Settings

Device name, receive visibility, save location, auto-accept list, history retention, port and network interface (advanced).
