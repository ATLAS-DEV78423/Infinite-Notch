// Media feature — now-playing display, transport controls, the decorative
// visualizer and the compact-island indicator.
//
// Native pushes a NowPlaying snapshot into `mediaStore`; this module only reads
// it and dispatches control events for the controller to bridge to the platform.
// It never touches the network, the clipboard or the filesystem, and broad
// source support (SMTC / Now Playing) stays on the native side: `source` is
// reported to us, never discovered here.
//
// Privacy contract (handoff.md §8, "Media/system/calendar"): no capture for a
// decorative audio wave, no in-use inference, no process/app inventory. The
// visualizer below is purely decorative — it is driven by the boolean `playing`
// flag and a deterministic pseudo-random walk. It carries NO amplitude data:
// no Web Audio context, no microphone, no output stream, no measurement of any
// kind. It also never animates while the view is off screen: every frame comes
// from the shell's `tick`, which the island only calls for the active view.

import { h, svg, clear } from "../views/dom";
import { FeatureStore, formatDuration, throttle } from "./contract";
import type { ViewActions, ViewHost } from "./contract";

import "./media.css";

export interface NowPlaying {
  /** false when no source is reporting — the view must show "Not playing", never a blank. */
  available: boolean;
  title: string;
  artist: string;
  album: string;
  /** data: URL supplied by native, or null. Never fabricate placeholder artwork. */
  artwork: string | null;
  playing: boolean;
  /** Seconds. `duration` null when the source does not report one. */
  elapsed: number;
  duration: number | null;
  /** Native-reported source label, e.g. "Apple Music", "Spotify", "Browser". Null when unknown. */
  source: string | null;
}

/** Nothing is reporting. The view renders this as "Not playing", never as a gap. */
const NOTHING: NowPlaying = {
  available: false,
  title: "",
  artist: "",
  album: "",
  artwork: null,
  playing: false,
  elapsed: 0,
  duration: null,
  source: null,
};

/**
 * The only data seam. The controller pushes a whole snapshot per native update;
 * there is no partial patch and no diffing here.
 */
export const mediaStore = new FeatureStore<{ nowPlaying: NowPlaying }>({
  nowPlaying: NOTHING,
});

/** Fired on the view root when the user drags the seek bar. `detail` is seconds. */
export const MEDIA_SEEK_EVENT = "media-seek";
/** Fired on the view root by the transport buttons. `detail` is a MediaCommand. */
export const MEDIA_COMMAND_EVENT = "media-command";
/** Bubbling so the controller can delegate from a container instead of per view. */
export type MediaCommand = "previous" | "toggle" | "next";

// SF Symbols stand-ins for the transport, drawn on the same 24×24 grid as
// src/views/icons.ts. Kept local: icons.ts is a shared file this module does not own.
const GLYPH = {
  play: "M7 4.6 19.4 12 7 19.4z",
  pause: "M6.6 4.4h3.6v15.2H6.6zM13.8 4.4h3.6v15.2h-3.6z",
  next: "M5.4 5.2 15 12l-9.6 6.8zM16.4 4.6h2.8v14.8h-2.8z",
  previous: "M18.6 5.2 9 12l9.6 6.8zM4.8 4.6h2.8v14.8H4.8z",
} as const;

const BARS = 24;
const VIZ_H = 44;

function setText(el: HTMLElement, value: string) {
  if (el.textContent !== value) el.textContent = value;
}

let motionQuery: MediaQueryList | null = null;
/** Read lazily so importing the module costs nothing and survives a settings change. */
function reducedMotion(): boolean {
  return (motionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)")).matches;
}

// ── Visualizer ────────────────────────────────────────────────────────────────

/**
 * Deterministic bar heights: two summed sines seeded by the bar index, so the
 * same instant always draws the same frame. Decorative only — see the file
 * header. Under reduced motion the caller passes `animate = false` and we draw
 * one static frame; we never schedule an animation frame from here.
 */
function barHeight(i: number, t: number, animate: boolean): number {
  if (!animate) return 0.16 + 0.12 * Math.sin((Math.PI * i) / (BARS - 1));
  const phase = i * 0.62;
  const a = 0.5 + 0.5 * Math.sin(t * 2.4 + phase);
  const b = 0.5 + 0.5 * Math.sin(t * 1.3 + phase * 1.7);
  return 0.14 + 0.86 * a * b;
}

