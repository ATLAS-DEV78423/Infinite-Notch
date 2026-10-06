// LocalSend file sharing — nearby devices, incoming consent, transfer progress,
// history and the section 6.5 settings.
//
// Native pushes one whole snapshot into `transfersStore`; every view below only
// reads it and dispatches intent events for the controller to bridge to the
// platform. This module never opens a socket, never reads the clipboard, never
// touches the filesystem, and never holds a key, token or PIN — those stay in
// the native secure store. Untrusted strings (device names, file names, failure
// reasons) arrive from other machines on the local network and always go into
// the DOM through `textContent`; nothing here renders markup from them.
//
// Security contract (handoff.md §8), as it shows up in this file:
//   - Receiving and history are OFF by default and the store starts empty.
//   - Transport must report `https`. Anything else — including "not reported" —
//     renders a refusal with no way forward, never a "continue anyway".
//   - A favourite is a UI pin, not authenticated trust. Only a `verifiedIdentity`
//     fingerprint is ever called "Verified identity"; a favourite is called
//     "Favourite", always beside the honest identity line.
//   - First or changed identity needs an explicit click. Auto-accept is never
//     honoured here: the view prompts, and says why when it refuses to.
//   - "Completed" comes only from the snapshot's `completedAtMs`. Progress
//     arithmetic reaching 100 % proves bytes left this machine, nothing about
//     the remote side.
//   - Retry dispatches a fresh-request event. No row is ever optimistically
//     flipped back to sending.
//   - Bounds are enforced as UI bounds and overflow is stated, never silently
//     dropped: 8 waiting requests, 1024 files per batch, a 120 s consent
//     deadline, 50 history entries and — with history off — terminal states on
//     screen for at most 60 s.

import "./transfers.css";
import { h, svg, clear, dot } from "../views/dom";
import { FeatureStore, throttle, ORDINARY_UPDATE_MS, UNAVAILABLE, formatBytes, formatDuration } from "./contract";
import type { ViewActions, ViewHost } from "./contract";

// ── Data seam ─────────────────────────────────────────────────────────────────

export type TransferState = "waiting" | "sending" | "receiving" | "completed" | "declined" | "cancelled" | "failed";

export interface TransferFile {
  id: string;
  name: string;
  sizeBytes: number;
  transferredBytes: number;
  state: TransferState;
  /** null unless state === "failed" or "declined". Short reason, e.g. "Device offline". */
  reason: string | null;
}

export interface TransferBatch {
  id: string;
  direction: "send" | "receive";
  deviceName: string;
  /** null when not cryptographically verified. */
  verifiedIdentity: string | null;
  favourite: boolean;
  files: TransferFile[];
  bytesPerSecond: number | null; // null when not measurable
  etaSeconds: number | null; // null when not measurable
  /** Only trust this for the completed state — see the contract note above. */
  completedAtMs: number | null;
}

export interface PendingRequest {
  id: string;
  deviceName: string;
  verifiedIdentity: string | null;
  files: Array<{ name: string; sizeBytes: number }>;
  totalBytes: number;
  receivedAtMs: number;
}

export interface TransferSettings {
  deviceName: string;
  /** Default false. */
  receiving: boolean;
  saveLocation: string | null;
  favouriteDevices: string[];
  autoAcceptDevices: string[]; // P2; still requires identity proof per contract
  keepHistory: boolean; // default false
  port: number;
  interfaceName: string | null;
}

export interface TransferDevice {
  id: string;
  name: string;
  deviceType: string;
  favourite: boolean;
  /** Fingerprint native proved. Null means "not verified" — never a guess. */
  verifiedIdentity: string | null;
  online: boolean;
}

export interface TransfersSnapshot {
  devices: TransferDevice[];
  batch: TransferBatch | null;
  pending: PendingRequest[]; // cap 8
  history: TransferBatch[]; // cap 50
  settings: TransferSettings;
  transport: "https" | "plaintext" | null;
}

/**
 * The only seam. The defaults are the contract's defaults: receiving off, no
 * history, history retention off, and no transport claimed until native reports
 * one. Device name and save location stay empty/null rather than being guessed.
 */
export const transfersStore = new FeatureStore<TransfersSnapshot>({
  devices: [],
  batch: null,
  pending: [],
  history: [],
  settings: {
    deviceName: "",
    receiving: false,
    saveLocation: null,
    favouriteDevices: [],
    autoAcceptDevices: [],
    keepHistory: false,
    port: 53317,
    interfaceName: null,
  },
  transport: null,
});

// ── Contract bounds, enforced as UI bounds ────────────────────────────────────

/** handoff.md §8: eight waiting requests. */
export const WAITING_CAP = 8;
/** handoff.md §8: 1024 files in one batch. */
export const FILES_CAP = 1024;
/** handoff.md §8: a consent prompt must be answered within 120 seconds. */
export const CONSENT_DEADLINE_MS = 120_000;
/** handoff.md §8: at most 50 history batches. */
export const HISTORY_CAP = 50;
/** handoff.md §8: at most 50 batches, and those for no more than seven days. */
export const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** handoff.md §8: with history off, terminal states stay on screen ≤60 seconds. */
export const TERMINAL_DISPLAY_MS = 60_000;

// ── Events (all dispatched on the view root, bubbles: true) ───────────────────

/** `transfer-send` — start a batch to a discovered device. detail: deviceId. */
export const TRANSFER_SEND_EVENT = "transfer-send";
/**
 * `transfer-send-text` — one explicit click sends text or a link. No detail: the
 * clipboard belongs to the controller, is read there and never here, and is only
 * ever sent because of this click.
 */
export const TRANSFER_SEND_TEXT_EVENT = "transfer-send-text";
/** `transfer-consent` — answer an incoming request. detail: { id, accept }. */
export const TRANSFER_CONSENT_EVENT = "transfer-consent";
/** `transfer-cancel` — cancel the batch, or one file of it. detail: { batchId, fileId? }. */
export const TRANSFER_CANCEL_EVENT = "transfer-cancel";
/**
 * `transfer-retry` — ask for fresh preparation and fresh consent for one file.
 * detail: { batchId, fileId }. Never a resend, never a reused token.
 */
