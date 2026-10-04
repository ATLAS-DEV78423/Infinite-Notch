// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "coucou";
type HoldOwner = "approval" | "inspector" | "keyboard" | "drag" | "menu";
type Timer = "hoverOpen" | "petitHide" | "homeCollapse" | "greetCollapse";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** home → petit delay, seconds. */
  homeToPetitDelay = 15;
  /** petit → hidden delay, seconds. */
  petitToHiddenDelay = 60;
  /** coucou → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** coucou → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  hoverOpenDelayMs = 0;
  hoverLeaveDelayMs = 300;
  /** The actual monotonic deadline/duration, shared with the countdown. */
  homeCollapseAt: number | null = null;
  homeCollapseDurationMs = 0;

  private holds = new Set<HoldOwner>();
  get held() { return this.holds.size > 0; }
  /** Compatibility inputs use the same owner set, never a second pin. */
  get pinned() { return this.holds.has("approval"); }
  set pinned(held: boolean) { this.setHold("approval", held); }
  get interactionHold() { return this.holds.has("inspector"); }
  set interactionHold(held: boolean) { this.setHold("inspector", held); }
  setInteractionHold(held: boolean) { this.setHold("inspector", held); }

  setHold(owner: HoldOwner, held: boolean): void {
    if (held === this.holds.has(owner)) return;
    if (held) this.holds.add(owner);
    else this.holds.delete(owner);
    if (this.held) {
      this.clear("homeCollapse");
      this.clear("greetCollapse");
      this.clear("petitHide");
    } else {
      if (this.state === "home") this.scheduleHomeCollapse();
      else if (this.state === "petit") this.schedulePetitHide();
      else if (this.state === "coucou" && this.greetCollapseDelay !== null) this.scheduleGreetCollapse(this.greetCollapseDelay);
    }
  }

  private pointerInside = false;
  private openingOrigin: "hover" | "explicit" = "explicit";
  private hoverOpen: number | null = null;
  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;
  /** Deferred greeting intent survives a hold, but not explicit cancellation. */
  private greetCollapseDelay: number | null = null;
  private generations: Record<Timer, number> = { hoverOpen: 0, petitHide: 0, homeCollapse: 0, greetCollapse: 0 };

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("coucou");
  }

  mouseEntered() {
    this.pointerInside = true;
    switch (this.state) {
      case "hidden":
      case "petit":
        this.cancelTimers();
        if (this.hoverOpenDelayMs === 0) this.openFromHover();
        else this.schedule("hoverOpen", this.hoverOpenDelayMs, () => {
          if (this.pointerInside && (this.state === "hidden" || this.state === "petit")) this.openFromHover();
        });
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "coucou":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  mouseLeft() {
    this.pointerInside = false;
    this.clear("hoverOpen");
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        this.scheduleHomeCollapse();
        break;
      case "coucou":
        this.clear("greetCollapse");
        if (this.held) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
        else this.transition("petit");
        break;
    }
  }

  click() {
    if (this.state === "hidden" || this.state === "petit" || this.state === "home") this.forceHome();
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "coucou") return;
    if (this.greetCollapseDelay == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.openingOrigin = "explicit";
    this.transition("home");
    this.scheduleHomeCollapse();
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.pointerInside = false;
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private openFromHover() {
    this.cancelTimers();
    this.openingOrigin = "hover";
    this.transition("home");
  }

  private schedulePetitHide() {
    this.clear("petitHide");
    if (this.held || this.pointerInside || this.state !== "petit") return;
    this.schedule("petitHide", this.petitToHiddenDelay * 1000, () => {
      if (this.state === "petit" && !this.held && !this.pointerInside) this.transition("hidden");
    });
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    if (this.held || this.pointerInside || this.state !== "home") return;
    const delay = this.openingOrigin === "hover" ? this.hoverLeaveDelayMs : this.homeToPetitDelay * 1000;
    this.schedule("homeCollapse", delay, () => {
      if (this.state === "home" && !this.held && !this.pointerInside) this.transition("petit");
    });
    this.homeCollapseDurationMs = delay;
    this.homeCollapseAt = performance.now() + delay;
  }

  private scheduleGreetCollapse(delay: number) {
    this.greetCollapseDelay = delay;
    this.clear("greetCollapse");
    if (this.held || this.state !== "coucou") return;
    this.schedule("greetCollapse", delay * 1000, () => {
      if (this.state === "coucou" && !this.held) this.transition("petit");
    });
  }

  private schedule(which: Timer, delay: number, callback: () => void) {
    this.clear(which);
    const generation = this.generations[which];
    this[which] = window.setTimeout(() => {
      if (generation !== this.generations[which]) return;
      this.clear(which);
      callback();
    }, delay);
  }

  private clear(which: Timer) {
    this.generations[which]++;
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
    if (which === "homeCollapse") {
      this.homeCollapseAt = null;
      this.homeCollapseDurationMs = 0;
    }
  }

  cancelTimers() {
    this.greetCollapseDelay = null;
    this.clear("hoverOpen");
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
    if (this.state === "petit" && !this.pointerInside) this.schedulePetitHide();
  }
}
