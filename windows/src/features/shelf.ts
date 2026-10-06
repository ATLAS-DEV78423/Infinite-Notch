// File shelf — hold dropped files, folders, images and text on the island
// (notch-app-feature-spec.md §5, rows #23-#29).
//
// Native owns every path. This module renders rows from `shelfStore` and hands a
// path straight back to native through a bubbling CustomEvent, which the
// controller bridges to `NativeActions` (openPath / sharePath / revealPath).
// Nothing here reads the filesystem, and nothing happens merely because a file
// was dropped (handoff.md §8, "Selected inputs only"): a dropped item stays inert
// on the shelf until an explicit click.
//
// File integrity (same section): the view has no delete. "Remove" drops the row
// and nothing else — native owns deletion and never deletes an original, a
// foreign entry or a committed received file. A `received` row is a reference,
// not temporary delete rights, so it renders no remove affordance at all.
//
// Capacity and failures are always visible: 32 rows is a hard ceiling, and a
// refused ingest is reported per item or in the banner, never swallowed.
//
// Two files, no shell edits: the controller wires the store, the view and the
// compact indicator into the island.

import "./shelf.css";
import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import { FeatureStore, throttle, UNAVAILABLE, formatBytes } from "./contract";
import type { ViewActions, ViewHost } from "./contract";

export type ShelfKind = "file" | "folder" | "image" | "text";

export interface ShelfItem {
  id: string;
  name: string;
  /** Absolute path. Native-owned; the view only ever passes it back to native. */
  path: string;
  kind: ShelfKind;
  isDirectory: boolean;
  /** null when the size could not be determined (a directory, or a refused read). */
  sizeBytes: number | null;
  addedAtMs: number;
  /** data: URL from native, or null. Never fabricate a placeholder image. */
  thumbnail: string | null;
  /** True for files that arrived over the network — references, never delete rights. */
  received: boolean;
  /** Non-null when this specific item failed; render it inline. */
  error: string | null;
  /** Native reports readiness. Actions are disabled until true. */
  ready: boolean;
}

export interface ShelfState {
  items: ShelfItem[];
  /** Spec row #28. Default true: the shelf is on unless the user turns it off. */
  enabled: boolean;
  /** Spec row #27. Default false = original arrival order, newest first is opt-in. */
  newestFirst: boolean;
  /** Non-null when the shelf as a whole refused something (e.g. at capacity). */
  shelfError: string | null;
}

/** The only data seam. The controller pushes a whole snapshot per native update. */
export const shelfStore = new FeatureStore<ShelfState>({
  items: [],
  enabled: true,
  newestFirst: false,
  shelfError: null,
});

/** Spec row #23 + handoff.md §8: at most 32 held items, no eviction. */
export const SHELF_CAPACITY = 32;

/**
 * Events dispatched on the view root, all `bubbles: true` so the controller can
 * delegate from a container. None of them act on their own — every one is a
 * request for native:
 *   `shelf-open`            detail: `path: string`       → `NativeActions.openPath`
 *   `shelf-share`           detail: `path: string`       → `NativeActions.sharePath` (platform share sheet)
 *   `shelf-reveal`          detail: `path: string`       → `NativeActions.revealPath`
 *   `shelf-remove`          detail: `{ id: string }`    → drop the row only; native owns deletion
 *   `shelf-drag`            detail: `{ id, path }`      → real native drag-out (OLE / Finder) when available
 *   `shelf-toggle-order`    no detail                    → flip `newestFirst`, then re-sort
 *   `shelf-toggle-enabled`  no detail                    → turn the shelf off / on
 *   `shelf-drop`            detail: `paths: string[]`   → ingest these explicitly chosen selections
 */
export const SHELF_OPEN_EVENT = "shelf-open";
export const SHELF_SHARE_EVENT = "shelf-share";
export const SHELF_REVEAL_EVENT = "shelf-reveal";
export const SHELF_REMOVE_EVENT = "shelf-remove";
export const SHELF_DRAG_EVENT = "shelf-drag";
export const SHELF_TOGGLE_ORDER_EVENT = "shelf-toggle-order";
export const SHELF_TOGGLE_ENABLED_EVENT = "shelf-toggle-enabled";
export const SHELF_DROP_EVENT = "shelf-drop";

// `doc` and `stack` already exist on the shared 24×24 grid; a folder and a text
// line are the two the shared set does not have.
const GLYPH: Record<ShelfKind, string> = {
  file: ICONS.doc,
  folder: ICONS.stack,
  image: "M3.5 5h17v14h-17zM5.3 6.8v10.4h13.4V6.8zm3.1 1.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zM6.4 17.2l4.2-5 2.4 2.9 2-2.3 2.6 3.4v1z",
  text: "M4 6h16v1.8H4zm0 4.4h16v1.8H4zm0 4.4h11v1.8H4z",
};

