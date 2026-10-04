import AppKit
import Combine
import SwiftUI

@MainActor
final class IslandWindowController: NSWindowController {

    private var islandPanel: IslandPanel!
    private var state: AppState { AppState.shared }

    // State machine (replaces all hover/absence/auto-close timers)
    let fsm = IslandStateMachine()

    private var wasInIsland = false
    private var frameTimer: Timer?
    private var eventMonitors: [Any] = []
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var viewSubscription: AnyCancellable?
    private var fileDragActive = false
    private var activeMenus: Set<ObjectIdentifier> = []
    private var inputSuspended = false
    private var wasInactive = false
    // An initial outside sample is not a leave: launch must finish its greeting.
    private var needsPointerSync = false
    private var isCleanedUp = false
    private var presentationGeneration = 0

    // Confused recovery timer (set by handleDizzy)
    private var confusedRecoveryTimer: DispatchWorkItem?

    // Suppress peek sound on next reveal (e.g. musicReveal)
    var silentNextReveal = false

    // Finished-pin timer
    private var finishedPinTimer: DispatchWorkItem?

    // Bot-head hover (love emote — mirrors prototype botHover())
    private var hoverTimer: DispatchWorkItem?
    private var botHoverTimer: DispatchWorkItem?
    private var botHovering: Bool = false
    private var lastLoveTime: Double = 0
    private var botHoverStartPos: CGPoint = .zero

    // Window attach drag (M8)
    private var attachDragStart: NSPoint? = nil
    private var pendingIslandClick = false   // any island click → expand on mouseUp
    private var inAttachDrag = false
    private var dragGhostPanel: NSPanel? = nil
    private var dragGhostSize: CGFloat = 0
    private var ghostCurrentOrigin: NSPoint = .zero
    private var highlightPanel: NSPanel? = nil
    private var highlightWindowPid: pid_t = 0

    // Notch real dimensions (set on init)
    private var notchW: CGFloat = IslandConst.notchWidth
    private var notchH: CGFloat = IslandConst.notchHeight
    private var hasNotch = true

    convenience init() {
        let screen = Self.notchScreen() ?? NSScreen.main!
        let geometry = Self.screenGeometry(for: screen)
        let nW = geometry.width
        let nH = geometry.height

        let panelW: CGFloat = 720
        let panelH: CGFloat = 320
        let sf = screen.frame
        let panel = IslandPanel(
            contentRect: NSRect(x: sf.midX - panelW/2, y: sf.maxY - panelH,
                                width: panelW, height: panelH),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        panel.notchWidth  = nW
        panel.notchHeight = nH

        self.init(window: panel)
        self.islandPanel = panel
        self.notchW = nW
        self.notchH = nH
        self.hasNotch = geometry.hasNotch
        setupPanel(screen: screen)
    }

    private func setupPanel(screen: NSScreen) {
        guard let panel = window as? IslandPanel else { return }
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 3)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.ignoresMouseEvents = true

        // Propagate real notch dimensions to AppState
        AppState.shared.notchWidth  = notchW
        AppState.shared.notchHeight = notchH
        AppState.shared.hasNotch = hasNotch

        let contentSize = panel.contentRect(forFrameRect: panel.frame).size

        // Apple-recommended pattern: put NSHostingView and drag destination as siblings
        // inside a common superview, rather than embedding one inside the other.
        let container = NSView(frame: NSRect(origin: .zero, size: contentSize))
        container.autoresizingMask = [.width, .height]

        let hosting = NSHostingView(rootView: IslandRootView().environmentObject(AppState.shared)
            .transaction { transaction in
                if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
            })
        hosting.frame = NSRect(origin: .zero, size: contentSize)
        hosting.autoresizingMask = [.width, .height]

        // FileDropNSView sits below the hosting view (hitTest returns nil → no mouse interference).
        // AppKit routes NSDraggingDestination events to registered views independently of hitTest.
        let dropView = FileDropNSView(frame: NSRect(origin: .zero, size: contentSize))
        dropView.autoresizingMask = [.width, .height]
        dropView.onDragEntered = { [weak self] loc in
            Task { @MainActor in
                guard let self, !self.isCleanedUp, !self.inputSuspended, self.state.isPresent else { return }
                self.fileDragActive = true
                self.updateDragHold()
                let iLoc = self.windowToIsland(loc)
                AppState.shared.fileDragOver = true
                // enterZone sets isActive=true BEFORE hookExpand triggers re-render,
                // so IslandContainer sees isActive=true when state.view becomes .upload.
                UploadSequenceEngine.shared.enterZone(x: iLoc.x, y: iLoc.y)
                NotificationCenter.default.post(name: .hookExpand, object: IslandView.upload)
                NotificationCenter.default.post(name: .botMorphTo, object: CGFloat(1))
            }
        }
        dropView.onDragUpdated = { [weak self] loc in
            Task { @MainActor in
                guard let self, !self.isCleanedUp, !self.inputSuspended, self.state.isPresent else { return }
                let iLoc = self.windowToIsland(loc)
                UploadSequenceEngine.shared.updateCursor(x: iLoc.x, y: iLoc.y)
            }
        }
        dropView.onDragExited = { [weak self] in
            Task { @MainActor in
                guard let self, !self.isCleanedUp else { return }
                AppState.shared.fileDragOver = false
                // Do NOT collapse — drag session still active; island stays open.
                NotificationCenter.default.post(name: .botMorphTo, object: CGFloat(0))
                UploadSequenceEngine.shared.exitZone()
            }
        }
        dropView.onFilesDropped = { [weak self] urls in
            Task { @MainActor in
                guard let self, !self.isCleanedUp, !self.inputSuspended, self.state.isPresent else { return }
                self.fileDragActive = false
                self.updateDragHold()
                await FileDropHandler.handle(urls: urls, state: AppState.shared)
            }
        }

        container.addSubview(hosting)    // z-bottom: SwiftUI + mouse events
        container.addSubview(dropView)   // z-top: drag only (hitTest→nil, transparent to mouse)
        panel.contentView = container

        wireFSM()
        panel.onFocusChange = { [weak self] in self?.updateKeyboardHold() }
        startPolling()
        startKeyMonitor()
        observeInputLifetime()

        // Make panel key whenever the prompt/chat view becomes active
        // (nonactivatingPanel never auto-becomes key, but TextField needs it)
        viewSubscription = state.$view
            .receive(on: DispatchQueue.main)
            .sink { [weak self] newView in
                let viewName = newView.rawValue
                Task { @MainActor in
                    guard let self, !self.isCleanedUp, !self.inputSuspended, self.state.isPresent,
                          self.state.view.rawValue == viewName else { return }
                    // HookServer also changes alert views directly while already expanded.
                    if self.state.mode == .expanded {
                        switch self.state.view {
                        case .approval, .question, .finished, .error, .confused:
                            if self.state.view != .confused { self.cancelPresentationTimers() }
                            if self.fsm.state == .coucou {
                                NotificationCenter.default.post(name: .greetingInterrupt, object: nil)
                            }
                            self.fsm.openedExternally()
                        default: break
                        }
                    }
                    if self.state.mode == .expanded && (self.state.view == .prompt || self.state.view == .question || self.state.view == .mail) {
                        self.islandPanel.makeKey()
                    } else {
                        self.islandPanel.makeFirstResponder(nil)
                    }
                    self.updateKeyboardHold()
                }
            }
    }