export const TRANSFER_RETRY_EVENT = "transfer-retry";
/** `transfer-history-clear` — drop the local history. No detail. */
export const TRANSFER_HISTORY_CLEAR_EVENT = "transfer-history-clear";
/** `transfer-settings` — partial settings write. detail: Partial<TransferSettings>. */
export const TRANSFER_SETTINGS_EVENT = "transfer-settings";
/** `transfer-manual-address` — a validated plain address. detail: { address, port }. */
export const TRANSFER_MANUAL_ADDRESS_EVENT = "transfer-manual-address";
/** `transfer-toggle-favourite` — add or remove a UI pin. detail: deviceId. */
export const TRANSFER_TOGGLE_FAVOURITE_EVENT = "transfer-toggle-favourite";

export type TransferSendDetail = string;
export type TransferConsentDetail = { id: string; accept: boolean };
export type TransferCancelDetail = { batchId: string; fileId?: string };
export type TransferRetryDetail = { batchId: string; fileId: string };
export type TransferSettingsDetail = Partial<TransferSettings>;
export type TransferManualAddressDetail = { address: string; port: number };

// ── Formatting ────────────────────────────────────────────────────────────────

const STATE_LABEL: Record<TransferState, string> = {
  waiting: "Waiting for acceptance",
  sending: "Sending",
  receiving: "Receiving",
  completed: "Completed",
  declined: "Declined",
  cancelled: "Cancelled",
  failed: "Failed",
};

const STATE_TONE: Record<TransferState, string> = {
  waiting: "var(--dim)",
  sending: "var(--cyan)",
  receiving: "var(--indigo)",
  completed: "var(--green)",
  declined: "var(--dim-4)",
  cancelled: "var(--dim-4)",
  failed: "var(--red)",
};

const TERMINAL: readonly TransferState[] = ["completed", "declined", "cancelled", "failed"];
const isTerminal = (state: TransferState) => TERMINAL.includes(state);

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const percent = (fraction: number) => `${Math.round(clamp01(fraction) * 100)}%`;
const perSecond = (bytes: number | null) => (bytes === null ? UNAVAILABLE : `${formatBytes(bytes)}/s`);
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

function text(el: HTMLElement, value: string) {
  if (el.textContent !== value) el.textContent = value;
}

/** Display totals only. Never used to decide "completed" — see `batchState`. */
function totals(batch: TransferBatch) {
  let size = 0;
  let moved = 0;
  for (const file of batch.files) {
    size += file.sizeBytes;
    moved += file.transferredBytes;
  }
  return { size, moved, fraction: size > 0 ? clamp01(moved / size) : 0 };
}

/**
 * The batch's own state. `completed` comes from `completedAtMs` alone: a batch
 * whose bytes have all left this machine is still unfinished until native says
 * the remote side is done.
 */
function batchState(batch: TransferBatch): TransferState {
  if (batch.completedAtMs !== null) return "completed";
  if (batch.files.some((f) => f.state === "sending")) return "sending";
  if (batch.files.some((f) => f.state === "receiving")) return "receiving";
  if (batch.files.some((f) => f.state === "failed")) return "failed";
  if (batch.files.some((f) => f.state === "declined")) return "declined";
  if (batch.files.some((f) => f.state === "cancelled")) return "cancelled";
  return "waiting";
}

/**
 * Refines the one ambiguous case so the label never claims more than the
 * snapshot says: every file reported completed, but no `completedAtMs` yet.
 */
function batchStateLabel(batch: TransferBatch): string {
  const state = batchState(batch);
  if (state !== "waiting") return STATE_LABEL[state];
  if (batch.files.length > 0 && batch.files.every((f) => f.state === "completed")) return "Awaiting confirmation from the device";
  return STATE_LABEL.waiting;
}

const directionLine = (batch: TransferBatch) => (batch.direction === "send" ? "Sending to" : "Receiving from");

/** `just now` / `4m 12s ago`. The clock is native's; only the delta is ours. */
function relativeTime(atMs: number, nowMs: number) {
  const elapsed = nowMs - atMs;
  if (elapsed < 1000) return "just now";
  return `${formatDuration(elapsed / 1000)} ago`;
}

/**
 * The only place trust language is decided. A favourite and an unverified device
 * both read "Favourite · Identity not verified"; only a native-proved
 * fingerprint reads "Verified identity". Nothing here turns a pin into trust.
 */
const identityText = (verifiedIdentity: string | null) =>
  verifiedIdentity === null ? "Identity not verified" : `Verified identity · ${verifiedIdentity}`;

const deviceNameOf = (snapshot: TransfersSnapshot, id: string) =>
  snapshot.devices.find((d) => d.id === id)?.name ?? id;

const STAR = "M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z";

function transportNoteText(transport: TransfersSnapshot["transport"]): string {
  if (transport === "https") return "Encrypted transfer (HTTPS) · no plaintext fallback";
  if (transport === "plaintext") return "Refused: the engine reported a plaintext transport. Sending is blocked.";
  return "Refused: no encrypted transport has been reported. Sending is blocked.";
}

// ── Keyed DOM reuse ───────────────────────────────────────────────────────────

interface Row<T> {
  el: HTMLElement;
  update(value: T): void;
}

/**
 * Reuses one element per key, so a background refresh never rebuilds a row the
 * user is focused on or scrolling past. Keys that vanish are removed outright.
 */
function mount<T>(
  parent: HTMLElement,
  retained: Map<string, Row<T>>,
  values: Map<string, T>,
  make: () => Row<T>,
) {
  const keys = [...values.keys()];
  const live = new Set(keys);
  for (const [key, row] of retained) {
    if (live.has(key)) continue;
    row.el.textContent = "";
    row.el.remove();
    retained.delete(key);
  }
  keys.forEach((key, index) => {
    let row = retained.get(key);
    if (!row) {
      row = make();
      retained.set(key, row);
    }
    row.update(values.get(key) as T);
    if (parent.children[index] !== row.el) parent.insertBefore(row.el, parent.children[index] ?? null);
  });
}

/** The common case: one line of text, keyed by an id. */
function textRow(className: string): Row<string> {
  const el = h("div", { class: className, role: "listitem" });
  return { el, update: (value) => text(el, value) };
}

