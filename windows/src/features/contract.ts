// Shared seam for the new island feature modules (media, system, transfers, shelf).
//
// Each module under src/features/ owns exactly two files: <name>.ts and <name>.css.
// They never touch the shared shell files (core/layout.ts, core/state.ts,
// views/views.ts, core/bridge.ts, style.css) — the controller wires those up.
//
// Data flows one way: native pushes a snapshot into the module's store, the view
// renders it. Nothing here reads the network, the clipboard or the filesystem.

export type { ViewActions, ViewHost } from "../views/views";

/**
 * Observable snapshot holder. Deliberately dumb: the native side replaces the whole
 * value, the view re-renders from it. No mutation, no partial updates, no diffing —
 * the payloads are small and this keeps the native/UI contract obvious.
 */
export class FeatureStore<T> {
  private listeners = new Set<(urgent: boolean) => void>();

  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  set(next: T, urgent = false) {
    this.value = next;
    for (const fn of this.listeners) fn(urgent);
  }

  /** The listener receives `true` when the update must not wait for the throttle. */
  subscribe(fn: (urgent: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Ordinary display/progress updates are capped at 4 Hz (docs: performance contract).
 * Consent prompts and terminal states must appear immediately, so they pass
 * `urgent` and bypass this.
 */
export const ORDINARY_UPDATE_MS = 250;

/**
 * Wraps a throttled render. `render` is called at most every `ORDINARY_UPDATE_MS`
 * for ordinary updates, and always for urgent ones.
 *
 * ponytail: one timer per view, no scheduler. A shared 4 Hz ticker would need
 * per-view subscriber bookkeeping for no measurable gain at this payload size.
 */
export function throttle(
  render: () => void,
  now: () => number = () => performance.now(),
): { urgent: () => void; ordinary: () => void; due: (atMs: number) => boolean } {
  let last = -Infinity;
  let timer: number | null = null;
  const fire = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    last = now();
    render();
  };
  return {
    urgent: fire,
    ordinary() {
      const elapsed = now() - last;
      if (elapsed >= ORDINARY_UPDATE_MS) fire();
      else if (timer === null) timer = window.setTimeout(fire, ORDINARY_UPDATE_MS - elapsed);
    },
    due: (atMs) => atMs - last >= ORDINARY_UPDATE_MS,
  };
}

/**
 * The word the whole feature set uses when native has not supplied a value.
 * Spec rule: unavailable stays unavailable — never render a fabricated zero or guess.
 */
export const UNAVAILABLE = "Unavailable";

/** Bytes with one decimal, e.g. `1.4 MB`. Used by transfers and the shelf. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return UNAVAILABLE;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Seconds as `12s` / `3m 20s` / `1h 04m`. Clamped: transfer ETAs lie, so never negative. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return UNAVAILABLE;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

/** Escape hatch used by every button that must reach the platform. */
export interface NativeActions {
  openUrl: (url: string) => void;
  /** Opens a shelf file with the real default application, never a text path. */
  openPath: (path: string) => void;
  /** Shows the platform share sheet / "Open with" panel for a real file. */
  sharePath: (path: string) => void;
  /** Reveals a file in Finder / Explorer. */
  revealPath: (path: string) => void;
}