    // MARK: - FSM wiring

    private func wireFSM() {
        state.islandFSM = fsm
        fsm.hoverOpenDelayMs = state.hoverOpenDelayMs
        fsm.homeToPetitDelay = state.autoCloseInterval
        state.updateApprovalHold()
        fsm.onDeadlineChange = { [weak self] in
            guard let self else { return }
            self.state.homeCollapseAt = self.fsm.homeCollapseAt
            self.state.homeCollapseDuration = self.fsm.homeCollapseDuration
        }
        fsm.onTransition = { [weak self] from, to in
            guard let self else { return }
            self.cancelPresentationTimers()
            switch to {
            case .hidden:
                self.setMode(.hidden)

            case .petit:
                if from == .coucou {
                    // Fire interrupt first so canvas collapse starts before mode change
                    NotificationCenter.default.post(name: .greetingInterrupt, object: nil)
                } else if from == .hidden {
                    if self.silentNextReveal {
                        self.silentNextReveal = false
                    } else {
                        SoundEngine.shared.play("peek")
                    }
                }
                // setMode BEFORE changing view: onChange(of: state.view) guards on .expanded,
                // so setting view while already compact won't trigger a spurious open animation.
                self.setMode(.compact)
                if from == .coucou { self.state.view = self.defaultView() }

            case .home:
                if from == .coucou {
                    NotificationCenter.default.post(name: .greetingInterrupt, object: nil)
                }
                self.showExpanded(to: self.defaultView())

            case .coucou:
                self.showExpanded(to: .greeting)
            }
        }

        // FSM observes greetComplete notification
        observe(.greetComplete) { [weak self] in
            guard let self, !self.inputSuspended, self.state.isPresent else { return }
            self.fsm.greetComplete()
        }
    }

    // MARK: - 60 Hz polling loop

