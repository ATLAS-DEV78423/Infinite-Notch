import Foundation
import Darwin

@MainActor
@main
enum CPUMonitorTests {
    static func main() async {
        let cases: [(String, @MainActor () async throws -> Void)] = [
            ("idle_equals_total_ticks_is_zero_percent", idle_equals_total_ticks_is_zero_percent),
            ("zero_idle_ticks_is_full_percent", zero_idle_ticks_is_full_percent),
            ("nice_ticks_count_as_busy_time", nice_ticks_count_as_busy_time),
            ("synthetic_vector_matches_expected_percent", synthetic_vector_matches_expected_percent),
            ("zero_total_ticks_is_unavailable_not_zero", zero_total_ticks_is_unavailable_not_zero),
            ("backwards_counter_is_unavailable", backwards_counter_is_unavailable),
            ("out_of_range_input_is_clamped", out_of_range_input_is_clamped),
            ("disabled_by_default_and_never_samples", disabled_by_default_and_never_samples),
            ("interval_faster_than_one_hertz_is_refused", interval_faster_than_one_hertz_is_refused),
            ("disabled_again_refuses_to_sample", disabled_again_refuses_to_sample),
        ]
        for (name, run) in cases {
            testDiagnostic("RUN \(name)")
            do { try await run() }
            catch let error as CPUMonitorError {
                testDiagnostic("error=\(error)")
                preconditionFailure("\(name): CPU monitor check failed (\(error))")
            }
            catch { preconditionFailure("\(name): CPU monitor check failed") }
            testDiagnostic("PASS \(name)")
        }
        // INFORMATIONAL, NOT A GATE: the last two cases touch the real Mach host port. They report
        // what this machine returned and assert only what is true by construction, so an unusual
        // CPU (unusual core count, a sandboxed CI runner, a counter that resets between two reads)
        // cannot fail the build. Only a real hardware probe can confirm the live numbers.
        testDiagnostic("RUN live_host_reads_report_a_plausible_load")
        await live_host_reads_report_a_plausible_load()
        testDiagnostic("PASS live_host_reads_report_a_plausible_load")
        testDiagnostic("RUN live_host_respects_the_enforced_interval")
        await live_host_respects_the_enforced_interval()
        testDiagnostic("PASS live_host_respects_the_enforced_interval")
        print("CPU monitor: \(cases.count) gated cases passed, 2 informational host probes reported")
    }

    // MARK: - Pure arithmetic: no Mach call anywhere in this section

    static func idle_equals_total_ticks_is_zero_percent() throws {
        let previous = CPUTicks(user: 100, system: 50, idle: 850, nice: 0)
        let current = CPUTicks(user: 300, system: 150, idle: 1_700, nice: 0)
        precondition(CPUMonitor.loadPercentage(previous: previous, current: current) == 0,
                     "idle_equals_total_ticks_is_zero_percent: an all-idle delta is exactly 0%")
    }

    static func zero_idle_ticks_is_full_percent() throws {
        let previous = CPUTicks(user: 0, system: 0, idle: 900, nice: 0)
        let current = CPUTicks(user: 1_000, system: 500, idle: 900, nice: 0)
        precondition(CPUMonitor.loadPercentage(previous: previous, current: current) == 100,
                     "zero_idle_ticks_is_full_percent: no idle delta means 100% busy")
    }

    static func nice_ticks_count_as_busy_time() throws {
        // CPU_STATE_NICE is work, so it belongs in the numerator: renaming it as idle would
        // understate load.
        let previous = CPUTicks(user: 0, system: 0, idle: 0, nice: 100)
        let current = CPUTicks(user: 0, system: 0, idle: 0, nice: 300)
        precondition(CPUMonitor.loadPercentage(previous: previous, current: current) == 100,
                     "nice_ticks_count_as_busy_time: niced time is busy time")
        let mixed = CPUMonitor.loadPercentage(previous: CPUTicks(user: 0, system: 0, idle: 100, nice: 100),
                                              current: CPUTicks(user: 0, system: 0, idle: 300, nice: 100))
        precondition(mixed == 0, "a nice delta of zero must not appear in the numerator")
    }

