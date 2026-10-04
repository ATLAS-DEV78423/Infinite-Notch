import Foundation

/// Pure 4-state FSM for island open/close logic.
/// No AppKit / AppState dependencies — communicates via `onTransition`.
@MainActor
final class IslandStateMachine {

    enum State: Equatable {
        case hidden   // island invisible (notch size)
        case petit    // compact island (notch + ears)
        case home     // expanded, overview
        case coucou   // expanded, greeting animation
    }

    private(set) var state: State = .hidden

    /// Fired on every transition: (from, to)
    var onTransition: ((State, State) -> Void)?

    enum HoldOwner: Hashable, CaseIterable {
        case approval, inspector, keyboard, drag, menu
    }

    private var holds: Set<HoldOwner> = []
    var held: Bool { !holds.isEmpty }
    func hasHold(_ owner: HoldOwner) -> Bool { holds.contains(owner) }

    var hoverOpenDelayMs: Int = 0 {
        didSet {
            hoverOpenDelayMs = Self.validatedHoverOpenDelayMs(hoverOpenDelayMs)
            if oldValue != hoverOpenDelayMs, pointerInside, state == .hidden || state == .petit {
                mouseEntered()
            }
        }
    }
    var hoverLeaveDelayMs: Int = 300 {
        didSet {
            hoverLeaveDelayMs = max(0, hoverLeaveDelayMs)
            if oldValue != hoverLeaveDelayMs { scheduleHomeCollapse() }
        }
    }

    static func validatedHoverOpenDelayMs(_ stored: Int?) -> Int {
        min(1000, max(0, stored ?? 0))
    }

    /// Monotonic deadline/duration of the actual home timer, not lastActivity.
    private(set) var homeCollapseAt: TimeInterval?
    private(set) var homeCollapseDuration: TimeInterval = 0
    var onDeadlineChange: (() -> Void)?

    static func countdownFraction(deadline: TimeInterval?, duration: TimeInterval, now: TimeInterval) -> Double {
        guard let deadline, duration > 0 else { return 0 }
        let window = min(10, duration * 0.6)
        let remaining = deadline - now
        guard remaining > 0, remaining <= window else { return 0 }
        return remaining / window
    }

    /// home → petit delay (seconds). Override for debug.
    var homeToPetitDelay: TimeInterval = 15 {
        didSet { if oldValue != homeToPetitDelay { scheduleHomeCollapse() } }
    }
    /// petit → hidden delay (seconds). Override for debug.
    var petitToHiddenDelay: TimeInterval = 60
    /// coucou → petit delay after greeting animation ends (no hover). ~0.6s syncs with canvas collapse.
    var greetAutoCollapseDelay: TimeInterval = 0.6
    /// coucou → petit delay when mouse is hovering over the greeting.
    var greetHoverCollapseDelay: TimeInterval = 10

    // Bounded queue/clock seam for this FSM only. Production still uses Dispatch main.
    typealias TimerAction = @MainActor @Sendable () -> Void
    typealias Cancellation = @MainActor () -> Void
    typealias Schedule = @MainActor (TimeInterval, @escaping TimerAction) -> Cancellation

    private enum TimerKind: Hashable, CaseIterable, Sendable {
        case hoverOpen, petitHide, homeCollapse, greetCollapse
    }
    private let now: @MainActor () -> TimeInterval
    private let scheduleTimer: Schedule
    private var cancellations: [TimerKind: Cancellation] = [:]
    private var generations: [TimerKind: Int] = [:]
    private var pointerInside = false
    private var openedByHover = false
    private var hasCloseIntent = false
    private var greetCollapseDelay: TimeInterval?

    init(now: @escaping @MainActor () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         schedule: @escaping Schedule = { delay, action in
             let work = DispatchWorkItem {
                 Task { @MainActor in action() }
             }
             DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
             return { work.cancel() }
         }) {
        self.now = now
        self.scheduleTimer = schedule
    }

    func setHold(owner: HoldOwner, held: Bool) {
        guard held != holds.contains(owner) else { return }
        if held { holds.insert(owner) } else { holds.remove(owner) }
        if self.held {
            clear(.homeCollapse)
            clear(.petitHide)
            clear(.greetCollapse)
        } else if hasCloseIntent {
            switch state {
            case .home: scheduleHomeCollapse()
            case .petit: schedulePetitHide()
            case .coucou:
                if let delay = greetCollapseDelay { scheduleGreetCollapse(delay: delay) }
            case .hidden: break
            }
        }
    }

    // MARK: – Inputs

    /// App launched or debug "launch greeting"
    func launch() {
        cancelTimers()
        hasCloseIntent = true
        transition(to: .coucou)
    }

    /// Mouse entered the island notch area
    func mouseEntered() {
        pointerInside = true
        switch state {
        case .hidden, .petit:
            cancelTimers()
            if hoverOpenDelayMs == 0 {
                openFromHover()
            } else {
                schedule(.hoverOpen, delay: Double(hoverOpenDelayMs) / 1000) { [weak self] in
                    guard let self, !self.held, self.pointerInside, self.state == .hidden || self.state == .petit else { return }
                    self.openFromHover()
                }
            }
        case .home:
            clear(.homeCollapse)
        case .coucou:
            // Mouse hovering during greeting — cancel short auto-collapse, extend to hover delay
            scheduleGreetCollapse(delay: greetHoverCollapseDelay)
        }
    }