    private func startPolling() {
        frameTimer = Timer.scheduledTimer(withTimeInterval: 1.0/60.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.pollFrame() }
        }
        RunLoop.main.add(frameTimer!, forMode: .common)
    }

    private func pollFrame() {
        guard !isCleanedUp else { return }
        if inputSuspended || !state.isPresent {
            if !wasInactive { invalidateInput() }
            wasInactive = true
            return
        }
        if wasInactive {
            wasInactive = false
            needsPointerSync = true
        }
        guard let panel = window as? IslandPanel else { return }

        updateKeyboardHold()
        // Native file drags can end outside our destination without another drag callback.
        if fileDragActive && NSEvent.pressedMouseButtons & 1 == 0 {
            fileDragActive = false
            state.fileDragOver = false
            updateDragHold()
        }

        let mouse = NSEvent.mouseLocation

        // Convert mouse to panel-local coords (macOS: origin bottom-left)
        let pf = panel.frame
        let local = CGPoint(x: mouse.x - pf.minX, y: mouse.y - pf.minY)

        // Island rect in panel coords
        let islandRect = panel.currentIslandFrame(nw: notchW, nh: notchH)
        // On a screen without a notch, the resting bar must not intercept clicks
        // in the app window immediately below the menu bar.
        let hoverRect = !hasNotch && state.mode != .expanded
            ? islandRect : islandRect.insetBy(dx: -6, dy: -6)
        let inIsland = hoverRect.contains(local)

        // Toggle click-through
        let shouldAcceptMouse = inIsland || inAttachDrag || attachDragStart != nil
        if panel.ignoresMouseEvents == shouldAcceptMouse {
            panel.ignoresMouseEvents = !shouldAcceptMouse
            if shouldAcceptMouse, let cv = panel.contentView {
                panel.invalidateCursorRects(for: cv)
            }
        }

        // Mouse in screen coords (Y flipped, origin top-left) for Bot look-at
        let screenH = panel.screen?.frame.height ?? NSScreen.main!.frame.height
        let newPos = CGPoint(x: mouse.x - (panel.screen?.frame.minX ?? 0), y: screenH - mouse.y)
        let cur = AppState.shared.mousePosition
        if abs(newPos.x - cur.x) > 1 || abs(newPos.y - cur.y) > 1 {
            AppState.shared.mousePosition = newPos
        }

        // AppState can hide the island by itself (last task ended): keep the FSM in step.
        if state.mode == .hidden && fsm.state != .hidden {
            fsm.hiddenExternally()
            needsPointerSync = true
        } else if state.mode == .compact && fsm.state == .hidden {
            fsm.collapsedExternally()
            needsPointerSync = true
        }

        // Bookkeeping precedes callbacks, including the first wake-strip sample.
        let wasInside = wasInIsland
        wasInIsland = inIsland
        if inIsland && (!wasInside || needsPointerSync) {
            // If in coucou: tell greeting to stay open (tc → infinity)
            if fsm.state == .coucou {
                NotificationCenter.default.post(name: .greetingHover, object: nil)
            }
            fsm.mouseEntered()
        }
        if !inIsland && (wasInside || needsPointerSync) {
            fsm.mouseLeft()
        }
        needsPointerSync = false

        // Bot-head hover (love emote)
        let overBot = state.mode == .expanded && state.stateOverride == nil && isBotHit(local)
        if overBot && !botHovering { botHoverIn(mousePos: NSEvent.mouseLocation) }
        if !overBot && botHovering { botHoverOut() }
        botHovering = overBot
        if botHovering {
            let m = NSEvent.mouseLocation
            let dist = hypot(m.x - botHoverStartPos.x, m.y - botHoverStartPos.y)
            if dist > 40 {
                botHoverStartPos = m
                botHoverTimer?.cancel()
                scheduleLoveTimer()
            }
        }

        // Ghost Mochi follows cursor + window highlight during drag (60 Hz, no throttle)
        if inAttachDrag {
            updateDragGhost()
            updateWindowHighlight()
        }
    }

    private var lastMouse: CGPoint = .zero

    // Native focus/drag/menu lifetimes feed separate owners of the same FSM hold set.
    private func updateKeyboardHold() {
        let focusedView = islandPanel.firstResponder as? NSView
        let focused = !inputSuspended && state.isPresent && state.mode == .expanded
            && islandPanel.isKeyWindow && focusedView?.window === islandPanel
        fsm.setHold(owner: .keyboard, held: focused)
    }

    private func updateDragHold() {
        fsm.setHold(owner: .drag, held: fileDragActive || inAttachDrag || attachDragStart != nil)
    }

    private func retainMonitor(_ monitor: Any?) {
        if let monitor { eventMonitors.append(monitor) }
    }

    private func observe(_ name: Notification.Name, center: NotificationCenter = .default,
                         object: Any? = nil, action: @escaping @MainActor @Sendable () -> Void) {
        let token = center.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.isCleanedUp else { return }
                action()
            }
        }
        observers.append((center, token))
    }

    private func observeInputLifetime() {
        for (name, began) in [(NSMenu.didBeginTrackingNotification, true), (NSPopover.willShowNotification, true),
                              (NSMenu.didEndTrackingNotification, false), (NSPopover.didCloseNotification, false)] {
            let token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let object = note.object as? NSObject else { return }
                let id = ObjectIdentifier(object)
                Task { @MainActor in
                    guard let self, !self.isCleanedUp else { return }
                    if began {
                        guard !self.inputSuspended, self.state.isPresent else { return }
                        self.activeMenus.insert(id)
                    } else {
                        self.activeMenus.remove(id)
                    }
                    self.fsm.setHold(owner: .menu, held: !self.activeMenus.isEmpty)
                }
            }
            observers.append((.default, token))
        }
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification] {
            observe(name, center: NSWorkspace.shared.notificationCenter) { [weak self] in
                guard let self else { return }
                self.inputSuspended = true
                self.invalidateInput()
            }
        }
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
            observe(name, center: NSWorkspace.shared.notificationCenter) { [weak self] in
                self?.inputSuspended = false
                self?.needsPointerSync = true
            }
        }
        observe(NSApplication.didChangeScreenParametersNotification) { [weak self] in self?.refreshScreen() }
        observe(NSWindow.willCloseNotification, object: window) { [weak self] in self?.cleanup() }
        observe(NSApplication.willTerminateNotification) { [weak self] in self?.cleanup() }
    }

    private func invalidateInput() {
        // Clear intent before releasing owners: release cannot revive a canceled timer.
        fsm.cancelTimers()
        cancelPresentationTimers()
        wasInIsland = false
        needsPointerSync = true
        pendingIslandClick = false
        attachDragStart = nil
        inAttachDrag = false
        fileDragActive = false
        state.fileDragOver = false
        hideDragGhost()
        updateDragHold()
        activeMenus.removeAll()
        fsm.setHold(owner: .menu, held: false)
        islandPanel.makeFirstResponder(nil)
        islandPanel.resignKey()
        fsm.setHold(owner: .keyboard, held: false)
        islandPanel.ignoresMouseEvents = true
        hoverTimer?.cancel()
        botHoverTimer?.cancel()
        botHovering = false
    }

    private func refreshScreen() {
        invalidateInput()
        guard let panel = window as? IslandPanel,
              let screen = Self.notchScreen() ?? NSScreen.main else { return }
        let geometry = Self.screenGeometry(for: screen)
        notchW = geometry.width
        notchH = geometry.height
        hasNotch = geometry.hasNotch
        panel.notchWidth = notchW
        panel.notchHeight = notchH
        state.notchWidth = notchW
        state.notchHeight = notchH
        state.hasNotch = hasNotch
        panel.setFrameOrigin(NSPoint(x: screen.frame.midX - panel.frame.width / 2,
                                     y: screen.frame.maxY - panel.frame.height))
    }

    private func cancelPresentationTimers() {
        presentationGeneration += 1
        if finishedPinTimer != nil {
            finishedPinTimer?.cancel()
            finishedPinTimer = nil
            state.isPinned = false
        }
        if confusedRecoveryTimer != nil {
            confusedRecoveryTimer?.cancel()
            confusedRecoveryTimer = nil
            if state.stateOverride == .dizzy { state.stateOverride = nil }
        }
    }

    // MARK: - Bot-head hover (love emote — mirrors prototype botHover())

    private func botHoverIn(mousePos: CGPoint) {
        guard state.mode == .expanded, state.stateOverride == nil else { return }
        guard CACurrentMediaTime() - lastLoveTime > 6 else { return }
        botHoverStartPos = mousePos
        NotificationCenter.default.post(name: .botBlink, object: nil)
        NotificationCenter.default.post(name: .botSetTgEs, object: CGFloat(1.08))
        SoundEngine.shared.play("hover")
        scheduleLoveTimer()
    }

    private func botHoverOut() {
        botHoverTimer?.cancel()
        NotificationCenter.default.post(name: .botSetTgEs, object: CGFloat(1))
    }

    private func scheduleLoveTimer() {
        botHoverTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.botHovering, self.state.stateOverride == nil else { return }
            guard CACurrentMediaTime() - self.lastLoveTime > 6 else { return }
            self.lastLoveTime = CACurrentMediaTime()
            NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.love)
            SoundEngine.shared.play("love")
        }
        botHoverTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.9, execute: item)
    }

    private func scheduleHover(after delay: TimeInterval, action: @escaping () -> Void) {
        hoverTimer?.cancel()
        let item = DispatchWorkItem(block: action)
        hoverTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    // MARK: - Mode transitions

    private func modeLevel(_ m: IslandMode) -> Int {
        switch m { case .hidden: return 0; case .compact: return 1; case .expanded: return 2 }
    }

    func setMode(_ mode: IslandMode) {
        let prev = state.mode
        guard mode != prev else { return }
        let shrinking = modeLevel(mode) < modeLevel(prev)
        let anim: Animation? = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? nil : (shrinking
            ? .timingCurve(0.45, 0, 0.2, 1, duration: 0.34)
            : .spring(response: 0.5, dampingFraction: 0.72))
        withAnimation(anim) { state.mode = mode }
        if mode == .expanded { SoundEngine.shared.play("open") }
        if prev == .expanded {
            SoundEngine.shared.play("close")
            islandPanel.makeFirstResponder(nil)
            islandPanel.resignKey()
            updateKeyboardHold()
        }
    }

    func expand(to view: IslandView) {
        guard !isCleanedUp, !inputSuspended, state.isPresent else { return }
        cancelPresentationTimers()
        if fsm.state == .coucou && view != .greeting {
            NotificationCenter.default.post(name: .greetingInterrupt, object: nil)
        }
        fsm.openedExternally()
        showExpanded(to: view)
    }

    private func showExpanded(to view: IslandView) {
        state.view = view
        if state.mode == .expanded {
            // Already expanded — just switch view
        } else {
            setMode(.expanded)
        }
        state.lastActivity = .now
    }

    func collapse() {
        guard !state.isPinned else { return }
        cancelPresentationTimers()
        islandPanel.makeFirstResponder(nil)
        islandPanel.resignKey()
        updateKeyboardHold()
        // Keep the FSM in step with what is on screen (home/coucou → petit now).
        fsm.collapse()
        setMode(.compact)
        window?.resignKey()
    }

    // MARK: - Keyboard (Escape closes)

    private func startKeyMonitor() {
        retainMonitor(NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let code = event.keyCode
            let flags = event.modifierFlags.intersection([.command, .control, .option, .shift]).rawValue
            Task { @MainActor in
                guard let self, !self.isCleanedUp, !self.inputSuspended, self.state.isPresent else { return }
                if code == 53 {
                    self.finishDrag(attach: false)
                    if self.state.mode == .expanded { self.collapse() }
                } else if self.state.hotkeyEnabled, flags == self.state.hotkeyFlags, code == self.state.hotkeyCode {
                    if self.state.mode != .expanded { self.expand(to: self.defaultView()) }
                }
            }
        })
        retainMonitor(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let handled = MainActor.assumeIsolated {
                guard let self, !self.isCleanedUp, !self.inputSuspended, self.state.isPresent else { return false }
                let flags = event.modifierFlags.intersection([.command, .control, .option, .shift]).rawValue
                if self.state.hotkeyEnabled, flags == self.state.hotkeyFlags, event.keyCode == self.state.hotkeyCode {
                    if self.state.mode != .expanded { self.expand(to: self.defaultView()) }
                    return true
                }
                guard event.window === self.islandPanel else { return false }
                self.updateKeyboardHold()
                if event.keyCode == 53 {
                    self.finishDrag(attach: false)
                    guard !self.state.isPinned else { return false }
                    self.collapse()
                    return true
                }
                self.resetActivity()
                return false
            }
            return handled ? nil : event
        })

        // Hook server expand requests (alerts only)
        let expandObserver = NotificationCenter.default.addObserver(forName: .hookExpand, object: nil, queue: .main) { [weak self] note in
            guard let viewName = (note.object as? IslandView)?.rawValue else { return }
            Task { @MainActor in
                guard let self, !self.isCleanedUp, let view = IslandView(rawValue: viewName) else { return }
                self.expand(to: view)
            }
        }
        observers.append((.default, expandObserver))

        // Hook server compact reveal (non-alert work events: session start, tool use, etc.)
        observe(.hookReveal) { [weak self] in
            guard let self, !self.inputSuspended, self.state.isPresent else { return }
            self.fsm.reveal()
        }

        // Music started playing: reveal silently (no peek sound)
        observe(.musicReveal) { [weak self] in
            guard let self, !self.inputSuspended, self.state.isPresent else { return }
            self.silentNextReveal = true
            self.fsm.reveal()
            self.silentNextReveal = false
        }

        // Collapse requests from views (OK button, etc.)
        observe(.islandCollapse) { [weak self] in
            self?.collapse()
        }

        // .botDizzy — posted by BotEngine.slap() on 3rd hit; show confused view + recover after 3.3s
        observe(.botDizzy) { [weak self] in
            self?.handleDizzy()
        }

        // Window attach drag.
        // Uses MainActor.assumeIsolated (synchronous) to avoid race with pollFrame().
        // Global mouseUp is the reliable fallback when cursor is outside our panel frame.
        retainMonitor(NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            guard let self else { return event }
            MainActor.assumeIsolated {
                guard !self.isCleanedUp, !self.inputSuspended, self.state.isPresent,
                      event.window === self.islandPanel,
                      self.islandPanel.currentIslandFrame(nw: self.notchW, nh: self.notchH).contains(event.locationInWindow) else { return }
                self.wasInIsland = true
                self.needsPointerSync = false
                self.fsm.mouseEntered()
                self.pendingIslandClick = true
                self.hoverTimer?.cancel()
                self.botHoverTimer?.cancel()
                self.botHovering = false
                // Drag only starts when clicking directly on the bot head
                guard self.isBotHit(event.locationInWindow) else { return }
                self.attachDragStart = NSEvent.mouseLocation
                self.updateDragHold()
                // Post slap only when expanded
                guard self.state.mode == .expanded else { return }
                NotificationCenter.default.post(name: .triggerSlap, object: nil)
            }
            return event
        })
        retainMonitor(NSEvent.addLocalMonitorForEvents(matching: .leftMouseDragged) { [weak self] event in
            guard let self else { return event }
            MainActor.assumeIsolated {
                guard !self.isCleanedUp, !self.inputSuspended, self.state.isPresent,
                      let start = self.attachDragStart, !self.inAttachDrag else { return }
                let m = NSEvent.mouseLocation
                guard hypot(m.x - start.x, m.y - start.y) > 3 else { return }
                self.inAttachDrag = true
                NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.love)
                self.showDragGhost()
            }
            return event
        })

        // mouseUp — local (cursor still in panel) + global (cursor moved outside panel frame)
        retainMonitor(NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { [weak self] event in
            guard let self else { return event }
            MainActor.assumeIsolated {
                guard !self.isCleanedUp, !self.inputSuspended, self.state.isPresent else { return }
                let hadPendingClick = self.pendingIslandClick
                let wasDragging     = self.inAttachDrag
                self.pendingIslandClick = false
                if wasDragging {
                    self.finishDrag()
                } else {
                    self.attachDragStart = nil
                    if hadPendingClick {
                        self.cancelPresentationTimers()
                        if self.fsm.state == .home && self.state.mode != .expanded {
                            // FSM already thinks it's open (e.g. the view folded it): just reopen.
                            self.expand(to: self.defaultView())
                        } else {
                            self.fsm.click()
                        }
                    }
                    self.fileDragActive = false
                    self.updateDragHold()
                }
            }
            return event
        })
        retainMonitor(NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.isCleanedUp else { return }
                self.finishDrag()
            }
        })

        // Track last external app for window context capture
        let ourBundle = Bundle.main.bundleIdentifier ?? ""
        let activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { [weak self] note in
            guard let self else { return }
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
               app.bundleIdentifier != ourBundle {
                self.state.lastExternalApp = app
            }
        }
        observers.append((NSWorkspace.shared.notificationCenter, activationObserver))
    }

    private func finishDrag(attach: Bool = true) {
        let wasDragging = inAttachDrag
        inAttachDrag = false
        attachDragStart = nil
        pendingIslandClick = false
        fileDragActive = false
        state.fileDragOver = false
        if wasDragging {
            state.stateOverride = nil
            hideDragGhost()
            #if !APPSTORE
            if attach, !inputSuspended, state.isPresent, let ctx = windowContextAtPoint(NSEvent.mouseLocation) {
                state.promptContext = ctx
                SoundEngine.shared.play("approve")
                NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.happy)
                expand(to: .prompt)
            }
            #endif
        }
        updateDragHold()
    }

    // MARK: - Drag ghost window (Mochi follows cursor during drag)

    private func showDragGhost() {
        guard dragGhostPanel == nil else { return }
        // Same size as compact bot: diameter=20 → canvasSize≈33, scale 2× for grab comfort
        let canvasSize: CGFloat = 40 / 0.6      // ~67
        dragGhostSize = canvasSize

        let mouse = NSEvent.mouseLocation
        let s = dragGhostSize
        ghostCurrentOrigin = NSPoint(x: mouse.x - s/2, y: mouse.y - s/2)

        let panel = NSPanel(
            contentRect: NSRect(x: ghostCurrentOrigin.x, y: ghostCurrentOrigin.y, width: s, height: s),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 4)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true

        let hosting = NSHostingView(
            rootView: GhostBotView(canvasSize: canvasSize)
        )
        hosting.frame = NSRect(x: 0, y: 0, width: s, height: s)
        panel.contentView = hosting
        panel.alphaValue = 0
        panel.orderFront(nil)
        dragGhostPanel = panel
        AppState.shared.isDraggingBot = true

        // Fade + scale-in handled by GhostBotView SwiftUI animation;
        // also fade in the window itself for extra smoothness
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    private func hideDragGhost() {
        dragGhostPanel?.close()
        dragGhostPanel = nil
        highlightPanel?.close()
        highlightPanel = nil
        highlightWindowPid = 0
        AppState.shared.isDraggingBot = false
    }

    private func updateDragGhost() {
        guard let panel = dragGhostPanel else { return }
        let s = dragGhostSize
        let mouse = NSEvent.mouseLocation
        // Direct follow — bot is "held", no trailing lag
        ghostCurrentOrigin = NSPoint(x: mouse.x - s/2, y: mouse.y - s/2)
        panel.setFrameOrigin(ghostCurrentOrigin)
    }

    // MARK: - Window highlight overlay (white border on target window during drag)

    private func updateWindowHighlight() {
        let mouse = NSEvent.mouseLocation
        guard let (appKitBounds, pid) = windowBoundsAtScreenPoint(mouse) else {
            // Fade out + close if no window under cursor
            if let old = highlightPanel {
                let captured = old
                highlightPanel = nil
                highlightWindowPid = 0
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = 0.12
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                    captured.animator().alphaValue = 0
                }, completionHandler: { captured.close() })
            }
            return
        }

        if pid == highlightWindowPid, let existing = highlightPanel {
            // Same window — just track position (windows rarely move, instant is fine)
            existing.setFrame(appKitBounds, display: false)
        } else {
            // New window — close old immediately, fade-in new
            highlightPanel?.close()
            highlightPanel = nil
            highlightWindowPid = pid

            let panel = NSPanel(
                contentRect: appKitBounds,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered, defer: false
            )
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
            panel.ignoresMouseEvents = true

            let hosting = NSHostingView(rootView:
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.white.opacity(0.75), lineWidth: 3)
                    .shadow(color: Color.white.opacity(0.5), radius: 16)
                    .padding(2)
                    .ignoresSafeArea()
            )
            hosting.frame = CGRect(origin: .zero, size: appKitBounds.size)
            hosting.autoresizingMask = [.width, .height]
            panel.contentView = hosting
            panel.alphaValue = 0
            panel.orderFront(nil)
            highlightPanel = panel

            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.14
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1
            }
        }
    }

    private func windowBoundsAtScreenPoint(_ screenPoint: NSPoint) -> (CGRect, pid_t)? {
        guard let screen = window?.screen ?? NSScreen.main else { return nil }
        let screenMaxY = screen.frame.maxY
        let cgPoint = CGPoint(x: screenPoint.x, y: screenMaxY - screenPoint.y)

        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else { return nil }

        let ourBundle = Bundle.main.bundleIdentifier ?? ""
        for info in list {
            guard let b = info[kCGWindowBounds as String] as? [String: Any],
                  let x = b["X"] as? CGFloat, let y = b["Y"] as? CGFloat,
                  let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat else { continue }
            guard CGRect(x: x, y: y, width: w, height: h).contains(cgPoint) else { continue }
            let pid = info[kCGWindowOwnerPID as String] as? pid_t ?? 0
            guard let app = NSRunningApplication(processIdentifier: pid),
                  app.bundleIdentifier != ourBundle,
                  app.activationPolicy == .regular else { continue }
            // CG → AppKit: flip Y
            return (CGRect(x: x, y: screenMaxY - y - h, width: w, height: h), pid)
        }
        return nil
    }

    // MARK: - Window context at screen point (for drag-attach)

    private func windowContextAtPoint(_ screenPoint: NSPoint) -> PromptContext? {
        let screen = window?.screen ?? NSScreen.main
        // CGWindowList uses top-left origin; NSEvent.mouseLocation uses bottom-left
        let screenMaxY = screen?.frame.maxY ?? NSScreen.main!.frame.maxY
        let cgPoint = CGPoint(x: screenPoint.x, y: screenMaxY - screenPoint.y)

        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else { return nil }

        let ourBundle = Bundle.main.bundleIdentifier ?? ""

        for info in windowList {
            guard let b = info[kCGWindowBounds as String] as? [String: Any],
                  let x = b["X"] as? CGFloat, let y = b["Y"] as? CGFloat,
                  let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat else { continue }
            guard CGRect(x: x, y: y, width: w, height: h).contains(cgPoint) else { continue }

            let pid = info[kCGWindowOwnerPID as String] as? pid_t ?? 0
            guard let app = NSRunningApplication(processIdentifier: pid),
                  app.bundleIdentifier != ourBundle,
                  app.activationPolicy == .regular else { continue }

            return WindowContextCapture.captureActive(from: app)
        }
        return nil
    }

    // MARK: - Coordinate conversion: window (AppKit, y-up) → island coords (y-down, 0,0 = island top-left)

    func windowToIsland(_ loc: CGPoint) -> CGPoint {
        let panelH = window?.frame.height ?? 320
        let panelW = window?.frame.width  ?? 720
        let islandLeft = (panelW - IslandConst.expandedWidth) / 2
        // Island is glued to panel top; its bottom in AppKit = panelH - 176
        return CGPoint(
            x: loc.x - islandLeft,
            y: panelH - loc.y                // AppKit y is from bottom; island y from top
        )
    }

    // MARK: - Helpers

    func defaultView() -> IslandView {
        if state.pendingApproval != nil { return .approval }
        if state.pendingQuestion != nil { return .question }
        return state.tasks.isEmpty ? .empty : .overview
    }

    func baseMode() -> IslandMode {
        guard state.isPresent else { return .hidden }
        return state.tasks.isEmpty ? .hidden : .compact
    }

    // MARK: - Activity reset (call on any user interaction in island)

    func resetActivity() {
        state.lastActivity = .now
        cancelPresentationTimers()
        fsm.userInteracted()
    }

    // MARK: - Finished task pin (5.2s)

    func pinForFinished(taskId: String) {
        cancelPresentationTimers()
        state.isPinned = true
        let generation = presentationGeneration
        let item = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, !self.isCleanedUp, self.presentationGeneration == generation else { return }
                self.finishedPinTimer = nil
                self.state.removeTask(id: taskId)
                self.state.isPinned = false
                self.collapse()
            }
        }
        finishedPinTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.2, execute: item)
    }

    // MARK: - Dizzy recovery (triggered by BotEngine.slap via .botDizzy)

    private func handleDizzy() {
        guard !inputSuspended, state.isPresent else { return }
        let prevView = state.view
        expand(to: .confused)
        state.stateOverride = .dizzy
        let generation = presentationGeneration
        let recovery = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, !self.isCleanedUp, self.presentationGeneration == generation else { return }
                self.confusedRecoveryTimer = nil
                self.state.stateOverride = nil
                if self.state.view == .confused {
                    let fallback = self.state.tasks.isEmpty ? IslandView.empty : .overview
                    self.state.view = (prevView == .confused) ? fallback : prevView
                }
                NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.happy)
            }
        }
        confusedRecoveryTimer = recovery
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.3, execute: recovery)
    }

    // MARK: - Bot hit test (for slap trigger)

    private func isBotHit(_ windowPoint: CGPoint) -> Bool {
        let s = AppState.shared
        let panelH = window?.frame.height ?? 320
        let panelW = window?.frame.width  ?? 720
        let (islandW, fixedH) = islandSize(mode: s.mode, view: s.view,
                                            progress: s.uploadProgress, nw: notchW, nh: notchH)
        // Chat view resizes dynamically — must match IslandContainer.chatPromptHeight
        let islandH: CGFloat
        if s.mode == .expanded && s.view == .prompt {
            let base: CGFloat = 240
            let perMsg: CGFloat = 40
            islandH = min(300, base + CGFloat(s.chatHistory.count) * perMsg)
        } else {
            islandH = fixedH
        }
        let islandMinX = (panelW - islandW) / 2
        let (cx, cy, diameter, _) = botPosition(mode: s.mode, view: s.view,
                                                  islandW: islandW, islandH: islandH,
                                                  uploadProgress: s.uploadProgress, hasNotch: s.hasNotch)
        let radius = (diameter / 0.6) / 2
        // botPosition cy is from island TOP; panel AppKit coords have y=0 at bottom
        // island top in AppKit coords = panelH (island glued to top of panel/screen)
        let botX = islandMinX + cx
        let botY = panelH - cy
        let dx = windowPoint.x - botX
        let dy = windowPoint.y - botY
        return dx*dx + dy*dy <= radius * radius
    }

    // MARK: - Notch detection (static)

    static func notchScreen() -> NSScreen? {
        NSScreen.screens.first { $0.safeAreaInsets.top > 0 }
    }

    static func screenGeometry(for screen: NSScreen) -> IslandScreenGeometry {
        let visibleMenuBarHeight = screen.frame.maxY - screen.visibleFrame.maxY
        // visibleFrame includes the menu bar only while it is visible. Keep a
        // small resting bar when menus auto-hide or the app is in full screen.
        let menuBarHeight = visibleMenuBarHeight > 0
            ? visibleMenuBarHeight : NSStatusBar.system.thickness
        return IslandScreenGeometry(
            screenWidth: screen.frame.width, safeAreaTop: screen.safeAreaInsets.top,
            auxiliaryLeftWidth: screen.auxiliaryTopLeftArea?.width,
            auxiliaryRightWidth: screen.auxiliaryTopRightArea?.width,
            menuBarHeight: menuBarHeight
        )
    }

    override func close() {
        cleanup()
        super.close()
    }

    func cleanup() {
        guard !isCleanedUp else { return }
        isCleanedUp = true
        invalidateInput()
        frameTimer?.invalidate()
        frameTimer = nil
        viewSubscription?.cancel()
        viewSubscription = nil
        for monitor in eventMonitors { NSEvent.removeMonitor(monitor) }
        eventMonitors.removeAll()
        for (center, observer) in observers { center.removeObserver(observer) }
        observers.removeAll()
        islandPanel.onFocusChange = nil
        fsm.onTransition = nil
        fsm.onDeadlineChange = nil
        if state.islandFSM === fsm { state.islandFSM = nil }
    }
}