// ── Devices (spec rows 30, 31, 33, 34, 35) ────────────────────────────────────

/** Plain IPv4 or a dotted hostname. A scheme, port, path or bracket is refused. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function validAddress(value: string) {
  if (!value || value.length > 253) return false;
  // No port and no scheme: this field takes a bare address only.
  if (value.includes(":") || value.includes("/")) return false;
  if (/^\d+(\.\d+){3}$/.test(value)) return value.split(".").every((part) => part.length <= 3 && Number(part) <= 255);
  // A dotted number that is not valid IPv4 is a mistyped address, not a host.
  if (/^[0-9.]+$/.test(value)) return false;
  return HOSTNAME.test(value);
}
const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

/**
 * Nearby devices and the send target picker. Discovery itself is native's: this
 * view renders whatever bounded peer list arrives (chosen interfaces, 128 peers)
 * and never sweeps a subnet itself. Favourites are pinned to the top.
 */
export function buildDeviceList(actions: ViewActions): ViewHost {
  const back = h("button", { class: "btn secondary", text: "Back", "aria-label": "Back to overview", onclick: () => actions.setView("overview") });
  const transportNote = h("div", { class: "xfer-transport", role: "status" });
  const list = h("div", { class: "xfer-devices", role: "list", "aria-label": "Nearby devices", tabindex: 0 });
  const empty = h("div", { class: "xfer-empty", text: "No nearby devices yet — discovery covers only the interfaces you chose." });
  const sendText = h("button", {
    class: "btn secondary xfer-send-text",
    type: "button",
    "aria-label": "Send copied text or a link to a device",
    onclick: () => el.dispatchEvent(new CustomEvent(TRANSFER_SEND_TEXT_EVENT, { bubbles: true })),
  }, h("span", { text: "Send text / clipboard" }));

  const address = h("input", {
    type: "text", class: "xfer-input", placeholder: "192.168.1.20",
    "aria-label": "Device IP address or hostname", spellcheck: false, autocomplete: "off",
  }) as HTMLInputElement;
  const port = h("input", {
    type: "number", class: "xfer-input xfer-port", min: "1", max: "65535", step: "1", value: "53317",
    "aria-label": "Device port",
  }) as HTMLInputElement;
  const addressNote = h("div", { class: "xfer-note", role: "status", "aria-live": "polite" });
  const manual = h("form", {
    class: "xfer-manual", novalidate: true,
    onsubmit: (event: Event) => { event.preventDefault(); submitManual(); },
  }, address, port, h("button", { class: "btn secondary", type: "submit", "aria-label": "Send to this address" }, h("span", { text: "Send…" })));

  const el = h("div", { class: "view xfer-devices-view", tabindex: 0, "aria-label": "Nearby devices" },
    h("div", { class: "card" }, h("div", { class: "stack xfer-stack" },
      back,
      transportNote,
      list,
      empty,
      h("div", { class: "xfer-row" }, sendText),
      h("div", { class: "xfer-note", text: "Sends the clipboard contents you chose, once, to the device you then pick." }),
      h("div", { class: "xfer-subtitle", text: "Add by address" }),
      manual,
      addressNote,
    )),
  );
  const rows = new Map<string, Row<TransferDevice>>();

  function deviceRow(): Row<TransferDevice> {
    let device: TransferDevice | null = null;
    const online = dot("var(--dim-5)", 7);
    const name = h("span", { class: "xfer-device-name" });
    const type = h("span", { class: "xfer-device-type" });
    const identity = h("span", { class: "xfer-identity" });
    const favourite = h("button", {
      class: "xfer-star", type: "button", "aria-pressed": "false", "aria-label": "Favourite this device",
      onclick: () => {
        if (device) el.dispatchEvent(new CustomEvent<TransferSendDetail>(TRANSFER_TOGGLE_FAVOURITE_EVENT, { detail: device.id, bubbles: true }));
      },
    });
    const send = h("button", {
      class: "btn secondary xfer-send", type: "button", "aria-label": "Send files",
      onclick: () => {
        if (device) el.dispatchEvent(new CustomEvent<TransferSendDetail>(TRANSFER_SEND_EVENT, { detail: device.id, bubbles: true }));
      },
    }, h("span", { text: "Send…" }));
    const row = h("div", { class: "xfer-device", role: "listitem" },
      online, h("div", { class: "xfer-device-main" }, name, type, identity), favourite, send);

    return {
      el: row,
      update(next) {
        device = next;
        online.style.background = next.online ? "var(--green)" : "var(--dim-5)";
        online.setAttribute("aria-label", next.online ? "Online" : "Offline");
        text(name, next.name);
        text(type, next.deviceType || UNAVAILABLE);
        // A pin and a proved identity are different claims, never one word.
        const verified = next.verifiedIdentity !== null;
        identity.classList.toggle("is-verified", verified);
        const claim = `${next.favourite ? "Favourite · " : ""}${identityText(next.verifiedIdentity)}`;
        text(identity, claim);
        identity.setAttribute("aria-label", `${next.favourite ? "Favourite device, not proof of identity. " : ""}${claim}`);
        favourite.setAttribute("aria-pressed", next.favourite ? "true" : "false");
        favourite.setAttribute("aria-label", next.favourite ? `Remove ${next.name} from favourites` : `Add ${next.name} to favourites`);
        favourite.style.color = next.favourite ? "var(--amber)" : "var(--dim-4)";
        clear(favourite);
        favourite.append(svg(STAR, 13, next.favourite ? {} : { stroke: 1.8 }));
        send.disabled = !next.online;
        send.setAttribute("aria-label", next.online ? `Send files to ${next.name}` : `${next.name} is offline`);
        row.classList.toggle("is-offline", !next.online);
      },
    };
  }

  function submitManual() {
    const host = address.value.trim().toLowerCase();
    const portValue = Number(port.value);
    if (!validAddress(host)) {
      text(addressNote, "Enter a plain IPv4 address or hostname — no scheme, port or path.");
      address.focus();
      return;
    }
    if (!validPort(portValue)) {
      text(addressNote, "The port must be a whole number from 1 to 65535.");
      port.focus();
      return;
    }
    text(addressNote, "");
    const detail: TransferManualAddressDetail = { address: host, port: portValue };
    el.dispatchEvent(new CustomEvent<TransferManualAddressDetail>(TRANSFER_MANUAL_ADDRESS_EVENT, { detail, bubbles: true }));
  }

  address.addEventListener("input", () => text(addressNote, ""));
  port.addEventListener("input", () => text(addressNote, ""));
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); actions.setView("overview"); }
  });

  const paint = throttle(render);
  transfersStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));

  function render() {
    const snapshot = transfersStore.get();
    const transport = snapshot.transport === "https";
    text(transportNote, transportNoteText(snapshot.transport));
    transportNote.classList.toggle("is-refused", !transport);
    // Favourites first, discovery order otherwise; Array#sort is stable.
    const devices = [...snapshot.devices].sort((a, b) => Number(b.favourite) - Number(a.favourite));
    mount(list, rows, new Map(devices.map((d) => [d.id, d])), deviceRow);
    empty.hidden = devices.length > 0;
  }

  render();
  return { el, sync: paint.ordinary, focus: () => back.focus() };
}