    /// Mouse left the island notch area
    func mouseLeft() {
        pointerInside = false
        clear(.hoverOpen)
        hasCloseIntent = true
        switch state {
        case .hidden:
            break
        case .petit:
            schedulePetitHide()
        case .home:
            scheduleHomeCollapse()
        case .coucou:
            clear(.greetCollapse)
            if held {
                scheduleGreetCollapse(delay: greetAutoCollapseDelay)
            } else {
                // Preserve the existing unheld greeting interruption on leave.
                transition(to: .petit)
            }
        }
    }

    /// Explicit input bypasses hover delay, including clicks on a hover-open view.
    func click() {
        cancelTimers()
        openedByHover = false
        hasCloseIntent = true
        transition(to: .home)
        scheduleHomeCollapse()
    }

    func userInteracted() {
        if state == .home { click() }
    }

    /// The app hid the island on its own (e.g. `AppState.syncMode()` when the last
    /// task ends). Mirror it without transition side effects; cancel any old view.
    func hiddenExternally() {
        cancelTimers()
        pointerInside = false
        state = .hidden
    }

    /// The app expanded the island externally (hookExpand for an alert).
    /// Cancel timers and sync state to `.home` without firing `onTransition`, so the
    /// next hover/mouseLeft behave correctly instead of collapsing the island.
    func openedExternally() {
        cancelTimers()
        openedByHover = false
        hasCloseIntent = true
        state = .home
        scheduleHomeCollapse()
    }

    /// AppState can reveal the compact strip directly; sync without a second reveal.
    func collapsedExternally() {
        cancelTimers()
        state = .petit
        hasCloseIntent = true
        schedulePetitHide()
    }

    /// The app folded the island itself (Escape, Settings, OK button, auto-close).
    /// Move to `.petit` right away so hover and click keep working; waiting for the
    /// 15 s home timer left the island compact on screen while the FSM still said `.home`.
    func collapse() {
        cancelTimers()
        guard state == .home || state == .coucou else { return }
        hasCloseIntent = true
        transition(to: .petit)
    }

    /// Greeting animation finished (called at T.end ≈ 4.60 s).
    /// Schedules auto-collapse. Does not override a longer hover timer already running.
    func greetComplete() {
        guard state == .coucou else { return }
        // If mouse entered before this fires (hover timer already running), don't override it
        if greetCollapseDelay == nil {
            scheduleGreetCollapse(delay: greetAutoCollapseDelay)
        }
    }

    private func scheduleGreetCollapse(delay: TimeInterval) {
        hasCloseIntent = true
        greetCollapseDelay = delay
        clear(.greetCollapse)
        guard state == .coucou, !held else { return }
        schedule(.greetCollapse, delay: delay) { [weak self] in
            guard let self, self.state == .coucou, !self.held else { return }
            self.transition(to: .petit)
        }
    }

    /// Non-alert work event: show compact from hidden (HookServer reveal)
    func reveal() {
        guard state == .hidden else { return }
        cancelTimers()
        hasCloseIntent = true
        transition(to: .petit)
    }

    // MARK: – Timers

    private func openFromHover() {
        guard !held else { return }
        cancelTimers()
        openedByHover = true
        hasCloseIntent = true
        transition(to: .home)
    }

    private func schedulePetitHide() {
        clear(.petitHide)
        guard hasCloseIntent, state == .petit, !held, !pointerInside else { return }
        schedule(.petitHide, delay: petitToHiddenDelay) { [weak self] in
            guard let self, self.state == .petit, !self.held, !self.pointerInside else { return }
            self.transition(to: .hidden)
        }
    }

    private func scheduleHomeCollapse() {
        clear(.homeCollapse)
        guard hasCloseIntent, state == .home, !held, !pointerInside else { return }
        let delay = openedByHover ? Double(hoverLeaveDelayMs) / 1000 : max(0, homeToPetitDelay)
        schedule(.homeCollapse, delay: delay) { [weak self] in
            guard let self, self.state == .home, !self.held, !self.pointerInside else { return }
            self.transition(to: .petit)
        }
        setHomeDeadline(now() + delay, duration: delay)
    }

    private func schedule(_ timer: TimerKind, delay: TimeInterval, action: @escaping TimerAction) {
        clear(timer)
        let generation = generations[timer, default: 0]
        cancellations[timer] = scheduleTimer(delay) { [weak self] in
            guard let self, self.generations[timer] == generation else { return }
            self.clear(timer)
            action()
        }
    }

    private func clear(_ timer: TimerKind) {
        generations[timer, default: 0] += 1
        cancellations.removeValue(forKey: timer)?()
        if timer == .homeCollapse { setHomeDeadline(nil, duration: 0) }
    }

    private func setHomeDeadline(_ deadline: TimeInterval?, duration: TimeInterval) {
        guard homeCollapseAt != deadline || homeCollapseDuration != duration else { return }
        homeCollapseAt = deadline
        homeCollapseDuration = duration
        onDeadlineChange?()
    }

    func cancelTimers() {
        hasCloseIntent = false
        greetCollapseDelay = nil
        for timer in TimerKind.allCases { clear(timer) }
    }

    private func transition(to new: State) {
        guard new != state else { return }
        let old = state
        state = new
        onTransition?(old, new)
        if state == .petit && !pointerInside {
            hasCloseIntent = true
            schedulePetitHide()
        }
    }

}
