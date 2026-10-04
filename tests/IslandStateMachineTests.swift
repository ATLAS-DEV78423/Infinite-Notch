import Foundation

@MainActor
@main
enum IslandStateMachineTests {
    static func main() {
        let cases: [(String, @MainActor () -> Void)] = [
            ("hover_opens_full_after_delay", hover_opens_full_after_delay),
            ("leave_cancels_delayed_open", leave_cancels_delayed_open),
            ("reenter_cancels_300ms_collapse", reenter_cancels_300ms_collapse),
            ("explicit_open_keeps_autoclose", explicit_open_keeps_autoclose),
            ("holds_are_independent", holds_are_independent),
            ("cancel_invalidates_queued_callback", cancel_invalidates_queued_callback),
            ("external_open_and_hidden_sync_preserve_input", external_open_and_hidden_sync_preserve_input),
            ("hidden_click_and_hover_click_bypass_delay", hidden_click_and_hover_click_bypass_delay),
            ("entry_bookkeeping_and_deadlines_follow_holds", entry_bookkeeping_and_deadlines_follow_holds),
            ("held_greeting_leave_resumes_after_last_owner", held_greeting_leave_resumes_after_last_owner),
            ("greeting_completion_preserves_hover_intent", greeting_completion_preserves_hover_intent),
            ("every_owner_blocks_greeting_and_hide", every_owner_blocks_greeting_and_hide),
            ("hold_release_does_not_revive_cancelled_intent", hold_release_does_not_revive_cancelled_intent),
            ("hover_preference_defaults_and_clamping", hover_preference_defaults_and_clamping),
            ("countdown_uses_scheduled_deadline", countdown_uses_scheduled_deadline),
            ("activity_and_settings_replace_explicit_deadline", activity_and_settings_replace_explicit_deadline),
            ("external_compact_sync_and_canceled_hide_intent", external_compact_sync_and_canceled_hide_intent),
            ("held_delayed_open_waits_for_fresh_input", held_delayed_open_waits_for_fresh_input),
            ("external_alert_replaces_hover_origin", external_alert_replaces_hover_origin),
            ("launch_waits_for_greeting_completion", launch_waits_for_greeting_completion),
            ("hover_setting_replaces_pending_open", hover_setting_replaces_pending_open),
        ]
        for (name, run) in cases {
            run()
            print("  ✓ \(name)")
        }
        print("Island state machine: \(cases.count) cases passed")
    }

    static func hover_opens_full_after_delay() {
        let machine = IslandStateMachine()
        machine.mouseEntered()
        precondition(machine.state == .home,
                     "hover_opens_full_after_delay: default mouseEntered() expected .home, got \(machine.state)")

        let time = Clock()
        let fsm = time.makeMachine()
        fsm.hoverOpenDelayMs = 250
        fsm.mouseEntered()
        time.advance(249)
        precondition(fsm.state == .hidden)
        time.advance(1)
        precondition(fsm.state == .home)
        fsm.hiddenExternally()
        fsm.reveal()
        fsm.mouseEntered()
        time.advance(249)
        precondition(fsm.state == .petit)
        time.advance(1)
        precondition(fsm.state == .home, "compact work reveal also expands on hover")
    }