function createVisualizer(): { el: HTMLCanvasElement; draw: (nowMs: number, animate: boolean) => void } {
  const el = h("canvas", { class: "media-viz", "aria-hidden": "true" }) as HTMLCanvasElement;
  const ctx = el.getContext("2d");
  let width = 0;
  let ratio = 1;
  let accent = "";

  /** The accent comes from the app palette, never a second hardcoded colour. */
  function resolveAccent(): string {
    const css = getComputedStyle(document.documentElement);
    // The fallback is unreachable while style.css defines both properties.
    return (accent = css.getPropertyValue("--green-2").trim() || css.getPropertyValue("--green").trim() || "#34d399");
  }

  return {
    el,
    draw(nowMs, animate) {
      if (!ctx) return;
      const cssWidth = Math.max(120, Math.round(el.clientWidth));
      const dpr = window.devicePixelRatio || 1;
      // Resizing clears the canvas and resets the transform, so only do it on change.
      if (cssWidth !== width || dpr !== ratio) {
        width = cssWidth;
        ratio = dpr;
        el.width = Math.round(width * dpr);
        el.height = Math.round(VIZ_H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      const t = animate ? nowMs / 1000 : 0;
      ctx.clearRect(0, 0, width, VIZ_H);
      // Read once, not per frame: a style lookup in the animation path is the
      // kind of thing that eats the 16.7 ms frame budget.
      ctx.fillStyle = accent || resolveAccent();
      const slot = width / BARS;
      const bar = Math.max(2, slot - 4);
      const middle = VIZ_H / 2;
      for (let i = 0; i < BARS; i++) {
        const height = Math.max(3, (VIZ_H - 6) * barHeight(i, t, animate));
        ctx.beginPath();
        ctx.roundRect(i * slot + (slot - bar) / 2, middle - height / 2, bar, height, bar / 2);
        ctx.fill();
      }
    },
  };
}

// ── Now-playing view (spec rows #3, #4, #5) ───────────────────────────────────

export function buildNowPlaying(actions: ViewActions): ViewHost {
  const back = h("button", { class: "btn secondary", text: "Back", onclick: () => actions.setView("overview") });
  const art = h("div", { class: "media-art" });
  const title = h("div", { class: "title" });
  const artist = h("div", { class: "sub" });
  const album = h("div", { class: "sub media-album" });
  const meta = h("div", { class: "media-meta", role: "status" }, title, artist, album);

  const seek = h("input", {
    type: "range",
    min: "0",
    max: "0",
    step: "1",
    class: "media-seek-input",
    "aria-label": "Seek",
  }) as HTMLInputElement;
  const elapsedEl = h("span");
  const totalEl = h("span");
  const seekRow = h("div", { class: "media-seek" }, seek, h("div", { class: "media-times" }, elapsedEl, totalEl));

  const previous = h("button", { class: "btn secondary media-transport", "aria-label": "Previous track", onclick: () => el.dispatchEvent(new CustomEvent<MediaCommand>(MEDIA_COMMAND_EVENT, { detail: "previous", bubbles: true })) }, svg(GLYPH.previous, 13));
  const toggle = h("button", { class: "btn primary media-transport", onclick: () => el.dispatchEvent(new CustomEvent<MediaCommand>(MEDIA_COMMAND_EVENT, { detail: "toggle", bubbles: true })) }, svg(GLYPH.play, 13)) as HTMLButtonElement;
  const next = h("button", { class: "btn secondary media-transport", "aria-label": "Next track", onclick: () => el.dispatchEvent(new CustomEvent<MediaCommand>(MEDIA_COMMAND_EVENT, { detail: "next", bubbles: true })) }, svg(GLYPH.next, 13));
  const transport = h("div", { class: "media-transport-row" }, previous, toggle, next);

  const viz = createVisualizer();
  const body = h("div", { class: "media-body" }, art, h("div", { class: "media-main" }, meta, seekRow, transport));
  const el = h("div", { class: "view media-nowplaying", "aria-label": "Now playing" },
    h("div", { class: "card" }, h("div", { class: "stack" }, back, body, viz.el)),
  );

  const beat = throttle(render);
  let renderedArt: string | null | undefined;
  let renderedPlay = false;
  let renderedSource: string | null = null;
  let sourceEl: HTMLElement | null = null;
  let scrubbing = false;

  // While the user has the seek bar, native keeps pushing position snapshots that
  // would yank the thumb back under their finger.
  const stopScrub = () => { scrubbing = false; };
  seek.addEventListener("pointerdown", () => { scrubbing = true; });
  seek.addEventListener("keydown", () => { scrubbing = true; });
  seek.addEventListener("pointerup", stopScrub);
  seek.addEventListener("keyup", stopScrub);
  seek.addEventListener("blur", stopScrub);
  seek.addEventListener("input", () => {
    const seconds = Number(seek.value);
    // The controller owns the actual seek; ViewActions has no member for it.
    if (Number.isFinite(seconds)) el.dispatchEvent(new CustomEvent<number>(MEDIA_SEEK_EVENT, { detail: seconds, bubbles: true }));
  });

  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); actions.setView("overview"); }
  });

  function render() {
    const np = mediaStore.get().nowPlaying;
    setText(title, np.available && np.title ? np.title : "Not playing");
    setText(artist, np.available ? np.artist : "");
    setText(album, np.available ? np.album : "");

    // The source label is native-reported; when unknown, omit the element.
    if (np.source !== renderedSource) {
      renderedSource = np.source;
      sourceEl?.remove();
      sourceEl = null;
      if (np.source) {
        sourceEl = h("div", { class: "media-source", text: np.source });
        meta.append(sourceEl);
      }
    }

    if (np.artwork !== renderedArt) {
      renderedArt = np.artwork;
      clear(art);
      // The title region beside it already carries the track name, so the image
      // itself is decorative to a screen reader.
      if (np.artwork) art.append(h("img", { class: "media-art-img", src: np.artwork, alt: "" }));
      else art.append(h("i", { class: "media-art-empty" }));
    }

    // duration 0 or negative is not a track length — treat it as unreported.
    const total = np.duration !== null && np.duration > 0 ? np.duration : null;
    const position = Math.max(0, total === null ? np.elapsed : Math.min(np.elapsed, total));
    setText(elapsedEl, formatDuration(position));
    setText(totalEl, total === null ? "" : formatDuration(total));
    seek.disabled = total === null;
    if (!scrubbing) {
      seek.max = String(total ?? 0);
      seek.value = String(Math.round(position));
    }

    previous.disabled = !np.available;
    next.disabled = !np.available;
    toggle.disabled = !np.available;
    toggle.setAttribute("aria-label", np.playing ? "Pause" : "Play");
    if (np.playing !== renderedPlay) {
      renderedPlay = np.playing;
      clear(toggle);
      toggle.append(svg(np.playing ? GLYPH.pause : GLYPH.play, 13));
    }
    // One static frame now, so the bars are never blank on first paint.
    if (!np.playing || reducedMotion()) viz.draw(performance.now(), false);
  }

  mediaStore.subscribe((urgent) => (urgent ? beat.urgent() : beat.ordinary()));

  return {
    el,
    sync() {
      beat.ordinary();
    },
    focus: () => back.focus(),
    // Every animated frame of the decorative visualizer comes from here, and the
    // island only ticks the view it is showing.
    tick(now) {
      if (!mediaStore.get().nowPlaying.playing || reducedMotion()) return;
      viz.draw(now, true);
    },
  };
}