const KIND_WORD: Record<ShelfKind, string> = {
  file: "File",
  folder: "Folder",
  image: "Image",
  text: "Text",
};

/** A directory has no byte size, and a refused read is unavailable, not zero. */
function sizeText(item: ShelfItem): string {
  return item.isDirectory || item.sizeBytes === null ? UNAVAILABLE : formatBytes(item.sizeBytes);
}

function setText(el: HTMLElement, value: string) {
  if (el.textContent !== value) el.textContent = value;
}

function tileLabel(item: ShelfItem): string {
  const parts = [item.name, KIND_WORD[item.kind], sizeText(item)];
  if (item.received) parts.push("received, reference only");
  if (item.error) parts.push(`failed: ${item.error}`);
  else if (!item.ready) parts.push("not ready");
  return parts.join(", ");
}

/** Arrival order is the array order native hands us; newest-first is opt-in. */
function ordered(items: ShelfItem[], newestFirst: boolean): ShelfItem[] {
  // sort() is stable (ES2019), so equal addedAtMs keeps the arrival order.
  return newestFirst ? [...items].sort((a, b) => b.addedAtMs - a.addedAtMs) : items;
}

/**
 * Paths the webview exposes for dropped files. Tauri reports the authoritative
 * list itself through `onDragDropEvent` (bridge.ts), which is what the controller
 * listens to; this path exists for the browser dev harness and for the highlight.
 */
function droppedPaths(transfer: DataTransfer | null): string[] {
  if (!transfer) return [];
  const paths: string[] = [];
  for (const file of Array.from(transfer.files)) {
    const path = (file as File & { path?: string }).path;
    if (typeof path === "string" && path) paths.push(path);
  }
  return paths;
}

/** Marching dashed rect — the same treatment as the upload drop card. */
function dashedFrame(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const frame = document.createElementNS(ns, "svg");
  frame.setAttribute("class", "drop-frame shelf-frame");
  frame.setAttribute("preserveAspectRatio", "none");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "0.75");
  rect.setAttribute("y", "0.75");
  rect.setAttribute("width", "calc(100% - 1.5px)");
  rect.setAttribute("height", "calc(100% - 1.5px)");
  rect.setAttribute("rx", "14");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  frame.append(rect);
  return frame;
}

interface Tile {
  el: HTMLElement;
  update(item: ShelfItem, enabled: boolean): void;
}

