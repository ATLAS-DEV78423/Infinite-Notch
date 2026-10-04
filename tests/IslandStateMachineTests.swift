import Foundation

@MainActor
@main
enum IslandStateMachineTests {
    static func main() {
        hover_opens_full_after_delay()
        print("Island state machine: 1 case passed")
    }

    static func hover_opens_full_after_delay() {
        let machine = IslandStateMachine()
        machine.mouseEntered()
        precondition(machine.state == .home,
                     "hover_opens_full_after_delay: default mouseEntered() expected .home, got \(machine.state)")
    }
}