// ── Compact-island indicator (spec row #8) ────────────────────────────────────

/**
 * Cover art plus a three-bar wave for the 288×32 compact island. The wave is CSS,
 * not a canvas: the compact island has no per-frame tick hook to hang on, and a
 * `.playing` gate already satisfies "resting state, no animation" when nothing
 * is playing. Keep it inside whatever layer the island pauses when hidden so the
 * decoration cannot repaint off screen.
 */
export function buildMediaIndicator(): { el: HTMLElement; sync: () => void } {
  const art = h("div", { class: "media-indicator-art" });
  const wave = h("div", { class: "media-indicator-wave", "aria-hidden": "true" },
    ...[0, 1, 2].map((i) => h("i", { class: "media-wave-bar", style: `animation-delay:${i * 0.16}s` })),
  );
  const el = h("div", { class: "media-indicator", role: "status", "aria-label": "Now playing" }, art, wave);
  let renderedArt: string | null | undefined;

  return {
    el,
    sync() {
      const np = mediaStore.get().nowPlaying;
      el.classList.toggle("playing", np.available && np.playing);
      el.setAttribute("aria-label", np.available && np.title ? `Now playing: ${np.title}` : "Not playing");
      if (np.artwork !== renderedArt) {
        renderedArt = np.artwork;
        clear(art);
        art.append(np.artwork ? h("img", { class: "media-indicator-img", src: np.artwork, alt: "" }) : h("i", { class: "media-indicator-dot" }));
      }
    },
  };
}