// ── Incoming consent (spec row 36 — the highest-priority view in the app) ──────

/**
 * One incoming request, answerable for 120 seconds. This view never auto-accepts
 * anything, whatever the settings say: auto-accept needs identity proof and the
 * proof is native's to establish. When identity is missing or has changed, the
 * prompt says so plainly and the user decides.
 *
 * No PIN, token, transfer URL or diagnostic ever reaches this DOM.
 * `PendingRequest` has no field for one, by design — a secret that is not in the
 * snapshot cannot be logged from here, so there is nothing to mask. If a reveal
 * toggle is ever added it must swap textContent on a click, never render the
 * secret into an attribute or a class.
 */
export function buildTransferConsent(actions: ViewActions): ViewHost {
  const heading = h("h2", { class: "title", id: "xfer-consent-heading", text: "Incoming file transfer" });
  const refusal = h("div", { class: "xfer-refusal", role: "alert", hidden: true });
  const refusalLine = h("p", { class: "xfer-refusal-line" });
  refusal.append(refusalLine, h("p", { class: "xfer-note", text: "This build sends over HTTPS only. There is no plaintext or browser-download fallback, and no way to override that from the island." }));

  const sender = h("div", { class: "xfer-consent-sender" });
  const identity = h("div", { class: "xfer-identity" });
  const autoNote = h("div", { class: "xfer-note" });
  const files = h("div", { class: "xfer-consent-files", role: "list", "aria-label": "Files offered" });
  const filesEmpty = h("div", { class: "xfer-note", text: "No files listed." });
  const filesOverflow = h("div", { class: "xfer-note xfer-overflow" });
  const total = h("div", { class: "sub" });
  const waiting = h("div", { class: "xfer-waiting", role: "list", "aria-label": "Other waiting requests" });
  const waitingOverflow = h("div", { class: "xfer-note xfer-overflow" });
  const countdown = h("div", { class: "xfer-countdown", role: "timer" });
  const expiryNote = h("div", { class: "xfer-note" });
  const body = h("div", { class: "xfer-consent-body" }, sender, identity, autoNote, files, filesEmpty, filesOverflow, total, waiting, waitingOverflow, countdown, expiryNote);

  const accept = h("button", {
    class: "btn primary", type: "button", "aria-label": "Accept these files",
    onclick: () => decide(true),
  }, h("span", { text: "Accept" }));
  const decline = h("button", {
    class: "btn secondary", type: "button", "aria-label": "Decline this request",
    onclick: () => decide(false),
  }, h("span", { text: "Decline" }));

  const el = h("div", {
    class: "view xfer-consent", tabindex: -1, role: "alertdialog", "aria-modal": "true",
    "aria-labelledby": "xfer-consent-heading", "aria-describedby": "xfer-consent-detail",
  }, h("div", { class: "card" }, h("div", { class: "stack xfer-stack" },
    heading, refusal, body, h("div", { class: "xfer-consent-actions" }, accept, decline),
  )));
  body.setAttribute("id", "xfer-consent-detail");

  const fileRows = new Map<string, Row<string>>();
  const waitingRows = new Map<string, Row<string>>();

  // The deadline is anchored per request on the monotonic clock, so a wall-clock
  // jump cannot hand the user extra time. The arrival instant is converted from
  // the snapshot exactly once, when the request is first seen.
  const anchors = new Map<string, number>();
  function remainingMs(request: PendingRequest): number {
    let anchor = anchors.get(request.id);
    if (anchor === undefined) {
      anchor = performance.now() - Math.max(0, Date.now() - request.receivedAtMs);
      anchors.set(request.id, anchor);
    }
    return CONSENT_DEADLINE_MS - (performance.now() - anchor);
  }
  const currentRequest = () => transfersStore.get().pending[0] ?? null;

  function decide(acceptIt: boolean) {
    const request = currentRequest();
    if (!request) return;
    // A refusal or a passed deadline removes the accept path entirely, here and
    // in render() — there is no code path that sends anyway.
    if (acceptIt && (remainingMs(request) <= 0 || transfersStore.get().transport !== "https")) return;
    const detail: TransferConsentDetail = { id: request.id, accept: acceptIt };
    el.dispatchEvent(new CustomEvent<TransferConsentDetail>(TRANSFER_CONSENT_EVENT, { detail, bubbles: true }));
  }

  function renderCountdown() {
    const request = currentRequest();
    if (!request || transfersStore.get().transport !== "https") {
      text(countdown, "");
      accept.disabled = true;
      return;
    }
    const left = remainingMs(request);
    if (left <= 0) {
      text(countdown, "Expired");
      accept.disabled = true;
      return;
    }
    accept.disabled = false;
    const seconds = Math.ceil(left / 1000);
    text(countdown, seconds <= 1 ? "Answer in the last second" : `Answer within ${formatDuration(seconds)}`);
  }

  const paint = throttle(render);
  transfersStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  el.addEventListener("keydown", (event) => {
    // Escape is the safe direction: it declines. Accept always takes a click.
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); decide(false); actions.setView("overview"); }
  });

  function render() {
    const snapshot = transfersStore.get();
    const request = currentRequest();
    for (const id of [...anchors.keys()]) if (!snapshot.pending.some((p) => p.id === id)) anchors.delete(id);

    const https = snapshot.transport === "https";
    refusal.hidden = https;
    body.hidden = !https;
    text(refusalLine, transportNoteText(snapshot.transport));

    text(heading, request ? "Incoming file transfer" : "No incoming request");
    text(autoNote, autoAcceptNote(snapshot, request));
    text(total, request ? formatBytes(request.totalBytes) : "");

    if (request) {
      // The attacker-controlled name lands here, once, as textContent.
      text(sender, `${request.deviceName} wants to send ${plural(request.files.length, "file")}`);
      const verified = request.verifiedIdentity !== null;
      identity.classList.toggle("is-verified", verified);
      const claim = identityText(request.verifiedIdentity);
      text(identity, claim);
      identity.setAttribute("aria-label", verified ? claim : "This sender is not verified. Accepting is your decision.");

      // The waiting queue is bounded at eight, with any overflow stated.
      const shown = request.files.slice(0, FILES_CAP);
      mount(files, fileRows, new Map(shown.map((file, index) => [`${request.id}:${index}`, `${file.name} · ${formatBytes(file.sizeBytes)}`])), () => textRow("xfer-consent-file"));
      filesEmpty.hidden = shown.length > 0;
      const fileOverflow = request.files.length - shown.length;
      text(filesOverflow, fileOverflow > 0 ? `and ${plural(fileOverflow, "more file")} not shown` : "");

      const rest = snapshot.pending.slice(1, 1 + WAITING_CAP);
      mount(waiting, waitingRows, new Map(rest.map((p) => [p.id, `${p.deviceName} · ${plural(p.files.length, "file")} · ${formatBytes(p.totalBytes)}`])), () => textRow("xfer-waiting-row"));
      const waitingHidden = snapshot.pending.length - 1 - rest.length;
      text(waitingOverflow, waitingHidden > 0 ? `and ${plural(waitingHidden, "more request")} waiting` : "");
      text(expiryNote, remainingMs(request) <= 0 ? "This request expired and can no longer be accepted." : "");
    } else {
      text(sender, "");
      identity.classList.remove("is-verified");
      text(identity, "");
      clear(files);
      clear(waiting);
      filesEmpty.hidden = false;
      text(filesOverflow, "");
      text(waitingOverflow, "");
      text(expiryNote, "");
    }

    accept.disabled = !request || !https || remainingMs(request) <= 0;
    decline.disabled = !request;
    renderCountdown();
  }

  let lastTick = 0;
  render();
  return {
    el,
    sync: paint.ordinary,
    focus: () => (accept.disabled ? el.focus() : accept.focus()),
    // The countdown is the only thing here that moves without a snapshot.
    tick(now) {
      if (now - lastTick < ORDINARY_UPDATE_MS) return;
      lastTick = now;
      renderCountdown();
    },
  };
}