    static func leave_cancels_delayed_open() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.hoverOpenDelayMs = 250
        var transitions: [IslandStateMachine.State] = []
        fsm.onTransition = { _, to in transitions.append(to) }
        fsm.mouseEntered()
        time.advance(249)
        let opening = time.captured.last!
        fsm.mouseLeft()
        opening()
        time.advance(60_000)
        precondition(fsm.state == .hidden && transitions.isEmpty,
                     "leaving before the delay never opens, including a raced callback")
    }

    static func reenter_cancels_300ms_collapse() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.mouseEntered()
        fsm.mouseLeft()
        let oldClose = time.captured.last!
        time.advance(299)
        precondition(fsm.state == .home)
        fsm.mouseEntered()
        oldClose()
        time.advance(1000)
        precondition(fsm.state == .home)
        fsm.mouseLeft()
        oldClose()
        time.advance(299)
        precondition(fsm.state == .home)
        time.advance(1)
        precondition(fsm.state == .petit, "hover folds at the latest leave + 300 ms")
        time.advance(59_999)
        precondition(fsm.state == .petit)
        time.advance(1)
        precondition(fsm.state == .hidden)
    }

    static func explicit_open_keeps_autoclose() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.click()
        time.advance(14_999)
        precondition(fsm.state == .home)
        time.advance(1)
        precondition(fsm.state == .petit, "explicit open outside the island keeps the 15 s default")
        fsm.homeToPetitDelay = 30
        fsm.openedExternally()
        fsm.mouseEntered()
        time.advance(60_000)
        precondition(fsm.state == .home && fsm.homeCollapseAt == nil)
        fsm.mouseLeft()
        time.advance(29_999)
        precondition(fsm.state == .home)
        time.advance(1)
        precondition(fsm.state == .petit)
    }

    static func holds_are_independent() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.mouseEntered()
        for owner in IslandStateMachine.HoldOwner.allCases { fsm.setHold(owner: owner, held: true) }
        fsm.mouseLeft()
        for owner in IslandStateMachine.HoldOwner.allCases where owner != .approval {
            fsm.setHold(owner: owner, held: false)
        }
        time.advance(60_000)
        precondition(fsm.state == .home && fsm.hasHold(.approval), "approval survives every other release")
        fsm.setHold(owner: .approval, held: false)
        time.advance(299)
        precondition(fsm.state == .home)
        time.advance(1)
        precondition(fsm.state == .petit)
        for owner in IslandStateMachine.HoldOwner.allCases where owner != .approval {
            fsm.openedExternally()
            fsm.setHold(owner: owner, held: true)
            fsm.setHold(owner: .approval, held: true)
            fsm.setHold(owner: .approval, held: false)
            time.advance(60_000)
            precondition(fsm.state == .home && fsm.hasHold(owner), "\(owner) survives approval release")
            fsm.setHold(owner: owner, held: false)
            time.advance(14_999)
            precondition(fsm.state == .home)
            time.advance(1)
            precondition(fsm.state == .petit)
        }
    }

    static func cancel_invalidates_queued_callback() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.hoverOpenDelayMs = 250
        fsm.mouseEntered()
        let open = time.captured.last!
        fsm.cancelTimers()
        open()
        precondition(fsm.state == .hidden)
        fsm.mouseLeft()
        fsm.click()
        let close = time.captured.last!
        fsm.cancelTimers()
        close()
        precondition(fsm.state == .home)
        fsm.mouseLeft()
        let replacedClose = time.captured.last!
        fsm.mouseEntered()
        fsm.mouseLeft()
        replacedClose()
        precondition(fsm.state == .home)
        fsm.collapse()
        let hide = time.captured.last!
        fsm.hiddenExternally()
        fsm.reveal()
        hide()
        precondition(fsm.state == .petit)
        fsm.launch()
        fsm.greetComplete()
        let greet = time.captured.last!
        fsm.click()
        greet()
        precondition(fsm.state == .home, "old greeting cannot fold a newer explicit opening")
    }

    static func external_open_and_hidden_sync_preserve_input() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.hoverOpenDelayMs = 250
        var transitions: [IslandStateMachine.State] = []
        fsm.onTransition = { _, to in transitions.append(to) }
        fsm.mouseEntered()
        time.advance(249)
        let hover = time.captured.last!
        fsm.openedExternally()
        hover()
        precondition(fsm.state == .home && transitions.isEmpty, "external sync emits no contradictory opening")
        fsm.mouseLeft()
        let close = time.captured.last!
        fsm.hiddenExternally()
        close()
        time.advance(60_000)
        precondition(fsm.state == .hidden && transitions.isEmpty, "hidden sync cancels every old view timer")
        fsm.mouseEntered()
        time.advance(249)
        precondition(fsm.state == .hidden)
        time.advance(1)
        precondition(fsm.state == .home && transitions == [.home])
        fsm.launch()
        fsm.greetComplete()
        let greeting = time.captured.last!
        transitions.removeAll()
        fsm.openedExternally()
        greeting()
        precondition(fsm.state == .home && transitions.isEmpty)
        fsm.mouseLeft()
        time.advance(14_999)
        precondition(fsm.state == .home)
        time.advance(1)
        precondition(fsm.state == .petit)
    }

    static func hidden_click_and_hover_click_bypass_delay() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.hoverOpenDelayMs = 1000
        fsm.click()
        precondition(fsm.state == .home)
        fsm.hiddenExternally()
        fsm.hoverOpenDelayMs = 0
        fsm.mouseEntered()
        fsm.click()
        fsm.mouseLeft()
        time.advance(300)
        precondition(fsm.state == .home, "clicking a hover-open makes it explicit")
        time.advance(14_700)
        precondition(fsm.state == .petit)
    }

    static func entry_bookkeeping_and_deadlines_follow_holds() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.onTransition = { [weak fsm] _, to in
            if to == .home {
                fsm?.setHold(owner: .inspector, held: true)
                fsm?.setHold(owner: .inspector, held: false)
            }
        }
        fsm.mouseEntered()
        time.advance(60_000)
        precondition(fsm.state == .home && fsm.homeCollapseAt == nil)
        fsm.mouseLeft()
        near(fsm.homeCollapseAt!, 60.3)
        near(fsm.homeCollapseDuration, 0.3)
        let oldClose = time.captured.last!
        fsm.setHold(owner: .keyboard, held: true)
        precondition(fsm.homeCollapseAt == nil)
        oldClose()
        time.advance(50)
        fsm.setHold(owner: .keyboard, held: false)
        near(fsm.homeCollapseAt!, 60.35)
        oldClose()
        time.advance(299)
        precondition(fsm.state == .home)
        time.advance(1)
        precondition(fsm.state == .petit && fsm.homeCollapseAt == nil)
    }

    static func held_greeting_leave_resumes_after_last_owner() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.launch()
        fsm.setHold(owner: .keyboard, held: true)
        fsm.mouseEntered()
        fsm.mouseLeft()
        fsm.setHold(owner: .approval, held: true)
        fsm.setHold(owner: .drag, held: true)
        fsm.setHold(owner: .keyboard, held: false)
        fsm.setHold(owner: .drag, held: false)
        time.advance(60_000)
        precondition(fsm.state == .coucou)
        fsm.setHold(owner: .approval, held: false)
        time.advance(599)
        precondition(fsm.state == .coucou)
        time.advance(1)
        precondition(fsm.state == .petit)
    }

    static func greeting_completion_preserves_hover_intent() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.launch()
        fsm.greetComplete()
        let completion = time.captured.last!
        fsm.setHold(owner: .inspector, held: true)
        completion()
        time.advance(1000)
        precondition(fsm.state == .coucou)
        fsm.setHold(owner: .inspector, held: false)
        completion()
        time.advance(599)
        precondition(fsm.state == .coucou)
        time.advance(1)
        precondition(fsm.state == .petit)
        fsm.launch()
        fsm.mouseEntered()
        let hover = time.captured.last!
        fsm.setHold(owner: .menu, held: true)
        fsm.greetComplete()
        hover()
        time.advance(20_000)
        precondition(fsm.state == .coucou)
        fsm.setHold(owner: .menu, held: false)
        time.advance(9999)
        precondition(fsm.state == .coucou)
        time.advance(1)
        precondition(fsm.state == .petit, "release preserves 10 s hovered greeting, not 600 ms completion")
    }

    static func every_owner_blocks_greeting_and_hide() {
        let time = Clock()
        let fsm = time.makeMachine()
        for owner in IslandStateMachine.HoldOwner.allCases {
            fsm.launch()
            fsm.setHold(owner: owner, held: true)
            fsm.greetComplete()
            fsm.mouseLeft()
            time.advance(60_000)
            precondition(fsm.state == .coucou, "\(owner) protects greeting completion and leave")
            fsm.setHold(owner: owner, held: false)
            time.advance(599)
            precondition(fsm.state == .coucou)
            time.advance(1)
            precondition(fsm.state == .petit)
            let hide = time.captured.last!
            fsm.setHold(owner: owner, held: true)
            hide()
            fsm.mouseLeft()
            time.advance(60_000)
            precondition(fsm.state == .petit, "\(owner) protects compact hide")
            fsm.setHold(owner: owner, held: false)
            hide()
            time.advance(59_999)
            precondition(fsm.state == .petit)
            time.advance(1)
            precondition(fsm.state == .hidden)
        }
    }

    static func hold_release_does_not_revive_cancelled_intent() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.launch()
        fsm.greetComplete()
        let greeting = time.captured.last!
        fsm.setHold(owner: .keyboard, held: true)
        fsm.cancelTimers()
        fsm.setHold(owner: .keyboard, held: false)
        greeting()
        time.advance(20_000)
        precondition(fsm.state == .coucou)
        fsm.openedExternally()
        fsm.setHold(owner: .drag, held: true)
        fsm.cancelTimers()
        fsm.setHold(owner: .drag, held: false)
        precondition(fsm.homeCollapseAt == nil)
        time.advance(60_000)
        precondition(fsm.state == .home, "release alone cannot revive explicitly canceled home intent")
        fsm.mouseLeft()
        fsm.collapse()
        let hide = time.captured.last!
        fsm.setHold(owner: .drag, held: true)
        fsm.openedExternally()
        fsm.setHold(owner: .approval, held: true)
        fsm.setHold(owner: .drag, held: false)
        greeting()
        hide()
        time.advance(60_000)
        precondition(fsm.state == .home && fsm.hasHold(.approval))
        fsm.setHold(owner: .approval, held: false)
        time.advance(14_999)
        precondition(fsm.state == .home)
        time.advance(1)
        precondition(fsm.state == .petit)
    }

    static func hover_preference_defaults_and_clamping() {
        precondition(IslandStateMachine.validatedHoverOpenDelayMs(nil) == 0, "old defaults are immediate")
        for (stored, expected) in [(-1, 0), (250, 250), (1000, 1000), (Int.max, 1000)] {
            precondition(IslandStateMachine.validatedHoverOpenDelayMs(stored) == expected)
            let time = Clock()
            let fsm = time.makeMachine()
            fsm.hoverOpenDelayMs = stored
            fsm.mouseEntered()
            if expected > 0 {
                time.advance(expected - 1)
                precondition(fsm.state == .hidden)
                time.advance(1)
            }
            precondition(fsm.state == .home)
        }
    }

    static func countdown_uses_scheduled_deadline() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.openedExternally()
        near(fsm.homeCollapseAt!, 15)
        near(IslandStateMachine.countdownFraction(deadline: fsm.homeCollapseAt,
             duration: fsm.homeCollapseDuration, now: 0), 0)
        near(IslandStateMachine.countdownFraction(deadline: fsm.homeCollapseAt,
             duration: fsm.homeCollapseDuration, now: 10.5), 0.5)
        near(IslandStateMachine.countdownFraction(deadline: nil, duration: 15, now: 15), 0)
        fsm.hiddenExternally()
        fsm.mouseEntered()
        precondition(fsm.homeCollapseAt == nil)
        fsm.mouseLeft()
        near(fsm.homeCollapseAt!, 0.3)
        near(IslandStateMachine.countdownFraction(deadline: fsm.homeCollapseAt,
             duration: fsm.homeCollapseDuration, now: 0.21), 0.5)
        fsm.setHold(owner: .menu, held: true)
        precondition(fsm.homeCollapseAt == nil && fsm.homeCollapseDuration == 0)
        fsm.cancelTimers()
        fsm.setHold(owner: .menu, held: false)
        precondition(fsm.homeCollapseAt == nil)
    }

    static func activity_and_settings_replace_explicit_deadline() {
        let time = Clock()
        let fsm = time.makeMachine()
        var deadlines: [TimeInterval?] = []
        fsm.onDeadlineChange = { [weak fsm] in deadlines.append(fsm?.homeCollapseAt) }
        fsm.click()
        let stale = time.captured.last!
        time.advance(5000)
        fsm.userInteracted()
        near(fsm.homeCollapseAt!, 20)
        stale()
        precondition(fsm.state == .home)
        fsm.homeToPetitDelay = 30
        near(fsm.homeCollapseAt!, 35)
        fsm.setHold(owner: .keyboard, held: true)
        precondition(deadlines.last! == nil)
        fsm.setHold(owner: .keyboard, held: false)
        near(deadlines.last!!, 35)
        time.advance(29_999)
        precondition(fsm.state == .home)
        time.advance(1)
        precondition(fsm.state == .petit)
    }

    static func external_compact_sync_and_canceled_hide_intent() {
        let time = Clock()
        let fsm = time.makeMachine()
        var transitions: [IslandStateMachine.State] = []
        fsm.onTransition = { _, to in transitions.append(to) }
        fsm.collapsedExternally()
        precondition(fsm.state == .petit && transitions.isEmpty)
        let hide = time.captured.last!
        fsm.setHold(owner: .drag, held: true)
        fsm.cancelTimers()
        fsm.setHold(owner: .drag, held: false)
        hide()
        time.advance(60_000)
        precondition(fsm.state == .petit && transitions.isEmpty, "release cannot revive canceled compact intent")
        fsm.mouseEntered()
        precondition(fsm.state == .home && transitions == [.home])
    }

    static func held_delayed_open_waits_for_fresh_input() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.hoverOpenDelayMs = 250
        fsm.mouseEntered()
        let opening = time.captured.last!
        fsm.setHold(owner: .menu, held: true)
        time.advance(250)
        precondition(fsm.state == .hidden, "a delayed callback cannot replace a protected interaction")
        fsm.cancelTimers()
        fsm.setHold(owner: .menu, held: false)
        opening()
        precondition(fsm.state == .hidden)
        fsm.mouseLeft()
        fsm.mouseEntered()
        time.advance(249)
        precondition(fsm.state == .hidden)
        time.advance(1)
        precondition(fsm.state == .home)
    }

    static func external_alert_replaces_hover_origin() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.mouseEntered()
        fsm.mouseLeft()
        let hoverClose = time.captured.last!
        time.advance(100)
        fsm.openedExternally()
        hoverClose()
        near(fsm.homeCollapseAt!, 15.1)
        time.advance(14_999)
        precondition(fsm.state == .home, "an external alert on an already-open view is explicit")
        time.advance(1)
        precondition(fsm.state == .petit)
    }

    static func launch_waits_for_greeting_completion() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.launch()
        time.advance(4600)
        precondition(fsm.state == .coucou, "launch alone must not interrupt the greeting")
        fsm.greetComplete()
        time.advance(599)
        precondition(fsm.state == .coucou)
        time.advance(1)
        precondition(fsm.state == .petit)
    }

    static func hover_setting_replaces_pending_open() {
        let time = Clock()
        let fsm = time.makeMachine()
        fsm.hoverOpenDelayMs = 250
        fsm.mouseEntered()
        let oldOpen = time.captured.last!
        time.advance(100)
        fsm.hoverOpenDelayMs = 500
        oldOpen()
        time.advance(499)
        precondition(fsm.state == .hidden, "changing the preference invalidates the old queued opening")
        time.advance(1)
        precondition(fsm.state == .home)
        fsm.hiddenExternally()
        fsm.hoverOpenDelayMs = 250
        fsm.mouseEntered()
        let delayed = time.captured.last!
        fsm.hoverOpenDelayMs = 0
        delayed()
        precondition(fsm.state == .home, "changing to immediate opens without the obsolete delay")
    }

    static func near(_ actual: Double, _ expected: Double) {
        precondition(abs(actual - expected) < 0.000_001, "expected \(expected), got \(actual)")
    }

    // Only replace the external queue/clock; every assertion exercises the real FSM.
    @MainActor
    final class Clock {
        var nowMs = 0
        var nextID = 0
        var pending: [Int: (at: Int, run: IslandStateMachine.TimerAction)] = [:]
        var captured: [IslandStateMachine.TimerAction] = []

        func makeMachine() -> IslandStateMachine {
            IslandStateMachine(now: { [unowned self] in Double(self.nowMs) / 1000 },
                schedule: { [unowned self] delay, run in
                    self.nextID += 1
                    let id = self.nextID
                    self.captured.append(run)
                    self.pending[id] = (self.nowMs + Int((delay * 1000).rounded()), run)
                    return { [weak self] in _ = self?.pending.removeValue(forKey: id) }
                })
        }

        func advance(_ ms: Int) {
            let end = nowMs + ms
            while let due = pending.filter({ $0.value.at <= end }).min(by: {
                $0.value.at == $1.value.at ? $0.key < $1.key : $0.value.at < $1.value.at
            }) {
                pending.removeValue(forKey: due.key)
                nowMs = due.value.at
                due.value.run()
            }
            nowMs = end
        }
    }
}