// MARK: - IslandPanel

final class IslandPanel: NSPanel {
    var notchWidth:  CGFloat = IslandConst.notchWidth
    var notchHeight: CGFloat = IslandConst.notchHeight
    var onFocusChange: (() -> Void)?

    override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        let changed = super.makeFirstResponder(responder)
        if changed { onFocusChange?() }
        return changed
    }

    override func becomeKey() {
        super.becomeKey()
        onFocusChange?()
    }

    override func resignKey() {
        super.resignKey()
        onFocusChange?()
    }

    override var canBecomeKey:  Bool { true }
    override var canBecomeMain: Bool { false }

    /// Allow panel to sit in the menu bar / notch area — don't let macOS push it down.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        return frameRect
    }

    func currentIslandFrame(nw: CGFloat, nh: CGFloat) -> CGRect {
        let s = AppState.shared
        let (w, fixedH) = islandSize(mode: s.mode, view: s.view,
                                      progress: s.uploadProgress, nw: nw, nh: nh)
        let h: CGFloat
        if s.mode == .expanded && s.view == .prompt {
            let base: CGFloat = 240
            let perMsg: CGFloat = 40
            h = min(300, base + CGFloat(s.chatHistory.count) * perMsg)
        } else {
            h = fixedH
        }
        return CGRect(x: (frame.width - w) / 2, y: frame.height - h, width: w, height: h)
    }
}