function autoAcceptNote(snapshot: TransfersSnapshot, request: PendingRequest | null): string {
  if (!request) return "";
  // The settings lists hold device ids; a request only carries a name, so the
  // bridge is the discovered device that owns that id.
  const listed = snapshot.settings.autoAcceptDevices.some((id) =>
    snapshot.devices.some((d) => d.id === id && d.name === request.deviceName));
  if (!listed) return "";
  if (request.verifiedIdentity === null) {
    return "Auto-accept is listed for this device but was not applied: it needs a verified identity, and accepting is your decision.";
  }
  return "Auto-accept is listed for this device, but this request still needs your confirmation.";
}

// ── Detailed progress (spec rows 41, 42, 43, 45, 46) ───────────────────────────

interface FileRow extends Row<TransferFile> {
  update(file: TransferFile): void;
}

function makeFileRow(cancel: (fileId: string) => void, retry: (fileId: string) => void): FileRow {
  let file: TransferFile | null = null;
  const name = h("span", { class: "xfer-file-name" });
  const state = h("span", { class: "xfer-file-state" });
  const fill = h("i", { class: "xfer-fill" });
  const bar = h("div", {
    class: "xfer-bar", role: "progressbar",
    "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0", "aria-label": "File progress",
  }, fill);
  const sizes = h("span", {});
  const pct = h("span", { class: "xfer-pct" });
  const reason = h("span", { class: "xfer-reason" });
  // Cancel and Retry are per row (spec rows 45 and 46). Retry only ever asks for
  // fresh preparation; the row itself does not move until native reports it.
  const cancelButton = h("button", {
    class: "btn secondary xfer-row-btn", type: "button", "aria-label": "Cancel this file",
    onclick: () => { if (file) cancel(file.id); },
  }, h("span", { text: "Cancel" }));
  const retryButton = h("button", {
    class: "btn secondary xfer-row-btn", type: "button", "aria-label": "Retry this file",
    onclick: () => { if (file) retry(file.id); },
  }, h("span", { text: "Retry" }));
  const el = h("div", { class: "xfer-file" },
    h("div", { class: "xfer-file-head" }, name, state),
    bar,
    h("div", { class: "xfer-file-meta" }, sizes, pct, reason, h("div", { class: "xfer-row-buttons" }, cancelButton, retryButton)),
  );

  return {
    el,
    update(next) {
      file = next;
      text(name, next.name);
      text(state, STATE_LABEL[next.state]);
      state.style.color = STATE_TONE[next.state];
      const fraction = next.sizeBytes > 0 ? clamp01(next.transferredBytes / next.sizeBytes) : 0;
      fill.style.width = percent(fraction);
      el.style.setProperty("--tone", STATE_TONE[next.state]);
      bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
      bar.setAttribute("aria-label", `${next.name} ${percent(fraction)}`);
      text(sizes, `${formatBytes(next.transferredBytes)} / ${formatBytes(next.sizeBytes)}`);
      text(pct, percent(fraction));
      text(reason, next.reason ?? "");
      const done = isTerminal(next.state);
      cancelButton.hidden = done;
      retryButton.hidden = next.state !== "failed";
      el.classList.toggle("is-terminal", done);
    },
  };
}