export function buildShelf(actions: ViewActions): ViewHost {
  const back = h("button", { class: "btn secondary", text: "Back", onclick: () => actions.setView("overview") });
  const count = h("span", { class: "shelf-count" });
  const orderBtn = h("button", { class: "btn secondary shelf-toggle" });
  const enabledBtn = h("button", { class: "btn secondary shelf-toggle" });
  const banner = h("div", { class: "shelf-banner", role: "status", "aria-live": "polite" });
  const list = h("div", { class: "shelf-list", role: "list", "aria-label": "Shelf items" });
  const note = h("div", { class: "shelf-note sub" });
  const card = h(
    "div",
    { class: "card shelf-card" },
    dashedFrame(),
    h(
      "div",
      { class: "stack shelf-stack" },
      h("div", { class: "shelf-head" }, h("div", { class: "row" }, h("div", { class: "title", text: "Shelf" }), count), back),
      banner,
      h("div", { class: "shelf-controls" }, orderBtn, enabledBtn),
      list,
      note,
    ),
  );
  const el = h("div", { class: "view shelf", "aria-label": "File shelf" }, card);

  function fire<T>(event: string, detail?: T) {
    el.dispatchEvent(new CustomEvent<T>(event, { detail, bubbles: true }));
  }

  const tiles = new Map<string, Tile>();
  /** The live row for a tile, so a click never acts on a stale snapshot. */
  const liveItem = (id: string) => shelfStore.get().items.find((item) => item.id === id);
  /** The only state in which an action runs: shelf on, native ready, no failure. */
  const usable = (item: ShelfItem) => shelfStore.get().enabled && item.ready && item.error === null;
  const withItem = (id: string, run: (item: ShelfItem) => void) => {
    const item = liveItem(id);
    if (item && usable(item)) run(item);
  };

  function createTile(id: string): Tile {
    const thumb = h("div", { class: "shelf-thumb", "aria-hidden": "true" });
    const name = h("div", { class: "shelf-name" });
    const size = h("div", { class: "shelf-size" });
    const received = h("div", { class: "shelf-received", text: "Received" });
    const error = h("div", { class: "shelf-error" });
    const share = h("button", { class: "btn secondary shelf-act" }, h("span", { text: "Share" }));
    const reveal = h("button", { class: "btn secondary shelf-act" }, h("span", { text: "Reveal" }));
    const actionRow = h("div", { class: "shelf-tile-actions" }, share, reveal);
    const tileEl = h(
      "div",
      { class: "shelf-tile", role: "listitem", tabindex: 0 },
      thumb,
      h("div", { class: "shelf-text" }, name, h("div", { class: "shelf-meta" }, size, received)),
      error,
      actionRow,
    );
    let removeBtn: HTMLButtonElement | null = null;
    let renderedThumb: string | null | undefined;

    share.addEventListener("click", () => withItem(id, (item) => fire(SHELF_SHARE_EVENT, item.path)));
    reveal.addEventListener("click", () => withItem(id, (item) => fire(SHELF_REVEAL_EVENT, item.path)));

    // Spec row #24: the second click of a double-click opens the item. Clicks
    // inside the button row belong to those buttons, never to "open this file".
    tileEl.addEventListener("click", (event) => {
      if (event.detail !== 2 || (event.target as Element).closest(".shelf-tile-actions")) return;
      withItem(id, (item) => fire(SHELF_OPEN_EVENT, item.path));
    });
    tileEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      withItem(id, (item) => fire(SHELF_OPEN_EVENT, item.path));
    });

    tileEl.addEventListener("dragstart", (event) => {
      const item = liveItem(id);
      const transfer = event.dataTransfer;
      if (!item || !transfer || !usable(item)) {
        event.preventDefault();
        return;
      }
      // Spec row #29: attach the real file, not a text path, so it lands as an
      // attachment in WhatsApp / Mail / Explorer. `DownloadURL` is the Chromium
      // convention for "this is a real local file"; the path is encoded because
      // it may contain spaces and non-ASCII. What the webview cannot do on its
      // own: OLE `IDataObject` drag-out on Windows and a real Finder drag on
      // macOS both need the native side, which the controller reaches through
      // `shelf-drag`; until then this is the honest best a DOM drag can carry.
      transfer.setData("DownloadURL", `file:${encodeURI(item.path)}`);
      transfer.setData("text/uri-list", `file://${item.path}`);
      transfer.effectAllowed = "copy";
      fire(SHELF_DRAG_EVENT, { id, path: item.path });
    });

    return {
      el: tileEl,
      update(item, enabled) {
        if (tileEl.title !== item.name) tileEl.title = item.name;
        tileEl.setAttribute("aria-label", tileLabel(item));
        setText(name, item.name);
        setText(size, sizeText(item));
        received.hidden = !item.received;
        setText(error, item.error ?? "");
        error.hidden = item.error === null;

        const on = enabled && item.ready && item.error === null;
        share.disabled = !on;
        reveal.disabled = !on;
        tileEl.setAttribute("aria-disabled", String(!on));
        tileEl.draggable = on;

        // Received items are references, not temporary delete rights: the remove
        // affordance is omitted outright rather than greyed out.
        if (item.received) {
          removeBtn?.remove();
          removeBtn = null;
        } else if (!removeBtn) {
          removeBtn = h(
            "button",
            { class: "btn secondary shelf-act shelf-remove", onclick: () => withItem(id, () => fire(SHELF_REMOVE_EVENT, { id })) },
            h("span", { text: "Remove" }),
          );
          actionRow.append(removeBtn);
        }
        if (removeBtn) {
          removeBtn.disabled = !on;
          removeBtn.setAttribute("aria-label", `Remove ${item.name} from the shelf`);
        }

        share.setAttribute("aria-label", `Share ${item.name}`);
        reveal.setAttribute("aria-label", `Reveal ${item.name} in folder`);

        if (item.thumbnail !== renderedThumb) {
          renderedThumb = item.thumbnail;
          clear(thumb);
          thumb.append(
            item.thumbnail
              ? h("img", { class: "shelf-thumb-img", src: item.thumbnail, alt: "" })
              : h("i", { class: "shelf-glyph" }, svg(GLYPH[item.kind], 15)),
          );
        }
      },
    };
  }

  function render() {
    const state = shelfStore.get();
    const rows = ordered(state.items, state.newestFirst).slice(0, SHELF_CAPACITY);
    const keys = new Set(rows.map((item) => item.id));
    for (const [id, tile] of tiles) {
      if (keys.has(id)) continue;
      tile.el.textContent = "";
      tile.el.remove();
      tiles.delete(id);
    }
    rows.forEach((item, index) => {
      let tile = tiles.get(item.id);
      if (!tile) {
        tile = createTile(item.id);
        tiles.set(item.id, tile);
      }
      tile.update(item, state.enabled);
      if (list.children[index] !== tile.el) list.insertBefore(tile.el, list.children[index] ?? null);
    });

    setText(count, `${state.items.length}/${SHELF_CAPACITY}`);
    setText(orderBtn, state.newestFirst ? "Newest first" : "Arrival order");
    orderBtn.setAttribute("aria-pressed", String(state.newestFirst));
    setText(enabledBtn, state.enabled ? "Shelf on" : "Shelf off");
    enabledBtn.setAttribute("aria-pressed", String(state.enabled));

    // Capacity is stated, never enforced by hiding rows: native owns the cap and
    // reports a refusal, so the view shows the cap and every item it was given.
    const overflow = state.items.length - SHELF_CAPACITY;
    setText(banner, state.shelfError ?? (overflow > 0
      ? `Shelf full (${SHELF_CAPACITY}) · ${overflow} more item${overflow === 1 ? "" : "s"} not shown`
      : state.items.length >= SHELF_CAPACITY
        ? `Shelf full (${SHELF_CAPACITY})`
        : ""));
    banner.classList.toggle("error", state.shelfError !== null);
    banner.classList.toggle("warn", state.shelfError === null && state.items.length >= SHELF_CAPACITY);

    list.hidden = rows.length === 0;
    note.hidden = rows.length > 0;
    setText(note, state.enabled
      ? "Drop files, folders, images or text here to hold them. Nothing opens or sends by itself."
      : "Shelf is off — drops are refused.");
  }

  orderBtn.addEventListener("click", () => fire(SHELF_TOGGLE_ORDER_EVENT));
  enabledBtn.addEventListener("click", () => fire(SHELF_TOGGLE_ENABLED_EVENT));

  card.addEventListener("dragover", (event) => {
    if (!shelfStore.get().enabled) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    card.classList.add("over");
  });
  card.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !card.contains(event.relatedTarget as Node)) card.classList.remove("over");
  });
  card.addEventListener("drop", (event) => {
    card.classList.remove("over");
    // Spec row #28: with the shelf off a drop is refused outright.
    if (!shelfStore.get().enabled) return;
    event.preventDefault();
    // At capacity the view refuses nothing itself: native owns the cap and either
    // accepts the item or reports the refusal per item / in `shelfError`, so no
    // item is dropped without the user being told.
    const paths = droppedPaths(event.dataTransfer);
    if (paths.length) fire(SHELF_DROP_EVENT, paths);
  });

  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); actions.setView("overview"); }
  });

  const paint = throttle(render);
  shelfStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  render();

  return { el, sync: () => paint.ordinary(), focus: () => back.focus() };
}

