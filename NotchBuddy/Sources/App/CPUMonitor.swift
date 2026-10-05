import Foundation
import Darwin

/// One system-wide CPU tick snapshot.
///
/// AGGREGATE ONLY. Every value in this file comes from a *host* counter, never from a task:
/// the only reachable Mach calls are `host_statistics64` and `host_processor_info`, and
/// `task_info` / `proc_pidinfo` / any per-process API are deliberately not called anywhere
/// here. There is no process or application inventory, and nothing here can produce one.
struct CPUTicks: Sendable, Equatable {
    var user: UInt64
    var system: UInt64
    var idle: UInt64
    var nice: UInt64

    static let zero = CPUTicks(user: 0, system: 0, idle: 0, nice: 0)
    var total: UInt64 { user + system + idle + nice }
}

enum CPUMonitorError: Error, Sendable, Equatable {
    /// A request faster than `CPUMonitor.minimumInterval` is refused, never silently honoured.
    case intervalTooFast
}

struct CPUSample: Sendable, Equatable {
    enum Source: Sendable, Equatable {
        /// `host_statistics64(host_self(), HOST_CPU_LOAD_INFO, ...)`
        case aggregate
        /// `host_processor_info(host_self(), PROCESSOR_CPU_LOAD_INFO, ...)` documented fallback.
        case perProcessorFallback
    }

    /// Busy share of the delta, clamped to 0...100.
    let percent: Double
    /// The interval actually enforced for this sample (>= `CPUMonitor.minimumInterval`).
    let interval: TimeInterval
    let source: Source
}

/// Why a `sample()` call produced no value. The read was refused or had no usable delta.
enum CPUSampleSkip: Sendable, Equatable {
    /// Sampling is off: no timer, no thread, no Mach call, no allocation.
    case disabled
    /// The previous snapshot has no delta yet (first sample after enable, or after a device change).
    case warmingUp
    /// The enforced interval has not elapsed. A faster request never gets honoured.
    case throttled
    /// Zero total ticks, or a counter that went backwards (counter reset / device change).
    case implausibleDelta
    /// The host counter itself did not answer.
    case hostUnavailable
}