/** File name, determinate bar, transferred/total, percent; speed and ETA, queue. */
export function buildTransferProgress(actions: ViewActions): ViewHost {
  const back = h("button", { class: "btn secondary", text: "Back", "aria-label": "Back to overview", onclick: () => actions.setView("overview") });
  const summary = h("div", { class: "xfer-summary", role: "status", "aria-live": "polite" });
  const metrics = h("div", { class: "xfer-metrics" });
  const trust = h("div", { class: "xfer-identity" });
  const list = h("div", { class: "xfer-files", role: "list", "aria-label": "Files in this transfer", tabindex: 0 });
  const overflow = h("div", { class: "xfer-note xfer-overflow" });
  const empty = h("div", { class: "xfer-empty", text: "Nothing is sending or receiving. One batch is active at a time." });
  const el = h("div", { class: "view xfer-progress", tabindex: 0, "aria-label": "Transfer progress" },
    h("div", { class: "card" }, h("div", { class: "stack xfer-stack" }, back, summary, metrics, trust, list, overflow, empty)),
  );
  const rows = new Map<string, FileRow>();
  let renderedBatchId = "";

  function cancel(fileId: string) {
    const batch = transfersStore.get().batch;
    if (!batch) return;
    const detail: TransferCancelDetail = { batchId: batch.id, fileId };
    el.dispatchEvent(new CustomEvent<TransferCancelDetail>(TRANSFER_CANCEL_EVENT, { detail, bubbles: true }));
  }
  function retry(fileId: string) {
    const batch = transfersStore.get().batch;
    if (!batch) return;
    // Fresh preparation and fresh consent — never a resend, never a reused
    // token. Nothing about this row changes until native reports it.
    const detail: TransferRetryDetail = { batchId: batch.id, fileId };
    el.dispatchEvent(new CustomEvent<TransferRetryDetail>(TRANSFER_RETRY_EVENT, { detail, bubbles: true }));
  }

  const paint = throttle(render);
  transfersStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); actions.setView("overview"); }
  });

  function render() {
    const batch = transfersStore.get().batch;
    empty.hidden = batch !== null;
    overflow.textContent = "";
    if (!batch) {
      if (renderedBatchId !== "") { rows.clear(); renderedBatchId = ""; }
      text(summary, "No active transfer");
      text(metrics, "One batch is active at a time.");
      text(trust, "");
      clear(list);
      return;
    }
    if (batch.id !== renderedBatchId) { rows.clear(); renderedBatchId = batch.id; }

    const sum = totals(batch);
    text(summary, `${directionLine(batch)} ${batch.deviceName} · ${percent(sum.fraction)} · ${batchStateLabel(batch)}`);
    text(metrics, `${formatBytes(sum.moved)} / ${formatBytes(sum.size)} · ${plural(batch.files.length, "file")} · Speed ${perSecond(batch.bytesPerSecond)} · Remaining ${batch.etaSeconds === null ? UNAVAILABLE : formatDuration(batch.etaSeconds)}`);
    const verified = batch.verifiedIdentity !== null;
    trust.classList.toggle("is-verified", verified);
    text(trust, `${batch.favourite ? "Favourite · " : ""}${identityText(batch.verifiedIdentity)}`);

    // The queue renders 1024 rows and states the rest: no silent truncation.
    const shown = batch.files.slice(0, FILES_CAP);
    mount(list, rows, new Map(shown.map((f) => [f.id, f])), () => makeFileRow(cancel, retry));
    const hidden = batch.files.length - shown.length;
    text(overflow, hidden > 0 ? `and ${plural(hidden, "more file")} in this batch not shown` : "");
  }

  render();
  return { el, sync: paint.ordinary, focus: () => back.focus() };
}

// ── History (spec row 48) ─────────────────────────────────────────────────────

/** Newest first, bounded, and never a grant of any filesystem read. */
export function buildTransferHistory(actions: ViewActions): ViewHost {
  const back = h("button", { class: "btn secondary", text: "Back", "aria-label": "Back to overview", onclick: () => actions.setView("overview") });
  const clearButton = h("button", {
    class: "btn secondary", type: "button", "aria-label": "Clear transfer history",
    onclick: () => el.dispatchEvent(new CustomEvent(TRANSFER_HISTORY_CLEAR_EVENT, { bubbles: true })),
  }, h("span", { text: "Clear history" }));
  const note = h("div", { class: "xfer-note", role: "status", "aria-live": "polite" });
  const list = h("div", { class: "xfer-history", role: "list", "aria-label": "Transfer history", tabindex: 0 });
  const empty = h("div", { class: "xfer-empty", text: "Nothing to show." });
  const overflow = h("div", { class: "xfer-note xfer-overflow" });
  const el = h("div", { class: "view xfer-history-view", tabindex: 0, "aria-label": "Transfer history" },
    h("div", { class: "card" }, h("div", { class: "stack xfer-stack" }, back, note, list, empty, overflow, h("div", { class: "xfer-row" }, clearButton))),
  );
  const rows = new Map<string, Row<string>>();

  const paint = throttle(render);
  transfersStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); actions.setView("overview"); }
  });

  function render() {
    const snapshot = transfersStore.get();
    const now = Date.now();
    const keepHistory = snapshot.settings.keepHistory;

    // Seven days is the retention ceiling even with history on.
    const retainedByAge = snapshot.history.filter((b) => b.completedAtMs !== null && now - b.completedAtMs <= HISTORY_MAX_AGE_MS);
    // With history off a terminal state is on screen for at most 60 s; the batch
    // stays native's business, we just stop showing it.
    const eligible = retainedByAge.filter((b) => keepHistory || now - (b.completedAtMs ?? now) <= TERMINAL_DISPLAY_MS);
    const values = new Map<string, string>();
    eligible.slice(0, HISTORY_CAP).forEach((batch) => {
      const when = batch.completedAtMs ?? now;
      values.set(batch.id, [
        batch.direction === "send" ? "Sent to" : "Received from",
        batch.deviceName,
        plural(batch.files.length, "file"),
        formatBytes(totals(batch).size),
        relativeTime(when, now),
        batchStateLabel(batch),
        batch.favourite ? "Favourite" : null,
        batch.verifiedIdentity === null ? "Identity not verified" : null,
      ].filter(Boolean).join(" · "));
    });

    text(note, values.size
      ? `${plural(values.size, "transfer")} · newest first`
      : keepHistory ? "History is on. Finished transfers appear here." : "History is off. Terminal states show here for at most 60 seconds.");
    mount(list, rows, values, () => textRow("xfer-history-row"));
    empty.hidden = values.size > 0;
    // Either past the fifty-batch cap or past the 60 s window with history off.
    const dropped = retainedByAge.length - values.size;
    text(overflow, dropped > 0 ? `${plural(dropped, "earlier transfer")} no longer shown` : "");
  }

  render();
  return { el, sync: paint.ordinary, focus: () => back.focus() };
}

