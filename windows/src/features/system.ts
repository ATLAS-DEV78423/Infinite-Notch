// System HUD and status — display only, no sensors.
//
// Nothing in this file reads a device. Volume, brightness, battery, Bluetooth,
// CPU and the mic/camera flags are pushed in as a whole snapshot by native and
// rendered as-is. Two rules from the safety contract shape the whole module:
//   - no capture, no process or app inventory, no device enumeration;
//   - CPU is a visible opt-in aggregate, native caps sampling at 1 Hz and this
//     file never samples, interpolates or animates the number (fake precision).
// Every optional sensor field is nullable and prints UNAVAILABLE rather than a
// fabricated zero. The date arrives as discrete numbers from native and is
// formatted through a lookup table, never through `new Date()`, so a timezone
// difference can never shift the day the user sees.
//
// Two files, no shell edits: the controller wires the store, the three views
// and `setCpuEnabled` into the island.

import "./system.css";
import { h, svg, clear } from "../views/dom";
import { FeatureStore, throttle, UNAVAILABLE, formatDuration } from "./contract";
import type { ViewActions, ViewHost } from "./contract";

export interface Battery {
  /** 0..1, or null when no battery is present (desktop). */
  level: number | null;
  charging: boolean;
  /** "ac" | "battery" | null when unknown. */
  powerSource: "ac" | "battery" | null;
  wattage: number | null;
  timeToFullSeconds: number | null;
  timeToEmptySeconds: number | null;
  /** 0..1 or null. Most machines do not report this. */
  health: number | null;
}

export type HudKind = "volume" | "brightness";

export interface SystemSnapshot {
  volume: { value: number; muted: boolean } | null;
  brightness: { value: number } | null;
  battery: Battery | null;
  /** 0..1 aggregate, native-sampled at ≤1 Hz. */
  cpuUsage: number | null;
  /** User opt-in. While false nothing about CPU is rendered. */
  cpuEnabled: boolean;
  bluetooth: Array<{ name: string; connected: boolean; battery: number | null }>;
  microphoneInUse: boolean;
  cameraInUse: boolean;
  date: { year: number; month: number; day: number; weekday: number } | null;
  /** Which of volume/brightness the controller pushed last. Optional: when the
   *  controller omits it, `activeHud` falls back to detecting the change. */
  hud?: { kind: HudKind; updatedAtMs: number } | null;
}

const EMPTY: SystemSnapshot = {
  volume: null,
  brightness: null,
  battery: null,
  cpuUsage: null,
  cpuEnabled: false,
  bluetooth: [],
  microphoneInUse: false,
  cameraInUse: false,
  date: null,
  hud: null,
};

export const systemStore = new FeatureStore<SystemSnapshot>(EMPTY);

/** The controller's only writable seam: flip the CPU opt-in and re-render. */
export function setCpuEnabled(enabled: boolean) {
  const current = systemStore.get();
  if (current.cpuEnabled !== enabled) systemStore.set({ ...current, cpuEnabled: enabled });
}

// ── Formatting ───────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (table: string[], index: number) => table[index] ?? UNAVAILABLE;

const percent = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
const watts = (value: number | null) => (value === null ? UNAVAILABLE : `${Math.round(value)} W`);

function text(el: HTMLElement, value: string) {
  if (el.textContent !== value) el.textContent = value;
}

/** `Tue 7 Oct`. Native already resolved the local calendar date; no Date here. */
function dateLabel(date: SystemSnapshot["date"]): string {
  if (!date) return UNAVAILABLE;
  return `${label(WEEKDAYS, date.weekday)} ${date.day} ${label(MONTHS, date.month - 1)}`;
}