    static func synthetic_vector_matches_expected_percent() throws {
        // Δuser 200, Δsystem 100, Δnice 0, Δidle 500 => 300 / 800 => 37.5%.
        // Stated tolerance: 1e-9 percentage points, far below any reporting precision.
        let previous = CPUTicks(user: 100, system: 50, idle: 850, nice: 0)
        let current = CPUTicks(user: 300, system: 150, idle: 1_350, nice: 0)
        guard let percent = CPUMonitor.loadPercentage(previous: previous, current: current) else {
            preconditionFailure("synthetic_vector: a forward, non-zero delta must produce a value")
        }
        precondition(abs(percent - 37.5) < 1e-9, "synthetic_vector: expected 37.5%, got \(percent)")
        // A second synthetic vector with an awkward ratio, same tolerance.
        // Δuser 1, Δsystem 1, Δnice 1, Δidle 5 => 3 / 8 => 37.5% again.
        let tiny = CPUMonitor.loadPercentage(previous: CPUTicks(user: 0, system: 0, idle: 1_000, nice: 1_000),
                                             current: CPUTicks(user: 1, system: 1, idle: 1_005, nice: 1_001))
        precondition(tiny.map { abs($0 - 37.5) < 1e-9 } ?? false,
                     "synthetic_vector: a one-tick delta must still read 37.5%, got \(String(describing: tiny))")
    }

    static func zero_total_ticks_is_unavailable_not_zero() throws {
        let previous = CPUTicks(user: 42, system: 7, idle: 900, nice: 1)
        precondition(CPUMonitor.loadPercentage(previous: previous, current: previous) == nil,
                     "zero_total_ticks: no elapsed ticks is unavailable, never 0%")
        precondition(CPUMonitor.loadPercentage(previous: .zero, current: .zero) == nil,
                     "zero_total_ticks: an empty counter pair is unavailable, never 0%")
    }

    static func backwards_counter_is_unavailable() throws {
        let previous = CPUTicks(user: 500, system: 500, idle: 500, nice: 500)
        for regressed in [CPUTicks(user: 499, system: 500, idle: 500, nice: 500),
                          CPUTicks(user: 500, system: 1, idle: 500, nice: 500),
                          CPUTicks(user: 500, system: 500, idle: 0, nice: 500),
                          CPUTicks(user: 500, system: 500, idle: 500, nice: 499)] {
            precondition(CPUMonitor.loadPercentage(previous: previous, current: regressed) == nil,
                         "backwards_counter: a counter reset is unavailable, never 0% or 100%")
        }
    }

    static func out_of_range_input_is_clamped() throws {
        precondition(CPUMonitor.clamp(-42.5) == 0, "out_of_range: a negative percentage clamps to 0")
        precondition(CPUMonitor.clamp(0) == 0 && CPUMonitor.clamp(100) == 100, "out_of_range: the endpoints pass through")
        precondition(CPUMonitor.clamp(133.7) == 100, "out_of_range: an over-100 percentage clamps to 100")
        precondition(CPUMonitor.clamp(.nan) == 0 && CPUMonitor.clamp(.infinity) == 100 && CPUMonitor.clamp(-.infinity) == 0,
                     "out_of_range: non-finite input must clamp, never propagate")
        for pair in [(previous: CPUTicks.zero, current: CPUTicks(user: 1, system: 1, idle: 1, nice: 1)),
                     (previous: CPUTicks(user: 10, system: 10, idle: 10, nice: 10),
                      current: CPUTicks(user: 20, system: 20, idle: 10, nice: 10))] {
            guard let percent = CPUMonitor.loadPercentage(previous: pair.previous, current: pair.current) else {
                preconditionFailure("out_of_range: a valid delta must produce a value")
            }
            precondition(percent >= 0 && percent <= 100, "out_of_range: every published value stays in 0...100")
        }
    }

    // MARK: - Opt-in and throttle, proven without reading the host

    static func disabled_by_default_and_never_samples() async throws {
        let monitor = CPUMonitor()
        let enabled = await monitor.isEnabled
        let first = await monitor.sample()
        let skip = await monitor.lastSkip
        let reads = await monitor.sampleCount
        precondition(!enabled, "disabled_by_default: a fresh monitor must not be sampling")
        precondition(first == nil && skip == .disabled,
                     "disabled_by_default: a disabled monitor returns nothing and says why")
        precondition(reads == 0,
                     "disabled_by_default: no host counter may be read while disabled (cost must be zero)")
    }