// ── Settings (spec row 53, section 6.5) ───────────────────────────────────────

/**
 * Every field dispatches and writes nothing. Native echoes the saved value back
 * into the store, and only then does this view show it — so a refused write
 * cannot leave the UI claiming something that did not happen.
 */
export function buildTransferSettings(actions: ViewActions): ViewHost {
  const back = h("button", { class: "btn secondary", text: "Back", "aria-label": "Back to overview", onclick: () => actions.setView("overview") });
  const name = h("input", { type: "text", class: "xfer-input", "aria-label": "Device name other devices see", spellcheck: false, autocomplete: "off" }) as HTMLInputElement;
  const receiving = h("input", { type: "checkbox", class: "xfer-toggle", "aria-label": "Receive mode" }) as HTMLInputElement;
  const saveLocation = h("input", { type: "text", class: "xfer-input", placeholder: "Ask each time", "aria-label": "Save location for received files", spellcheck: false, autocomplete: "off" }) as HTMLInputElement;
  const favourites = h("div", { class: "xfer-chips", role: "list", "aria-label": "Favourite devices" });
  const favouritesNote = h("div", { class: "xfer-note", text: "A favourite pins a device in the list. It is not proof of identity — favourites are added from the device list." });
  const autoSelect = h("select", { class: "xfer-select", "aria-label": "Device to add to auto-accept" }) as HTMLSelectElement;
  const autoAdd = h("button", { class: "btn secondary", type: "button", "aria-label": "Add device to auto-accept", onclick: () => addAutoAccept() }, h("span", { text: "Add" }));
  const autoAccept = h("div", { class: "xfer-chips", role: "list", "aria-label": "Auto-accept devices" });
  const history = h("input", { type: "checkbox", class: "xfer-toggle", "aria-label": "Keep history" }) as HTMLInputElement;
  const portInput = h("input", { type: "number", class: "xfer-input xfer-port", min: "1", max: "65535", step: "1", "aria-label": "Transfer port" }) as HTMLInputElement;
  const interfaceInput = h("input", { type: "text", class: "xfer-input", placeholder: "All chosen interfaces", "aria-label": "Network interface for discovery", spellcheck: false, autocomplete: "off" }) as HTMLInputElement;
  // Validation messages live apart from the receive-mode hint so an ordinary
  // re-render cannot wipe the reason a write was refused.
  const warning = h("div", { class: "xfer-warning", role: "status", "aria-live": "polite" });
  const note = h("div", { class: "xfer-note" });

  const el = h("div", { class: "view xfer-settings", tabindex: 0, "aria-label": "LocalSend settings" },
    h("div", { class: "card" }, h("div", { class: "stack xfer-stack" },
      back,
      field("Device name", name),
      toggle(receiving, "Receive mode", "Off by default. Off means this device is not discoverable and asks for nothing."),
      field("Save location", saveLocation,
        h("button", { class: "btn secondary", type: "button", "aria-label": "Clear save location", onclick: () => write({ saveLocation: null }) }, h("span", { text: "Clear" }))),
      h("div", { class: "xfer-subtitle", text: "Favourites" }),
      favouritesNote,
      favourites,
      h("div", { class: "xfer-subtitle", text: "Auto-accept" }),
      h("div", { class: "xfer-note", text: "Auto-accept still needs a verified identity. An unverified device always prompts, and a changed identity prompts again." }),
      h("div", { class: "xfer-row" }, autoSelect, autoAdd),
      autoAccept,
      toggle(history, "Keep history", "Off by default. With history off, terminal states display for at most 60 seconds."),
      field("Port", portInput),
      field("Interface", interfaceInput,
        h("button", { class: "btn secondary", type: "button", "aria-label": "Clear interface filter", onclick: () => write({ interfaceName: null }) }, h("span", { text: "Clear" }))),
      warning,
      note,
    )),
  );
  const favouriteRows = new Map<string, Row<string>>();
  const autoRows = new Map<string, Row<string>>();
  const options = new Map<string, HTMLOptionElement>();

  function field(label: string, input: Node, ...extra: Node[]) {
    return h("label", { class: "xfer-field" },
      h("span", { class: "xfer-field-label", text: label }), h("div", { class: "xfer-field-row" }, input, ...extra));
  }
  function toggle(input: HTMLElement, label: string, help: string) {
    return h("div", { class: "xfer-field" },
      h("span", { class: "xfer-field-label", text: label }), input, h("div", { class: "xfer-note", text: help }));
  }
  function write(detail: TransferSettingsDetail) {
    el.dispatchEvent(new CustomEvent<TransferSettingsDetail>(TRANSFER_SETTINGS_EVENT, { detail, bubbles: true }));
  }
  function addAutoAccept() {
    const id = autoSelect.value;
    if (!id) return;
    const current = transfersStore.get().settings.autoAcceptDevices;
    if (!current.includes(id)) write({ autoAcceptDevices: [...current, id] });
  }
  function chipRow(key: "favouriteDevices" | "autoAcceptDevices"): Row<string> {
    let id = "";
    const label = h("span", { class: "xfer-chip-name" });
    const remove = h("button", {
      class: "btn secondary xfer-chip-remove", type: "button", "aria-label": "Remove device",
      onclick: () => {
        const current = transfersStore.get().settings[key];
        if (!current.includes(id)) return;
        write({ [key]: current.filter((value) => value !== id) } as TransferSettingsDetail);
      },
    }, h("span", { text: "Remove" }));
    return {
      el: h("div", { class: "xfer-chip", role: "listitem" }, label, remove),
      update(next) {
        id = next;
        const deviceName = deviceNameOf(transfersStore.get(), next);
        text(label, deviceName);
        remove.setAttribute("aria-label", `Remove ${deviceName}`);
      },
    };
  }
  /** While the user is typing, the field is theirs; native's echo wins on blur. */
  function fieldValue(input: HTMLInputElement, value: string) {
    if (document.activeElement !== input && input.value !== value) input.value = value;
  }

  name.addEventListener("change", () => {
    const value = name.value.trim();
    text(warning, value ? "" : "The device name cannot be empty.");
    if (value) write({ deviceName: value });
  });
  receiving.addEventListener("change", () => write({ receiving: receiving.checked }));
  history.addEventListener("change", () => write({ keepHistory: history.checked }));
  saveLocation.addEventListener("change", () => write({ saveLocation: saveLocation.value.trim() || null }));
  interfaceInput.addEventListener("change", () => write({ interfaceName: interfaceInput.value.trim() || null }));
  portInput.addEventListener("change", () => {
    const value = Number(portInput.value);
    text(warning, validPort(value) ? "" : "The port must be a whole number from 1 to 65535.");
    if (validPort(value)) write({ port: value });
  });
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); actions.setView("overview"); }
  });

  const paint = throttle(render);
  transfersStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));

  function render() {
    const snapshot = transfersStore.get();
    const settings = snapshot.settings;
    fieldValue(name, settings.deviceName);
    fieldValue(saveLocation, settings.saveLocation ?? "");
    fieldValue(portInput, String(settings.port));
    fieldValue(interfaceInput, settings.interfaceName ?? "");
    receiving.checked = settings.receiving;
    receiving.setAttribute("aria-label", settings.receiving ? "Turn receive mode off" : "Turn receive mode on");
    history.checked = settings.keepHistory;
    history.setAttribute("aria-label", settings.keepHistory ? "Keep transfer history off" : "Keep transfer history on");

    mount(favourites, favouriteRows, new Map(settings.favouriteDevices.map((id) => [id, id])), () => chipRow("favouriteDevices"));
    mount(autoAccept, autoRows, new Map(settings.autoAcceptDevices.map((id) => [id, id])), () => chipRow("autoAcceptDevices"));

    const listed = new Set(settings.autoAcceptDevices);
    const addable = snapshot.devices.filter((d) => !listed.has(d.id));
    const wanted = new Set(addable.map((d) => d.id));
    for (const [id, option] of options) {
      if (wanted.has(id)) continue;
      option.remove();
      options.delete(id);
    }
    for (const device of addable) {
      let option = options.get(device.id);
      if (!option) {
        option = h("option", { value: device.id, text: `${device.name} · ${identityText(device.verifiedIdentity)}` });
        autoSelect.append(option);
        options.set(device.id, option);
      }
    }
    autoSelect.disabled = !addable.length;
    if (!addable.some((d) => d.id === autoSelect.value)) autoSelect.value = addable[0]?.id ?? "";
    text(note, settings.receiving ? "" : "Receive mode is off: this device is not discoverable.");
  }

  render();
  return { el, sync: paint.ordinary, focus: () => back.focus() };
}