const ICON = {
  volumeOn: "M11 4.5 6.5 8.2H3.4v7.6h3.1L11 19.5v-15zm3.2 3a5.3 5.3 0 0 1 0 9 .9.9 0 0 0 .9 1.55 7.1 7.1 0 0 0 0-12.1.9.9 0 0 0-.9 1.55zm2.6-3.1a8.9 8.9 0 0 1 0 15.2.9.9 0 0 0 .92 1.55 10.7 10.7 0 0 0 0-18.3.9.9 0 0 0-.92 1.55z",
  volumeOff: "M11 4.5 6.5 8.2H3.4v7.6h3.1L11 19.5v-15zm3.6 4.1 1.27-1.27 2.33 2.33 2.33-2.33 1.27 1.27L19.47 11l2.33 2.33-1.27 1.27-2.33-2.33-2.33 2.33-1.27-1.27L16.93 11 14.6 8.6z",
  sun: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6",
  battery: "M3.4 8.6h12.2a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V9.6a1 1 0 0 1 1-1zM18.4 10.8v2.4",
  bolt: "M13.4 2.6 6.6 13.2h4.2l-.8 8.2 8-11.2h-4.3z",
  bluetooth: "M8.4 6.6 15.6 17.4 12 21V3l3.6 3.4L8.4 17.4",
  mic: "M12 3.6a2.6 2.6 0 0 1 2.6 2.6v5.2a2.6 2.6 0 1 1-5.2 0V6.2A2.6 2.6 0 0 1 12 3.6zM6.4 11.4a5.6 5.6 0 0 0 11.2 0M12 17.4v3.2",
  camera: "M4.5 8.2h3.1l1.3-2h6.2l1.3 2h3.1a1 1 0 0 1 1 1v8.4a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V9.2a1 1 0 0 1 1-1zM12 13a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
} as const;

const glyph = (path: string, size = 14, stroke = true) => svg(path, size, stroke ? { stroke: 1.9 } : {});

// ── Which of volume / brightness owns the HUD ────────────────────────────────
//
// The controller usually stamps `hud: { kind, updatedAtMs }` and that wins. When
// it does not, we detect the change ourselves from consecutive snapshots (value
// or mute changed for volume, value changed for brightness) and otherwise keep
// whatever owned the HUD last. Deliberately not "last non-null field wins": both
// fields stay non-null for the life of the app, so that rule would hand the HUD
// to whichever one native happened to include.

function hudOwner() {
  let lastVolume: number | null = null;
  let lastMuted: boolean | null = null;
  let lastBrightness: number | null = null;
  let last: HudKind | null = null;
  return (snapshot: SystemSnapshot): HudKind | null => {
    const volume = snapshot.volume;
    const brightness = snapshot.brightness;
    let kind: HudKind | null = null;
    if (volume && (volume.value !== lastVolume || volume.muted !== lastMuted)) kind = "volume";
    else if (brightness && brightness.value !== lastBrightness) kind = "brightness";
    lastVolume = volume ? volume.value : null;
    lastMuted = volume ? volume.muted : null;
    lastBrightness = brightness ? brightness.value : null;
    if (snapshot.hud) kind = snapshot.hud.kind;
    // Neither sensor reports: neutral resting state, whatever we showed last.
    else if (volume || brightness) kind = kind ?? last ?? (volume ? "volume" : "brightness");
    else kind = null;
    if (kind !== null) last = kind;
    return kind;
  };
}

// ── Plug / unplug animation (spec row 14) ─────────────────────────────────────

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const PLUG_MS = 900;

/** Watches `powerSource` and flashes the chip for ~900 ms on connect or removal. */
function watchPower(el: HTMLElement) {
  let previous: string | null = null;
  let timer: number | null = null;
  return {
    update(powerSource: string | null) {
      const changed = previous !== null && powerSource !== null && previous !== powerSource;
      previous = powerSource;
      if (!changed) return;
      // Reduced motion: the text update is the whole message, no animation.
      if (reduced.matches) return;
      el.classList.remove("system-plug-in", "system-plug-out");
      void el.offsetWidth; // restart the keyframes on a repeat plug/unplug
      el.classList.add(powerSource === "ac" ? "system-plug-in" : "system-plug-out");
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        el.classList.remove("system-plug-in", "system-plug-out");
        timer = null;
      }, PLUG_MS);
    },
  };
}

// ── HUD (spec rows 9 and 10) ──────────────────────────────────────────────────

/**
 * Transient overlay that replaces the OS volume/brightness HUD. Shows whichever
 * sensor was reported most recently, or a neutral resting state when neither has
 * reported. Dismissal belongs to the controller — this view never hides itself.
 */