/**
 * The 288×32 compact strip: how many items are held and the first thumbnail.
 * Nothing at all when the shelf is off or empty, so the collapsed island only
 * spends pixels on the shelf when there is something on it.
 */
export function buildShelfIndicator(): { el: HTMLElement; sync: () => void } {
  const art = h("div", { class: "shelf-indicator-art" });
  const count = h("span", { class: "shelf-indicator-count" });
  const el = h("div", { class: "shelf-indicator", role: "status", "aria-label": "File shelf" }, art, count);
  let renderedThumb: string | null | undefined;

  function render() {
    const state = shelfStore.get();
    el.hidden = !state.enabled || state.items.length === 0;
    if (el.hidden) return;
    const first = ordered(state.items, state.newestFirst)[0];
    const full = state.items.length >= SHELF_CAPACITY;
    setText(count, full ? `${SHELF_CAPACITY} · full` : String(state.items.length));
    el.setAttribute("aria-label", full
      ? `File shelf: ${state.items.length} items, shelf full`
      : `File shelf: ${state.items.length} item${state.items.length === 1 ? "" : "s"}`);
    const thumb = first?.thumbnail ?? null;
    if (thumb !== renderedThumb) {
      renderedThumb = thumb;
      clear(art);
      art.append(thumb ? h("img", { class: "shelf-indicator-img", src: thumb, alt: "" }) : h("i", { class: "shelf-indicator-dot" }));
    }
  }

  const paint = throttle(render);
  shelfStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  render();

  return { el, sync: () => paint.ordinary() };
}