    static func interval_faster_than_one_hertz_is_refused() async throws {
        precondition(CPUMonitor.minimumInterval == 1, "the documented throttle floor is 1 Hz")
        for tooFast in [0.0, 0.001, 0.25, 0.5, 0.999, -1, .nan, .infinity] {
            let monitor = CPUMonitor()
            var refused = false
            do { try await monitor.enable(interval: tooFast) } catch let error as CPUMonitorError {
                refused = error == .intervalTooFast
            } catch { preconditionFailure("enable must throw only CPUMonitorError") }
            precondition(refused, "a sub-1-Hz request must be refused, not silently honoured (requested \(tooFast))")
            let enabled = await monitor.isEnabled
            let reads = await monitor.sampleCount
            precondition(!enabled && reads == 0, "a refused enable must leave the monitor off and unread")
        }
        // The floor itself is accepted, and a slower request is kept as asked.
        let fastest = CPUMonitor()
        try await fastest.enable(interval: CPUMonitor.minimumInterval)
        let fastestEnabled = await fastest.isEnabled
        let fastestInterval = await fastest.interval
        precondition(fastestEnabled && fastestInterval == 1,
                     "exactly 1 Hz is allowed and becomes the enforced interval")
        let slower = CPUMonitor()
        try await slower.enable(interval: 7.5)
        let slowerInterval = await slower.interval
        precondition(slowerInterval == 7.5, "a slower request is honoured verbatim")
    }

    static func disabled_again_refuses_to_sample() async throws {
        let monitor = CPUMonitor()
        try await monitor.enable(interval: CPUMonitor.minimumInterval)
        _ = await monitor.sample()
        await monitor.disable()
        let reads = await monitor.sampleCount
        let value = await monitor.sample()
        let skip = await monitor.lastSkip
        let later = await monitor.sampleCount
        precondition(value == nil && skip == .disabled, "disabled_again: sampling stops the moment it is switched off")
        precondition(later == reads, "disabled_again: no host counter may be read after disable()")
        let enabled = await monitor.isEnabled
        precondition(!enabled)
    }

    // MARK: - Live host probes: INFORMATIONAL, never a build gate

    static func live_host_reads_report_a_plausible_load() async {
        let monitor = CPUMonitor()
        let cores = ProcessInfo.processInfo.activeProcessorCount
        testDiagnostic("INFO active_processor_count=\(cores) processor_count=\(ProcessInfo.processInfo.processorCount)")
        do { try await monitor.enable(interval: CPUMonitor.minimumInterval) }
        catch { testDiagnostic("INFO enable_refused=\(error)"); return }
        let first = await monitor.sample()
        let warmSkip = await monitor.lastSkip
        let second = await monitor.sample(at: .now.advanced(by: .seconds(2)))
        let reads = await monitor.sampleCount
        testDiagnostic("INFO warm_up_skip=\(String(describing: warmSkip)) warm_up_value=\(String(describing: first))")
        testDiagnostic("INFO second_value=\(String(describing: second)) host_reads=\(reads)")
        if let second {
            testDiagnostic("INFO percent=\(second.percent) enforced_interval=\(second.interval)")
        }
        // Asserted unconditionally: whatever the machine answers, a sample can never be nil-valued
        // out of range, and can never report a throttle interval faster than 1 Hz.
        if let second {
            precondition(second.percent >= 0 && second.percent <= 100 && second.percent.isFinite,
                         "a live sample must stay inside 0...100 on any machine")
            precondition(second.interval >= CPUMonitor.minimumInterval,
                         "the reported interval must be the enforced one, never the requested one")
        }
        await monitor.disable()
    }

    static func live_host_respects_the_enforced_interval() async {
        let monitor = CPUMonitor()
        do { try await monitor.enable(interval: CPUMonitor.minimumInterval) }
        catch { testDiagnostic("INFO enable_refused=\(error)"); return }
        let start = ContinuousClock.now
        let first = await monitor.sample(at: start)
        let afterFirst = await monitor.sampleCount
        let early = await monitor.sample(at: start.advanced(by: .milliseconds(250)))
        let afterEarly = await monitor.sampleCount
        let earlySkip = await monitor.lastSkip
        testDiagnostic("INFO first=\(String(describing: first)) reads=\(afterFirst) "
                     + "early_attempt=\(early == nil) skip=\(String(describing: earlySkip)) reads=\(afterEarly)")
        if afterFirst > 0 { // Only meaningful once a real host read actually happened.
            precondition(early == nil && earlySkip == .throttled && afterEarly == afterFirst,
                         "live_host_respects_the_enforced_interval: a 250 ms re-read must be refused outright")
        }
        await monitor.disable()
    }
}

// Direct stderr writes are unbuffered, so the next trap cannot hide the current case name.
private func testDiagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}