/// Opt-in, throttled owner of the machine-wide CPU load.
///
/// Two hard boundaries, enforced in code rather than in prose:
///  * DISABLED COSTS ZERO. `init` allocates nothing and calls no Mach function. `sample()` returns
///    on `isEnabled` before touching a clock, a counter or the host, and no timer, thread or
///    continuation exists anywhere in this file. `sampleCount` only moves on a real host read, so
///    it is the proof that a disabled monitor performed no sampling.
///  * <= 1 Hz. `enable(interval:)` throws `CPUMonitorError.intervalTooFast` for anything faster
///    than `minimumInterval`, and `sample(at:)` additionally refuses to read again before the
///    enforced interval has elapsed, returning `CPUSampleSkip.throttled` instead of sampling.
///
/// Load is a DELTA between two host snapshots, so it cannot be read in one call. The first
/// snapshot after `enable()` (or after `invalidate()`, which the caller must invoke on a device
/// change) is a warm-up and is discarded: Apple notes property reads settle asynchronously, so
/// the first sample after start or after a device change is unreliable.
actor CPUMonitor {
    /// Hard throttle floor: at most one host read per second. A faster request is refused.
    static let minimumInterval: TimeInterval = 1
    /// Default opt-in interval. Still opt-in: sampling is never automatic.
    static let defaultInterval: TimeInterval = 2

    private(set) var isEnabled = false
    /// Number of real host counter reads. Does not move while disabled.
    private(set) var sampleCount = 0
    private(set) var lastSkip: CPUSampleSkip?
    private(set) var interval: TimeInterval = CPUMonitor.minimumInterval

    private var hostPort: port_t?
    private var previous: CPUTicks?
    private var lastSample: ContinuousClock.Instant?
    /// Consecutive aggregate readings pinned to a constant 0 or 100.
    private var degenerateRun = 0
    private var usesProcessorFallback = false

    init() {}

    /// Explicit opt-in. Nothing is read and no cadence is armed here: the first `sample()` after
    /// enabling is the warm-up snapshot.
    func enable(interval requested: TimeInterval = CPUMonitor.defaultInterval) throws {
        guard requested.isFinite, requested >= Self.minimumInterval else { throw CPUMonitorError.intervalTooFast }
        isEnabled = true
        interval = requested
        reset()
    }

    /// Off again. Releases the in-memory series; the retained host send right is kept for reuse
    /// (one right for this owner's lifetime, never re-acquired per sample).
    func disable() {
        isEnabled = false
        reset()
    }

    /// Call on a device change (CPU hot-plug, sleep/wake): the previous snapshot is no longer
    /// comparable, so the next `sample()` becomes a fresh warm-up.
    func invalidate() { reset() }

    private func reset() {
        previous = nil
        lastSample = nil
        degenerateRun = 0
        usesProcessorFallback = false
    }

    /// One throttled aggregate read. `now` is injected so the throttle is testable without sleeping.
    func sample(at now: ContinuousClock.Instant = .now) -> CPUSample? {
        guard isEnabled else { lastSkip = .disabled; return nil }
        if let lastSample, (now - lastSample) < Duration.seconds(interval) { lastSkip = .throttled; return nil }
        guard let aggregateTicks = readAggregateTicks() else { lastSkip = .hostUnavailable; return nil }
        sampleCount += 1
        lastSample = now
        guard let previous else { // Warm-up: a single snapshot has no delta to measure.
            self.previous = aggregateTicks
            lastSkip = .warmingUp
            return nil
        }

        let aggregate = Self.loadPercentage(previous: previous, current: aggregateTicks)
        // A constant 0 or 100 is what Apple's own fallbacks exist for: after two of them, ask the
        // per-CPU counter instead of trusting the aggregate path.
        degenerateRun = (aggregate.map { $0 > 0 && $0 < 100 } ?? false) ? 0 : degenerateRun + 1
        if degenerateRun >= 2 { usesProcessorFallback = true }

        if usesProcessorFallback, let fallbackTicks = readProcessorTicks(),
           let percent = Self.loadPercentage(previous: previous, current: fallbackTicks) {
            self.previous = fallbackTicks
            lastSkip = nil
            return CPUSample(percent: percent, interval: interval, source: .perProcessorFallback)
        }
        guard let aggregate else { lastSkip = .implausibleDelta; return nil }
        self.previous = aggregateTicks
        lastSkip = nil
        return CPUSample(percent: aggregate, interval: interval, source: .aggregate)
    }

    /// Pure tick maths, callable without any Mach call. The whole point of the split.
    ///
    /// Formula: `percent = 100 * (Δuser + Δsystem + Δnice) / (Δuser + Δsystem + Δnice + Δidle)`,
    /// clamped to 0...100. `nil` means "unavailable for this sample", never 0% and never 100%:
    ///  * a counter that went backwards (counter reset, or a device change since the previous
    ///    snapshot) has no comparable baseline;
    ///  * a delta of zero total ticks means no elapsed CPU time was observed at all.
    static func loadPercentage(previous: CPUTicks, current: CPUTicks) -> Double? {
        guard current.user >= previous.user, current.system >= previous.system,
              current.idle >= previous.idle, current.nice >= previous.nice else { return nil }
        let busy = (current.user - previous.user) + (current.system - previous.system) + (current.nice - previous.nice)
        let total = busy + (current.idle - previous.idle)
        guard total > 0 else { return nil }
        return clamp(Double(busy) / Double(total) * 100)
    }

    /// Single clamp point for every published percentage.
    static func clamp(_ percent: Double) -> Double {
        guard percent.isFinite else { return 0 }
        return min(100, max(0, percent))
    }

    private func acquireHostPort() -> port_t? {
        if let hostPort { return hostPort }
        // <mach/mach.h> host_self(): the NON-privileged host port, already granted to every process.
        // host_priv_self() is never used; it needs privileges this app does not want.
        // One send right is kept for this owner's lifetime: re-acquiring per sample would grow
        // port rights without bound.
        let port = host_self()
        guard port != MACH_PORT_NULL else { return nil }
        hostPort = port
        return port
    }

    /// <mach/host_info.h>: `HOST_CPU_LOAD_INFO` fills `host_cpu_load_info`, whose
    /// `cpu_ticks[CPU_STATE_MAX]` is indexed by CPU_STATE_USER / _SYSTEM / _IDLE / _NICE.
    /// These are the counters `top` derives its total from, already summed over every CPU.
    private func readAggregateTicks() -> CPUTicks? {
        guard let port = acquireHostPort() else { return nil }
        var info = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
                host_statistics64(port, HOST_CPU_LOAD_INFO, raw, &count)
            }
        }
        guard result == KERN_SUCCESS, Int(count) >= Int(CPU_STATE_MAX) else { return nil }
        // `cpu_ticks[CPU_STATE_MAX]` is a fixed-size C array, imported as a 4-tuple, laid out in
        // the documented CPU_STATE_USER / _SYSTEM / _IDLE / _NICE order.
        let ticks = info.cpu_ticks
        return CPUTicks(user: UInt64(ticks.0), system: UInt64(ticks.1), idle: UInt64(ticks.2), nice: UInt64(ticks.3))
    }

    /// <mach/host_info.h>: the documented fallback when the aggregate path reads a constant 0 or
    /// 100. Still aggregate-only — one host-wide counter per CPU, never a per-process listing.
    ///
    /// The return value is an array of `cpuCount` pointers, each into one CPU's block of
    /// `PROCESSOR_CPU_LOAD_INFO_COUNT` (`CPU_STATE_MAX`) `integer_t` in the documented
    /// USER / SYSTEM / IDLE / NICE order — the same aggregate, resolved per CPU.
    ///
    /// The aggregate blocks are still host-wide, never per-process.
    private func readProcessorTicks() -> CPUTicks? {
        guard let port = acquireHostPort() else { return nil }
        var list: processor_array_t?
        var hostInfo: UnsafeMutablePointer<integer_t>?
        // host_info_count is in/out: the request asks for CPU_STATE_MAX counters per CPU, and the
        // answer reports how many it actually wrote.
        var perCPUCount = mach_msg_type_number_t(CPU_STATE_MAX)
        var cpuCount = mach_msg_type_number_t(0)
        let result = withUnsafeMutablePointer(to: &hostInfo) { hostInfoPointer in
            withUnsafeMutablePointer(to: &list) { listPointer in
                host_processor_info(port, PROCESSOR_CPU_LOAD_INFO, hostInfoPointer, &perCPUCount, listPointer, &cpuCount)
            }
        }
        guard result == KERN_SUCCESS, let list, cpuCount > 0, Int(perCPUCount) >= Int(CPU_STATE_MAX) else { return nil }
        let stride = Int(perCPUCount)
        defer {
            // One kernel allocation: cpuCount pointers followed by cpuCount counter blocks.
            // ponytail: page-rounded in one go rather than byte-exact; a shortfall only costs a
            // still-mapped page on this rarely-taken fallback path.
            let page = getpagesize()
            let bytes = Int(cpuCount) * (MemoryLayout<UnsafeRawPointer>.stride + stride * MemoryLayout<integer_t>.stride)
            _ = vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: list)), vm_size_t((bytes + page - 1) / page * page))
        }
        // The returned pointer addresses an array of `cpuCount` per-CPU blocks. Each slot is followed
        // in memory by the next, but read them through the pointers themselves: the array is
        // the documented contract, contiguity is not.
        let blocks = UnsafeRawPointer(list).assumingMemoryBound(to: UnsafeRawPointer.self)
        var ticks = CPUTicks.zero
        for cpu in 0..<Int(cpuCount) {
            let block = blocks[cpu].assumingMemoryBound(to: integer_t.self)
            for state in 0..<stride {
                let value = UInt64(UInt32(bitPattern: block[state]))
                if state == Int(CPU_STATE_USER) { ticks.user += value }
                else if state == Int(CPU_STATE_SYSTEM) { ticks.system += value }
                else if state == Int(CPU_STATE_IDLE) { ticks.idle += value }
                else if state == Int(CPU_STATE_NICE) { ticks.nice += value }
            }
        }
        return ticks
    }
}