// MARK: - Ghost bot view (animated scale-in on appear)

struct GhostBotView: View {
    let canvasSize: CGFloat
    @State private var scale: CGFloat = 0.35

    var body: some View {
        BotCanvasView(state: AppState.shared)
            .frame(width: canvasSize, height: canvasSize)
            .scaleEffect(scale)
            .onAppear {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.55)) {
                    scale = 1.0
                }
            }
    }
}

// MARK: - Notification names

extension Notification.Name {
    static let triggerEmote     = Notification.Name("notchBuddy.triggerEmote")
    static let triggerSlap      = Notification.Name("notchBuddy.triggerSlap")
    static let botDizzy         = Notification.Name("notchBuddy.botDizzy")
    static let botGreet         = Notification.Name("notchBuddy.botGreet")
    static let botBlink         = Notification.Name("notchBuddy.botBlink")
    static let botSetTgEs       = Notification.Name("notchBuddy.botSetTgEs")
    static let botGulp          = Notification.Name("notchBuddy.botGulp")
    static let botMorphTo       = Notification.Name("notchBuddy.botMorphTo")
    static let islandAction     = Notification.Name("notchBuddy.islandAction")
    static let islandCollapse   = Notification.Name("notchBuddy.islandCollapse")
    static let openFullSettings = Notification.Name("notchBuddy.openFullSettings")
    static let hookReveal       = Notification.Name("notchBuddy.hookReveal")
    static let musicReveal      = Notification.Name("notchBuddy.musicReveal")
    // Greeting ↔ IslandWindowController
    static let greetComplete    = Notification.Name("notchBuddy.greetComplete")
    static let greetingHover    = Notification.Name("notchBuddy.greetingHover")
    static let greetingInterrupt = Notification.Name("notchBuddy.greetingInterrupt")
}

// MARK: - islandSize (takes real notch dimensions)

func islandSize(mode: IslandMode, view: IslandView,
                progress: Double = 0,
                nw: CGFloat = IslandConst.notchWidth,
                nh: CGFloat = IslandConst.notchHeight) -> (CGFloat, CGFloat) {
    switch mode {
    case .hidden:   return (nw, nh)
    case .compact:  return (nw + 160, nh)
    case .expanded:
        let layout = IslandConst.viewLayouts[view]!
        return (IslandConst.expandedWidth, layout.height)
    }
}
