// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop, onEvent } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { buildMediaIndicator } from "../features/media";
import { buildSystemIndicator } from "../features/system";
import { buildShelfIndicator } from "../features/shelf";
import { buildTransferIndicator } from "../features/transfers";
import { transfersStore } from "../features/transfers";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;
  /** Compact-island live chips that expand into the feature views. */
  private statusRail!: HTMLElement;
  private railSyncs: Array<() => void> = [];

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private collapseGeneration = 0;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private lastPaused = State.paused;
  private lastScreen = State.settings.screen;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private botHoverGeneration = 0;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;
  private inspectorHovered = false;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /** Only one native worker and one replaceable latest selection are retained. */
  private copyingId: string | null = null;
  private copyCancellation: Promise<void | null> | null = null;
  private queuedCopy: { id: string; path: string } | null = null;
  private preparationRecovery: number | null = null;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      if (State.paused !== this.lastPaused) {
        this.lastPaused = State.paused;
        this.cancelInputTimers();
        if (State.paused) {
          this.clearPreparation();
          this.fsm.forceHidden();
        }
      }
      this.syncInspectorHold();
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      openTerminal: () => {
        if (State.focusTask?.monitorOwned) return;
        const cwd = State.focusTask?.sessionCwd ?? null;
        void Bridge.openInVSCode(cwd);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === "integration_claude") void Bridge.openInVSCode(task.sessionCwd ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        State.pendingApproval = null;
        State.isPinned = false;
        this.fsm.pinned = false;
        State.updateTask("integration_claude", "working");
        State.setPillBadge("integration_claude", null);
        this.setView(State.defaultView());
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip", tabindex: 0, role: "button", "aria-label": "Open Coucou" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.statusRail = this.buildStatusRail();

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        if (!State.droppedFile || State.pendingApproval) return;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island", tabindex: 0, role: "region", "aria-label": "Coucou" },
      this.clipEl,
      this.statusRail,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  /**
   * Compact-island live chips. Each one holds a feature's own indicator and
   * expands into that feature's view when clicked, so the new features get a
   * navigation entry point without touching the header or the overview — both of
   * which ship as-is and must not be restyled.
   *
   * An incoming transfer consent request outranks the rail: it takes the island
   * over on its own, because a declined-by-timeout request is unrecoverable.
   */
  private buildStatusRail(): HTMLElement {
    const rail = h("div", { id: "status-rail" });
    this.railSyncs = [];

    const chip = (
      view: IslandViewName,
      label: string,
      build: () => { el: HTMLElement; sync: () => void },
    ) => {
      const indicator = build();
      this.railSyncs.push(indicator.sync);
      const button = h(
        "button",
        {
          class: "rail-chip",
          type: "button",
          title: label,
          "aria-label": label,
          onclick: () => this.setView(view),
        },
        indicator.el,
      );
      rail.append(button);
      return button;
    };

    chip("transferProgress", "Transfers", buildTransferIndicator);
    chip("nowPlaying", "Now playing", buildMediaIndicator);
    chip("systemStatus", "System status", buildSystemIndicator);
    chip("shelf", "Shelf", buildShelfIndicator);

    transfersStore.subscribe((urgent) => {
      if (urgent) this.syncStatusRail();
    });
    return rail;
  }

  private syncStatusRail() {
    for (const sync of this.railSyncs) sync();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────
  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.hoverOpenDelayMs = State.settings.hoverOpenDelayMs;
    this.fsm.onTransition = (from, to) => {
      if (from === "coucou") this.greeting.interrupt();
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          break;
        case "home":
          this.expand(State.defaultView());
          break;
        case "coucou":
          if (this.reducedMotion.matches) {
            this.expand(State.defaultView());
            this.fsm.greetComplete();
          } else {
            this.expand("greeting");
            this.greeting.start();
          }
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      this.clearPreparation();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    const item = State.filePreparation.current;
    if (view === "prompt" && State.droppedFile) {
      State.promptContext = { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path };
      UploadSeq.deactivate();
      this.uploadCanvas.clear();
    } else if (!UPLOAD_VIEWS.has(view)) {
      if (view === "note" && item?.state === "failed") UploadSeq.deactivate();
      else if (item || UploadSeq.isActive) this.clearPreparation();
    }
  }

  expand(view: IslandViewName) {
    if (State.pendingApproval && State.view === "approval" && view !== "approval") return;
    if (view === "prompt" && State.filePreparation.current?.state === "preparing") return;
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName, keepPreparation = false) {
    if (State.pendingApproval && State.view === "approval" && view !== "approval") return;
    if (view === "prompt" && State.filePreparation.current?.state === "preparing") return;
    if (keepPreparation) {
      UploadSeq.deactivate();
      this.uploadCanvas.clear();
    } else this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    this.fsm.forceHome();
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    if (State.isPinned || State.pendingApproval) return;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned || State.pendingApproval !== null;
    if (State.pendingApproval && view !== "approval") return;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = State.isPinned || State.pendingApproval !== null;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    // Approval owns the visible request, including the original swallow path.
    if (State.pendingApproval) { State.fileDragOver = false; State.notify(); return; }
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        // Preview is not a selection: keep the existing owner, view and actions.
        // In particular, do not enter the alert/default-view navigation path.
        if (State.filePreparation.current || State.view === "prompt") {
          State.notify();
          return;
        }
        this.fsm.forceHome();
        this.engine.animateMorph(1);
        // Open the FSM first; its default-view transition must not discard the
        // sequence. The drop view then owns the existing follow springs.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const paths = e.paths ?? [];
        if (paths.length !== 1 || !paths[0]) {
          this.engine.animateMorph(0);
          if (paths.length > 1) {
            State.noteMessage = "Drop one file at a time.";
            // Rejection can display a note, but cannot evict an accepted file.
            this.setView("note", true);
          } else {
            UploadSeq.exitZone();
            State.notify();
          }
          return;
        }
        this.swallow(paths[0]);
        break;
      }
    }
  }

  /**
   * Gulp is decorative. Only a current native preparation receipt exposes a file.
   */
  private swallow(path: string) {
    if (State.paused || State.pendingApproval) return;
    const following = UploadSeq.isActive && !UploadSeq.dropped;
    this.clearPreparation(following);
    this.fsm.forceHome();
    if (!UploadSeq.isActive) UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
    const id = crypto.randomUUID();
    const name = path.split(/[\\/]/).pop() || "file";
    State.filePreparation.begin(id, name);
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop();
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("gulp");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    this.queuedCopy = { id, path };
    void this.prepareNext();
  }

  /** Revoke display ownership synchronously, then signal native cancellation. */
  clearPreparation(keepFollow = false) {
    const item = State.filePreparation.current;
    State.filePreparation.clear();
    this.queuedCopy = null;
    if (this.preparationRecovery != null) window.clearTimeout(this.preparationRecovery);
    this.preparationRecovery = null;
    if (item?.state === "preparing") {
      const cancellation = Bridge.cancelFileCopy(item.id).catch(() => null);
      if (this.copyingId === item.id) this.copyCancellation = cancellation;
    }
    if (item || State.promptContext?.kind === "file") {
      State.promptContext = null;
      State.chatHistory = [];
      State.noteMessage = null;
    }
    State.uploadProgress = 0;
    State.fileDragOver = false;
    if (!keepFollow) UploadSeq.deactivate();
    this.uploadCanvas.clear();
    for (const view of ["uploading", "choose", "prompt"] as const) this.views.get(view)?.sync();
    State.notify();
  }

  private async prepareNext() {
    if (this.copyingId || !this.queuedCopy) return;
    const { id, path } = this.queuedCopy;
    this.queuedCopy = null;
    if (State.paused || State.filePreparation.current?.id !== id) return;
    this.copyingId = id;
    try {
      const file = await Bridge.ingestFile(path, id);
      if (State.paused || !State.filePreparation.complete(id, file)) return;
      State.uploadProgress = 1;
      UploadSeq.finishPreparation(true);
      State.notify();
    } catch (error) {
      const reason = error === "File access denied." ? "denied"
        : error === "Select an unchanged regular file without symbolic links." ? "invalid" : "storage";
      if (State.paused || !State.filePreparation.fail(id, reason)) return;
      UploadSeq.finishPreparation(false);
      UploadSeq.deactivate();
      State.notify();
      if (State.pendingApproval || !UPLOAD_VIEWS.has(State.view)) return;
      State.noteMessage = error === "Another file is still preparing." ? "Another file is still preparing. Try again when it finishes."
        : reason === "denied" ? "File access denied."
        : reason === "invalid" ? "Select an unchanged regular file without symbolic links."
        : "Could not prepare file storage.";
      this.engine.animateMorph(0);
      this.setView("note");
      Sound.play("error");
      this.preparationRecovery = window.setTimeout(() => {
        if (State.filePreparation.current?.id !== id || State.paused || State.pendingApproval || State.view !== "note") return;
        this.preparationRecovery = null;
        this.setView(State.defaultView());
      }, 2400);
    } finally {
      // cancel_file_copy acknowledges revocation, not worker termination. Wait
      // for BOTH this receipt and cancellation before admitting the latest slot.
      await this.copyCancellation;
      this.copyingId = null;
      this.copyCancellation = null;
      void this.prepareNext();
    }
  }

  /** Completion choreography is downstream of a current ready disposition. */
  private stepSequence() {
    if (State.filePreparation.current?.state !== "ready" || State.pendingApproval || !this.uploadActive) return;
    const frame = UploadSeq.frame(this.reducedMotion.matches);
    if (!this.uploadDone && frame.check > 0) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    if (frame.chooseAlpha >= 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    this.islandEl.classList.toggle("monitor-reduced-motion", this.reducedMotion.matches);
    if (this.reducedMotion.matches) {
      this.width.jump(w); this.height.jump(h); this.radius.jump(r);
      const p = botPosition(State.mode, State.view, h, State.uploadProgress);
      this.botCx.set(p.cx); this.botCy.set(p.cy); this.botSize.set(p.diameter / 0.6);
    } else if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    const generation = ++this.collapseGeneration;
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        if (generation !== this.collapseGeneration) return;
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    const inspector = this.views.get("agentSession")!.el;
    inspector.addEventListener("mouseenter", () => { this.inspectorHovered = true; this.syncInspectorHold(); });
    inspector.addEventListener("mouseleave", () => { this.inspectorHovered = false; this.syncInspectorHold(); });
    inspector.addEventListener("focusin", () => this.syncInspectorHold());
    inspector.addEventListener("focusout", () => queueMicrotask(() => this.syncInspectorHold()));
    this.islandEl.addEventListener("focusin", () => {
      if (State.paused) return;
      this.fsm.setHold("keyboard", true);
      if (State.mode !== "expanded") this.fsm.forceHome();
      this.syncInspectorHold();
    });
    this.islandEl.addEventListener("focusout", () => queueMicrotask(() => this.syncInspectorHold()));
    this.reducedMotion.addEventListener("change", () => {
      if (this.reducedMotion.matches && this.fsm.state === "coucou") {
        this.greeting.interrupt();
        this.expand(State.defaultView());
        this.fsm.greetComplete();
      } else this.animateGeometry(false);
    });
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      if (State.paused) return;
      Sound.resume();
      if (!this.wasInIsland) {
        this.wasInIsland = true;
        this.fsm.mouseEntered();
      }
    });
    this.wakeStrip.addEventListener("mouseleave", (e) => {
      if (this.islandEl.contains(e.relatedTarget as Node | null)) return;
      this.wasInIsland = false;
      this.fsm.mouseLeft();
      this.ensureRunning();
    });
    this.wakeStrip.addEventListener("mousedown", () => {
      if (!State.paused) { Sound.resume(); this.fsm.click(); }
    });
    this.wakeStrip.addEventListener("keydown", (e) => {
      if (State.paused || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      this.fsm.forceHome();
      this.islandEl.focus();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      if (State.paused) return;
      Sound.resume();
      State.lastActivity = performance.now();
      const expanded = State.mode === "expanded";
      this.fsm.click();
      if (!expanded) return;
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (State.paused) return;
      if ((e.key === "Enter" || e.key === " ") && e.target === this.islandEl) {
        e.preventDefault(); this.fsm.forceHome();
      }
      if (e.key === "Escape" && State.mode === "expanded") {
        if (State.view === "agentSession") { e.preventDefault(); this.setView("overview"); }
        else if (!State.isPinned) this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => {
      this.fsm.setHold("drag", !State.paused && (e.type === "enter" || e.type === "over"));
      this.onDragDrop(e);
    });
    void onEvent<null>("screen-changed", () => this.cancelInputTimers());
    window.addEventListener("pagehide", () => {
      this.clearPreparation();
      this.cancelInputTimers();
      this.fsm.forceHidden();
    });

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  private syncInspectorHold() {
    const el = this.views.get("agentSession")?.el;
    const focused = document.activeElement;
    const focusedView = focused?.closest(".view");
    const keyboard = !State.paused && State.mode === "expanded" && this.islandEl.contains(focused)
      && (!focusedView || focusedView === this.views.get(State.view)?.el);
    State.inspectorHold = !State.paused && State.mode === "expanded" && State.view === "agentSession" && !!el && (this.inspectorHovered || (keyboard && el.contains(focused)));
    this.fsm.pinned = State.isPinned || State.pendingApproval !== null;
    this.fsm.setHold("keyboard", keyboard);
    this.fsm.setInteractionHold(State.inspectorHold);
    this.fsm.setHold("drag", !State.paused && State.fileDragOver);
    this.ensureRunning();
  }

  private cancelInputTimers() {
    this.wasInIsland = false;
    this.inspectorHovered = false;
    this.fsm.mouseLeft();
    this.fsm.cancelTimers();
    this.cancelBotHover();
    this.collapseGeneration++;
    if (this.collapseTimer != null) window.clearTimeout(this.collapseTimer);
    this.collapseTimer = null;
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    if (State.paused) return;
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    const wasInIsland = this.wasInIsland;
    this.wasInIsland = inIsland;
    if (inIsland && !wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
    }
    if (!inIsland && wasInIsland) {
      this.fsm.mouseLeft();
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    const generation = ++this.botHoverGeneration;
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      if (generation !== this.botHoverGeneration) return;
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    this.botHoverGeneration++;
    this.botHovering = false;
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(this.reducedMotion.matches ? 0 : dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(this.reducedMotion.matches), this.reducedMotion.matches ? 0 : nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(this.reducedMotion.matches ? 0 : dt);
    this.views.get(State.view)?.tick?.(nowMs);
    // The rail is compact-only, so its indicators stop syncing once expanded.
    // Nothing decorative runs while the island is hidden (0% CPU contract).
    if (State.mode === "compact") this.syncStatusRail();
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || (!this.reducedMotion.matches && (this.engine.busy || UploadSeq.isActive)) || this.fsm.homeCollapseAt !== null;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || this.fsm.held || this.fsm.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const windowS = Math.min(10, this.fsm.homeCollapseDurationMs / 1000 * 0.6);
    const remaining = (this.fsm.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      view.el.inert = !on || !expanded;
      if (on) view.sync();
    }

    // Chat and the keyboard-accessible inspector can take window focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt" || this.lastSyncedView === "agentSession";
      this.lastSyncedView = State.view;
      if (State.view === "prompt" || State.view === "agentSession") {
        void Bridge.focusWindow(true);
        const view = State.view;
        const generation = State.agentMonitor.generation;
        window.setTimeout(() => {
          if (State.view === view && State.mode === "expanded" && generation === State.agentMonitor.generation) this.views.get(view)?.focus?.();
        }, 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";

    // The status rail shares the compact slot: it only takes pointer events when
    // it is actually visible, so a hidden island can never swallow a click.
    const showRail = showGrid && !this.uploadActive;
    this.statusRail.style.opacity = showRail ? "1" : "0";
    this.statusRail.style.pointerEvents = showRail ? "auto" : "none";

    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    if (State.settings.screen !== this.lastScreen) {
      this.lastScreen = State.settings.screen;
      this.cancelInputTimers();
    }
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.settings.hoverOpenDelayMs = clamp(Math.round(State.settings.hoverOpenDelayMs || 0), 0, 1000);
    this.fsm.hoverOpenDelayMs = State.settings.hoverOpenDelayMs;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