// ── Compact-island indicator (spec row 41) ─────────────────────────────────────

/**
 * A progress ring for the 288×32 compact island. Static SVG repainted from the
 * store (≤4 Hz), never from a frame loop, and holding no animation while there
 * is no active batch.
 */
export function buildTransferIndicator(): { el: HTMLElement; sync: () => void } {
  const ns = "http://www.w3.org/2000/svg";
  const circumference = 2 * Math.PI * 9;
  const arc = document.createElementNS(ns, "circle");
  const track = document.createElementNS(ns, "circle");
  for (const circle of [track, arc]) {
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "9");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke-width", "2.6");
  }
  track.setAttribute("stroke", "rgba(255, 255, 255, 0.16)");
  arc.setAttribute("stroke", "var(--dim-5)");
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", String(circumference));
  arc.setAttribute("stroke-dashoffset", String(circumference));
  const ring = document.createElementNS(ns, "svg");
  ring.setAttribute("viewBox", "0 0 24 24");
  ring.setAttribute("width", "18");
  ring.setAttribute("height", "18");
  ring.setAttribute("aria-hidden", "true");
  ring.append(track, arc);

  const label = h("span", { class: "xfer-indicator-label" });
  const pct = h("span", { class: "xfer-indicator-pct" });
  const el = h("div", { class: "xfer-indicator", role: "status", "aria-live": "polite" }, ring, label, pct);

  const paint = throttle(() => {
    const batch = transfersStore.get().batch;
    if (!batch) {
      el.classList.remove("is-active");
      arc.setAttribute("stroke-dashoffset", String(circumference));
      arc.setAttribute("stroke", "var(--dim-5)");
      text(label, "No transfer");
      text(pct, "");
      el.setAttribute("aria-label", "No active transfer");
      return;
    }
    const sum = totals(batch);
    const state = batchState(batch);
    // The class is what carries the transition, so an idle ring is static.
    el.classList.add("is-active");
    arc.setAttribute("stroke-dashoffset", String(circumference * (1 - sum.fraction)));
    arc.setAttribute("stroke", state === "failed" ? "var(--red)" : batch.direction === "send" ? "var(--cyan)" : "var(--indigo)");
    text(label, state === "completed"
      ? batch.direction === "send" ? `Sent to ${batch.deviceName}` : `Received from ${batch.deviceName}`
      : `${directionLine(batch)} ${batch.deviceName}`);
    text(pct, percent(sum.fraction));
    el.setAttribute("aria-label", `${batchStateLabel(batch)} ${percent(sum.fraction)} — ${batch.deviceName}`);
  });
  transfersStore.subscribe((urgent) => (urgent ? paint.urgent() : paint.ordinary()));
  paint.urgent();
  return { el, sync: paint.ordinary };
}