export function buildSystemHud(actions: ViewActions): ViewHost {
  const icon = h("span", { class: "system-hud-glyph" });
  const labelEl = h("div", { class: "sub" });
  const reading = h("div", { class: "system-hud-value", role: "status", "aria-live": "polite" });
  const fill = h("i", { class: "system-hud-fill" });
  const bar = h("div", {
    class: "system-hud-bar",
    role: "meter",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuenow": "0",
  }, fill);
  const el = h("div", { class: "view system-hud", tabindex: 0, "aria-label": "System volume and brightness" },
    h("div", { class: "card system-hud-card" }, h("div", { class: "stack system-hud-stack" },
      icon, labelEl, reading, bar)));
  const owner = hudOwner();

  function render() {
    const snapshot = systemStore.get();
    const kind = owner(snapshot);
    const muted = kind === "volume" ? snapshot.volume?.muted === true : false;
    const value = kind === "volume" ? snapshot.volume?.value ?? null : snapshot.brightness?.value ?? null;
    clear(icon);
    if (kind !== null) icon.append(glyph(kind === "volume" ? (muted ? ICON.volumeOff : ICON.volumeOn) : ICON.sun, kind === "volume" ? 34 : 30));
    text(labelEl, kind === "volume" ? "Volume" : kind === "brightness" ? "Brightness" : "System");
    // Muted shows the real value with a flat bar and the muted glyph: hiding the
    // number would make an audio fix un-tunable. A missing reading stays UNAVAILABLE.
    text(reading, value === null ? UNAVAILABLE : `${percent(value)}${muted ? " · Muted" : ""}`);
    const shown = muted ? 0 : value ?? 0;
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, shown)) * 100)}%`;
    bar.hidden = value === null;
    if (value !== null) bar.setAttribute("aria-valuenow", String(Math.round(Math.min(1, Math.max(0, value)) * 100)));
    el.classList.toggle("is-muted", muted);
    el.setAttribute("aria-label", value === null ? "System HUD — unavailable" : `${labelEl.textContent} ${reading.textContent}`);
  }

  const paint = throttle(render);
  systemStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); actions.collapse(); }
  });
  render();
  return { el, sync: paint.ordinary, focus: () => el.focus() };
}

// ── Status strip (spec rows 12, 13, 15, 16, 17, 18) ────────────────────────────

/**
 * Persistent chip row: battery, Bluetooth, mic/camera, date and — only when the
 * user opted in — CPU. The mic/camera chip exists only while something is in use.
 */
export function buildSystemStatus(actions: ViewActions): ViewHost {
  const battery = h("span", { class: "system-chip system-battery" });
  const bluetooth = h("span", { class: "system-chip" });
  const privacy = h("span", { class: "system-chip system-privacy" });
  const date = h("span", { class: "system-chip" });
  const cpu = h("span", { class: "system-chip system-cpu" });
  const cpuToggle = h("button", {
    class: "btn secondary system-cpu-toggle",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Show CPU usage",
    onclick: () => setCpuEnabled(!systemStore.get().cpuEnabled),
  }, h("span", { text: "CPU" }));
  const chips = h("div", { class: "system-status-chips", role: "status", "aria-live": "polite" },
    battery, bluetooth, privacy, date, cpu, cpuToggle);
  const details = h("div", { class: "system-status-detail sub", role: "status", "aria-live": "polite" });
  const el = h("div", { class: "view system-status", tabindex: 0, "aria-label": "System status" },
    h("div", { class: "card system-status-card" }, h("div", { class: "stack" }, chips, details)));
  const power = watchPower(battery);

  function renderBattery(b: Battery | null) {
    if (!b) { clear(battery); battery.classList.remove("is-charging"); return; }
    battery.classList.toggle("is-charging", b.charging);
    clear(battery);
    battery.append(glyph(ICON.battery, 13), h("span", { text: b.level === null ? UNAVAILABLE : percent(b.level) }));
    if (b.charging) battery.append(glyph(ICON.bolt, 11));
    battery.setAttribute("aria-label", b.level === null ? "Battery — unavailable" : `Battery ${percent(b.level)}${b.charging ? ", charging" : ""}`);
    power.update(b.powerSource);
  }

  function render() {
    const snapshot = systemStore.get();
    renderBattery(snapshot.battery);

    const connected = snapshot.bluetooth.filter((d) => d.connected);
    if (!connected.length) clear(bluetooth);
    else {
      const first = connected[0];
      clear(bluetooth);
      bluetooth.append(glyph(ICON.bluetooth, 13), h("span", {
        text: `${connected.length} · ${first.name}${first.battery === null ? "" : ` ${percent(first.battery)}`}`,
      }));
      bluetooth.setAttribute("aria-label", `${connected.length} Bluetooth device${connected.length === 1 ? "" : "s"}, ${first.name}${first.battery === null ? "" : ` at ${percent(first.battery)}`}`);
    }

    const inUse = [snapshot.microphoneInUse ? "Microphone" : null, snapshot.cameraInUse ? "Camera" : null]
      .filter((v): v is string => v !== null);
    clear(privacy);
    privacy.classList.toggle("is-live", inUse.length > 0);
    if (inUse.length) {
      privacy.append(glyph(snapshot.cameraInUse ? ICON.camera : ICON.mic, 13),
        h("span", { text: inUse.join(" + ") }),
        h("i", { class: "dot system-live-dot" }));
      privacy.setAttribute("aria-label", `${inUse.join(" and ")} in use`);
    }

    text(date, dateLabel(snapshot.date));
    date.setAttribute("aria-label", `Date ${dateLabel(snapshot.date)}`);

    const showCpu = snapshot.cpuEnabled;
    cpu.hidden = !showCpu;
    cpuToggle.setAttribute("aria-pressed", showCpu ? "true" : "false");
    cpuToggle.setAttribute("aria-label", showCpu ? "Hide CPU usage" : "Show CPU usage");
    if (showCpu) {
      clear(cpu);
      // The number native hands over, printed as-is. No interpolation, no easing.
      cpu.append(h("span", { text: snapshot.cpuUsage === null ? UNAVAILABLE : `CPU ${percent(snapshot.cpuUsage)}` }));
    } else clear(cpu);

    const b = snapshot.battery;
    const parts = b
      ? [
        `Power ${b.powerSource === null ? UNAVAILABLE : b.powerSource === "ac" ? "AC" : "Battery"}`,
        `Charge ${b.wattage === null ? UNAVAILABLE : watts(b.wattage)}`,
        b.timeToFullSeconds === null && b.timeToEmptySeconds === null
          ? `Time ${UNAVAILABLE}`
          : b.timeToFullSeconds !== null ? `Time to full ${formatDuration(b.timeToFullSeconds)}` : `Time until empty ${formatDuration(b.timeToEmptySeconds ?? 0)}`,
        b.health === null ? "" : `Health ${percent(b.health)}`,
      ].filter(Boolean).join(" · ")
      : `Battery ${UNAVAILABLE}`;
    text(details, parts);
  }

  const paint = throttle(render);
  systemStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); actions.setView("overview"); }
  });
  render();
  return { el, sync: paint.ordinary, focus: () => cpuToggle.focus() };
}

// ── Compact-island indicator (spec rows 12 and 17) ────────────────────────────

/**
 * The 288×32 strip: date on the left, battery on the right. No battery half at
 * all on a desktop — an empty 0 % pill would be a lie.
 */
export function buildSystemIndicator(): { el: HTMLElement; sync: () => void } {
  const date = h("span", { class: "system-indicator-date" });
  const battery = h("span", { class: "system-indicator-battery" });
  const level = h("span", {});
  const fill = h("i", { class: "system-indicator-fill" });
  battery.append(glyph(ICON.battery, 12), level, h("span", { class: "system-indicator-bar" }, fill));
  const el = h("div", { class: "system-indicator", "aria-label": "Date and battery" }, date, battery);
  const power = watchPower(battery);

  function render() {
    const snapshot = systemStore.get();
    text(date, dateLabel(snapshot.date));
    const b = snapshot.battery;
    battery.hidden = b === null || b.level === null;
    if (b && b.level !== null) {
      battery.classList.toggle("is-charging", b.charging);
      text(level, percent(b.level));
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, b.level)) * 100)}%`;
      battery.setAttribute("aria-label", `Battery ${percent(b.level)}${b.charging ? ", charging" : ""}`);
      power.update(b.powerSource);
    }
  }

  const paint = throttle(render);
  systemStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  render();
  return { el, sync: paint.ordinary };
}
