import Foundation
import Darwin

struct PreparedFile: Sendable {
    let operationID: UUID
    let url: URL
    let name: String
    let size: UInt64
}

// Native-only receipts: no Codable/IPC path or caller-supplied cleanup authority.
struct ShelfAsset: Sendable {
    let itemID: UUID
    let operationID: UUID
    let assetID: UUID
    let name: String
    let size: UInt64
}

enum ShelfLeasePurpose: Sendable, Equatable { case drag, share, mail, transfer }

struct ShelfLease: Sendable {
    let leaseID: UUID
    let assetID: UUID
    let purpose: ShelfLeasePurpose
    let readyFile: PreparedFile
}

enum FilePreparationError: Error, Sendable, Equatable {
    case invalidSource, denied, storage, cancelled, invalidOperation, duplicateOperation, busy, capacity

    var message: String {
        switch self {
        case .invalidSource: return "Could not prepare safely. Choose one regular file without symbolic links or changes during copying."
        case .denied: return "File access was denied. Choose the file again to grant access."
        case .cancelled: return "File preparation cancelled."
        case .busy: return "Another file is still being cancelled. Try again."
        case .capacity: return "Temporary file capacity reached. Restart Coucou after finishing active actions."
        case .storage, .invalidOperation, .duplicateOperation: return "Could not prepare the file safely. Try again."
        }
    }
}

/// The same current-owner rule is used by AppState and the standalone checks.
/// No selected/original URL is admitted here: paths exist only in a ready receipt.
struct CurrentDropPreparation {
    enum Disposition { case preparing, ready, failed }
    private(set) var operationID: UUID?
    private(set) var disposition: Disposition?
    private(set) var readyFile: PreparedFile?
    var isPreparing: Bool { disposition == .preparing }

    mutating func begin(operationID: UUID) -> UUID? {
        let cancelled = clear()
        self.operationID = operationID
        disposition = .preparing
        return cancelled
    }

    mutating func complete(_ file: PreparedFile) -> Bool {
        guard operationID == file.operationID, isPreparing else { return false }
        readyFile = file
        disposition = .ready
        return true
    }

    mutating func fail(operationID: UUID) -> Bool {
        guard self.operationID == operationID, isPreparing else { return false }
        disposition = .failed
        readyFile = nil
        return true
    }

    mutating func clear() -> UUID? {
        let cancelled = isPreparing ? operationID : nil
        operationID = nil
        disposition = nil
        readyFile = nil
        return cancelled
    }
}

enum FilePreparationCheckpoint: Equatable, Sendable {
    case afterSourceFstat, afterRootRevalidate, afterOperationCreate, afterPartialCreate
    case chunk(Int), beforePublish, afterPublish, beforeLeaseDelivery
}

actor FilePreparation {
    private let storage: PreparationStorage
    private var tasks: [UUID: Task<PreparedFile, Error>] = [:]
    private var cancellation: [UUID: PreparationCancellation] = [:]
    private var retired: Set<UUID> = []
    private var revoked: Set<UUID> = []
    private var disposals: [UUID: Task<Bool, Never>] = [:]
    private struct ShelfRecord {
        let itemID: UUID
        let operationID: UUID
        var ready = false
    }
    private var assets: [UUID: ShelfRecord] = [:]
    private var items: [UUID: UUID] = [:]
    private var shelfOperations: [UUID: UUID] = [:]
    private var seenItems: Set<UUID> = []
    private var shelfAdmissionClosed = false
    // Pending acquisition pins count too: removal cannot race native namespace validation.
    private var leases: [UUID: UUID] = [:]
    private var leaseDrain: CheckedContinuation<Void, Never>?
    private var shutdownTask: Task<Void, Never>?
    private var active: UUID?
    private var admissionClosed = false
    private(set) var isShutDown = false
    private(set) var cleanupFailed = false
    private(set) var shutdownWaiterCount = 0
    var activeCount: Int { active == nil ? 0 : 1 }
    var ownedCount: Int { tasks.count }
    var retiredCount: Int { retired.count }
    var assetCount: Int { assets.count } // Includes preparing, removed-but-leased, and failed cleanup.
    var leaseCount: Int { leases.count }
    var itemCount: Int { assets.values.filter { !revoked.contains($0.operationID) }.count }

    init() { storage = PreparationStorage(root: nil, checkpoint: nil) }

    // Injection is restricted to a new, exclusively created synthetic root.
    // The bounded seam pauses the actual blocking worker, never supplies a receipt.
    init(root: URL, checkpoint: (@Sendable (FilePreparationCheckpoint) -> Void)? = nil) {
        storage = PreparationStorage(root: root, checkpoint: checkpoint)
    }

    func prepare(source: URL, operationID: UUID) async throws -> PreparedFile {
        let result = try await prepareOwned(source: source, operationID: operationID, itemID: nil)
        guard !isShutDown, !Task.isCancelled, !revoked.contains(operationID), tasks[operationID] != nil else {
            await cancel(operationID: operationID)
            throw FilePreparationError.cancelled
        }
        return result.file
    }

    func prepareShelf(source: URL, itemID: UUID, operationID: UUID) async throws -> ShelfAsset {
        let result = try await prepareOwned(source: source, operationID: operationID, itemID: itemID)
        guard let assetID = result.assetID, assets[assetID]?.ready == true,
              !isShutDown, !Task.isCancelled, !revoked.contains(operationID) else {
            await cancel(operationID: operationID)
            throw FilePreparationError.cancelled
        }
        return ShelfAsset(itemID: itemID, operationID: operationID, assetID: assetID,
                          name: result.file.name, size: result.file.size)
    }

    private func prepareOwned(source: URL, operationID: UUID, itemID: UUID?) async throws
        -> (file: PreparedFile, assetID: UUID?) {
        guard !isShutDown else { throw FilePreparationError.cancelled }
        guard valid(operationID) else { throw FilePreparationError.invalidOperation }
        guard tasks[operationID] == nil, !retired.contains(operationID) else {
            throw FilePreparationError.duplicateOperation
        }
        if let itemID {
            guard valid(itemID) else { throw FilePreparationError.invalidOperation }
            guard !seenItems.contains(itemID) else { throw FilePreparationError.duplicateOperation }
        }
        if Task.isCancelled {
            retireUnseen(operationID)
            if let itemID { rememberItem(itemID) }
            throw FilePreparationError.cancelled
        }
        guard !admissionClosed, tasks.count + retired.count < 4096 else { throw FilePreparationError.capacity }
        guard !cleanupFailed else { throw FilePreparationError.storage }
        if itemID != nil {
            guard !shelfAdmissionClosed, seenItems.count < 4096, assets.count < 32 else {
                throw FilePreparationError.capacity
            }
        }
        // ponytail: one active copy, no ingest queue; shelf admission explicitly refuses concurrent preparation.
        guard active == nil else {
            retired.insert(operationID)
            throw FilePreparationError.busy
        }
        let assetID: UUID?
        if let itemID {
            let id = UUID()
            assetID = id
            assets[id] = ShelfRecord(itemID: itemID, operationID: operationID)
            items[itemID] = id
            shelfOperations[operationID] = id
            seenItems.insert(itemID)
        } else { assetID = nil }
        let control = PreparationCancellation()
        let storage = self.storage
        let worker = Task<PreparedFile, Error> {
            try await storage.prepare(source: source, operationID: operationID, control: control)
        }
        tasks[operationID] = worker
        cancellation[operationID] = control
        active = operationID
        do {
            let file = try await withTaskCancellationHandler {
                try await worker.value
            } onCancel: { control.cancel() }
            guard !isShutDown, !Task.isCancelled, !control.isCancelled else { throw FilePreparationError.cancelled }
            if active == operationID { active = nil }
            if let assetID { assets[assetID]?.ready = true }
            return (file, assetID)
        } catch {
            revoke(operationID)
            await dispose(operationID)
            throw (error as? FilePreparationError) ?? FilePreparationError.storage
        }
    }

    func acquire(assetID: UUID, purpose: ShelfLeasePurpose) async throws -> ShelfLease {
        guard !isShutDown, !Task.isCancelled else { throw FilePreparationError.cancelled }
        guard valid(assetID), let asset = assets[assetID], asset.ready else { throw FilePreparationError.invalidOperation }
        guard !revoked.contains(asset.operationID) else { throw FilePreparationError.cancelled }
        guard !cleanupFailed else { throw FilePreparationError.storage }
        guard leases.count < 32 else { throw FilePreparationError.capacity }
        let leaseID = UUID()
        leases[leaseID] = assetID
        do {
            let file = try await storage.readyReceipt(operationID: asset.operationID)
            // Reentrancy may have revoked the item while native validation was queued.
            guard !isShutDown, !Task.isCancelled, !revoked.contains(asset.operationID), assets[assetID]?.ready == true else {
                throw FilePreparationError.cancelled
            }
            return ShelfLease(leaseID: leaseID, assetID: assetID, purpose: purpose, readyFile: file)
        } catch {
            await release(leaseID: leaseID)
            throw (error as? FilePreparationError) ?? FilePreparationError.storage
        }
    }

    func release(leaseID: UUID) async {
        guard let assetID = leases.removeValue(forKey: leaseID) else { return }
        if leases.isEmpty { let waiting = leaseDrain; leaseDrain = nil; waiting?.resume() }
        if let asset = assets[assetID], revoked.contains(asset.operationID) { await dispose(asset.operationID) }
    }

    func remove(itemID: UUID) async {
        guard valid(itemID) else { return }
        guard let assetID = items[itemID], let asset = assets[assetID] else {
            rememberItem(itemID) // Remove-before-admission is remembered, without filesystem authority.
            return
        }
        revoke(asset.operationID) // Synchronous revocation, before any worker/disposal await.
        await dispose(asset.operationID)
    }

    func cancel(operationID: UUID) async {
        guard tasks[operationID] != nil else {
            // An unseen cancellation is remembered before a late prepare can be admitted.
            // Pressure closes admission; it never evicts ready copies or old opaque IDs.
            if valid(operationID) { retireUnseen(operationID) }
            return
        }
        revoke(operationID)
        await dispose(operationID)
    }

    func shutdown() async {
        shutdownWaiterCount += 1
        defer { shutdownWaiterCount -= 1 }
        if let shutdownTask { await shutdownTask.value; return }
        isShutDown = true
        admissionClosed = true
        for id in tasks.keys { revoke(id) }
        let stopping = Task { await self.finishShutdown() }
        shutdownTask = stopping
        await stopping.value
        // A failed sweep must not be cached. The app answers a failed quit with
        // "try quitting again", and that retry has to re-run native cleanup.
        if cleanupFailed { shutdownTask = nil }
    }

    private func finishShutdown() async {
        await withCheckedContinuation { continuation in
            if leases.isEmpty { continuation.resume() }
            else { leaseDrain = continuation }
        }
        for id in Array(tasks.keys) { await dispose(id) }
        let removed = await storage.shutdown()
        cleanupFailed = cleanupFailed || !removed
        active = nil
    }

    private func revoke(_ id: UUID) {
        // Record the revocation unconditionally: dispose()'s lease early-return
        // relies on `revoked` to know a later release must finish the disposal.
        revoked.insert(id)
        cancellation[id]?.cancel()
    }

    private func dispose(_ id: UUID) async {
        guard let worker = tasks[id] else { return }
        if let assetID = shelfOperations[id], leases.values.contains(assetID) { return }
        let disposal: Task<Bool, Never>
        if let existing = disposals[id] { disposal = existing }
        else {
            let storage = self.storage
            disposal = Task { _ = await worker.result; return await storage.discard(operationID: id) }
            disposals[id] = disposal
        }
        let removed = await disposal.value
        guard tasks[id] != nil else { return } // Concurrent waiters finalize one immutable disposal result.
        if active == id { active = nil }
        if removed { retire(id) }
        else {
            cleanupFailed = true
            // Keep the task, failed disposal, asset, and anchored native authority,
            // but drop the memo so a later quit genuinely re-attempts the removal.
            disposals.removeValue(forKey: id)
        }
    }

    private func retire(_ id: UUID) {
        if let assetID = shelfOperations.removeValue(forKey: id), let asset = assets.removeValue(forKey: assetID) {
            items.removeValue(forKey: asset.itemID)
        }
        disposals.removeValue(forKey: id)
        revoked.remove(id)
        tasks.removeValue(forKey: id)
        cancellation.removeValue(forKey: id)
        retired.insert(id)
        if active == id { active = nil }
    }

    private func retireUnseen(_ id: UUID) {
        if !retired.contains(id) {
            if tasks.count + retired.count < 4096 { retired.insert(id) }
            else { admissionClosed = true }
        }
    }

    private func rememberItem(_ id: UUID) {
        if !seenItems.contains(id) {
            if seenItems.count < 4096 { seenItems.insert(id) }
            else { shelfAdmissionClosed = true } // Bound tombstones without forgetting late removals.
        }
    }

    private func valid(_ id: UUID) -> Bool { id.uuidString != "00000000-0000-0000-0000-000000000000" }
}

/// Each registry entry shares exactly one cancellation/publish boundary.
/// Streaming and validation run outside the lock; only local atomic publication holds it.
private final class PreparationCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws { if isCancelled { throw FilePreparationError.cancelled } }
    func publish(_ action: () throws -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { throw FilePreparationError.cancelled }
        try action()
    }
}

/// All mutable native handles/entries below are confined to this owned serial queue.
/// The actor retains and awaits every continuation-backed worker, including disposal.
private final class PreparationStorage: @unchecked Sendable {
    private let queue = DispatchQueue(label: "coucou.file-preparation", qos: .userInitiated)
    private let requestedRoot: URL?
    private let checkpoint: (@Sendable (FilePreparationCheckpoint) -> Void)?
    private var root: OwnedDirectory?
    private var operations: [UUID: OwnedDirectory] = [:]
    private var ready: [UUID: (file: PreparedFile, identity: stat)] = [:]

    init(root: URL?, checkpoint: (@Sendable (FilePreparationCheckpoint) -> Void)?) {
        requestedRoot = root
        self.checkpoint = checkpoint
    }

    func prepare(source: URL, operationID: UUID, control: PreparationCancellation) async throws -> PreparedFile {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do { continuation.resume(returning: try self.copy(source: source, id: operationID, control: control)) }
                catch { continuation.resume(throwing: (error as? FilePreparationError) ?? FilePreparationError.storage) }
            }
        }
    }

    func discard(operationID: UUID) async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.removeOperation(operationID)) }
        }
    }

    func readyReceipt(operationID: UUID) async throws -> PreparedFile {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    // The checkpoint is the last controlled pause before delivery,
                    // so the validating revalidation is also the delivering one.
                    self.checkpoint?(.beforeLeaseDelivery)
                    continuation.resume(returning: try self.revalidateReady(operationID))
                } catch { continuation.resume(throwing: (error as? FilePreparationError) ?? FilePreparationError.storage) }
            }
        }
    }

    private func revalidateReady(_ id: UUID) throws -> PreparedFile {
        guard let root, let directory = operations[id], let entry = ready[id] else { throw FilePreparationError.invalidOperation }
        try root.revalidate()
        try directory.revalidate()
        let delivered = try NativePath.openFile(entry.file.url)
        guard NativePath.unchanged(entry.identity, try delivered.info()),
              directory.matches(entry.file.name, entry.identity) else { throw FilePreparationError.invalidSource }
        return entry.file
    }

    func shutdown() async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async {
                // Every operation goes through the actor's shared lease-aware disposal boundary.
                // Failed entries remain owned; shutdown cannot silently free them on a second sweep.
                var removed = self.operations.isEmpty
                if let root = self.root {
                    if self.operations.isEmpty && root.remove() { self.root = nil }
                    else { removed = false }
                }
                continuation.resume(returning: removed)
            }
        }
    }

    private func copy(source: URL, id: UUID, control: PreparationCancellation) throws -> PreparedFile {
        try control.check()
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let input = try NativePath.openFile(source)
        let original = try input.info()
        guard NativePath.isRegular(original), original.st_size >= 0 else { throw FilePreparationError.invalidSource }
        checkpoint?(.afterSourceFstat)
        let name = try NativePath.components(source).last!
        if root == nil { root = try OwnedDirectory.create(at: requestedRoot ?? nativeRoot()) }
        guard let root else { throw FilePreparationError.storage }
        try root.revalidate()
        checkpoint?(.afterRootRevalidate)
        let directory = try OwnedDirectory.create(at: root.url.appendingPathComponent(id.uuidString), parent: root.fd)
        operations[id] = directory
        checkpoint?(.afterOperationCreate)
        let partialName = ".partial-\(UUID().uuidString)"
        let raw = openat(directory.fd.raw, partialName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard raw >= 0 else { throw NativePath.failure() }
        let partial = NativeFD(raw)
        let partialIdentity = try partial.info()
        guard NativePath.isRegular(partialIdentity) else { throw FilePreparationError.storage }
        directory.files[partialName] = partialIdentity
        checkpoint?(.afterPartialCreate)
        var buffer = [UInt8](repeating: 0, count: 65_536)
        var total: UInt64 = 0
        var chunks = 0
        while true {
            try control.check()
            let count = buffer.withUnsafeMutableBytes { Darwin.read(input.raw, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw NativePath.failure()
            }
            if count == 0 { break }
            total += UInt64(count)
            guard total <= UInt64(original.st_size) else { throw FilePreparationError.invalidSource }
            var written = 0
            while written < count {
                try control.check()
                let amount = buffer.withUnsafeBytes {
                    Darwin.write(partial.raw, $0.baseAddress!.advanced(by: written), count - written)
                }
                if amount < 0 && errno == EINTR { continue }
                guard amount > 0 else { throw NativePath.failure() }
                written += amount
            }
            chunks += 1
            checkpoint?(.chunk(chunks))
        }
        guard total == UInt64(original.st_size), fsync(partial.raw) == 0 else { throw FilePreparationError.storage }
        checkpoint?(.beforePublish)
        try control.check()
        // Re-open every selected-source/root ancestor without following aliases at commit.
        // The original handles remain the cleanup authority even when a parent was swapped.
        try root.revalidate()
        try directory.revalidateEntry()
        let currentSource = try NativePath.openFile(source)
        guard NativePath.unchanged(original, try input.info()),
              NativePath.unchanged(original, try currentSource.info()),
              directory.matches(partialName, partialIdentity),
              (try partial.info()).st_size == original.st_size else { throw FilePreparationError.invalidSource }
        try control.publish {
            guard renameatx_np(directory.fd.raw, partialName, directory.fd.raw, name, UInt32(RENAME_EXCL)) == 0 else {
                throw NativePath.failure()
            }
            directory.files.removeValue(forKey: partialName)
            directory.files[name] = partialIdentity
        }
        guard fsync(directory.fd.raw) == 0 else { throw FilePreparationError.storage }
        let readyURL = directory.url.appendingPathComponent(name)
        let committedIdentity = try partial.info()
        checkpoint?(.afterPublish)
        try control.check()
        // Publication is not delivery: re-open the actual returned namespace without following aliases.
        // Cleanup authority stays with the original handles even when this path is no longer usable.
        try root.revalidate()
        try directory.revalidate()
        let delivered = try NativePath.openFile(readyURL)
        guard NativePath.sameIdentity(partialIdentity, committedIdentity),
              committedIdentity.st_size == original.st_size,
              NativePath.unchanged(committedIdentity, try partial.info()),
              NativePath.unchanged(committedIdentity, try delivered.info()),
              directory.matches(name, committedIdentity) else { throw FilePreparationError.invalidSource }
        try control.check()
        let file = PreparedFile(operationID: id, url: readyURL, name: name, size: total)
        ready[id] = (file, committedIdentity)
        return file
    }

    private func removeOperation(_ id: UUID) -> Bool {
        guard let directory = operations[id] else { return true } // Unknown IDs authorize no filesystem action.
        guard directory.remove() else { return false }
        operations.removeValue(forKey: id)
        ready.removeValue(forKey: id)
        return true
    }

    private func nativeRoot() throws -> URL {
        // confstr asks Darwin, not a selected URL or caller-supplied TMPDIR.
        let count = confstr(Int32(_CS_DARWIN_USER_TEMP_DIR), nil, 0)
        guard count > 1, count <= 4096 else { throw FilePreparationError.storage }
        var path = [CChar](repeating: 0, count: count)
        guard confstr(Int32(_CS_DARWIN_USER_TEMP_DIR), &path, count) == count else { throw FilePreparationError.storage }
        // Darwin can return the system /var alias. Canonicalize only this trusted OS base
        // with POSIX realpath; Foundation's URL helper may strip /private instead.
        let basePath: String? = path.withUnsafeBufferPointer { buffer in
            guard let raw = buffer.baseAddress, let resolved = Darwin.realpath(raw, nil) else { return nil }
            defer { Darwin.free(resolved) }
            return String(cString: resolved)
        }
        guard let basePath else { throw FilePreparationError.storage }
        let base = URL(fileURLWithPath: basePath, isDirectory: true)
        return base.appendingPathComponent("coucou-preparation-\(UUID().uuidString)", isDirectory: true)
    }
}

private final class NativeFD {
    let raw: Int32
    init(_ raw: Int32) { self.raw = raw }
    deinit { Darwin.close(raw) }
    func info() throws -> stat {
        var value = stat()
        guard fstat(raw, &value) == 0 else { throw NativePath.failure() }
        return value
    }
}

private enum NativePath {
    static func failure() -> FilePreparationError {
        switch errno {
        case EACCES, EPERM: return .denied
        case ELOOP, ENOTDIR: return .invalidSource
        default: return .storage
        }
    }
    static func components(_ url: URL) throws -> [String] {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
              url.path.hasPrefix("/"), !url.path.utf8.contains(0), url.path.utf8.count <= 4096 else {
            throw FilePreparationError.invalidSource
        }
        let parts = url.path.split(separator: "/").map(String.init)
        guard !parts.isEmpty, parts.allSatisfy({ $0 != "." && $0 != ".." }) else {
            throw FilePreparationError.invalidSource
        }
        return parts
    }
    static func directory(_ parts: ArraySlice<String>) throws -> NativeFD {
        let raw = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard raw >= 0 else { throw failure() }
        var fd = NativeFD(raw)
        for part in parts {
            let next = openat(fd.raw, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
            guard next >= 0 else { throw failure() }
            fd = NativeFD(next)
        }
        return fd
    }
    static func openFile(_ url: URL) throws -> NativeFD {
        let parts = try components(url)
        let parent = try directory(parts.dropLast())
        // NONBLOCK avoids hanging on a FIFO before regular-file fstat can reject it.
        let raw = openat(parent.raw, parts.last!, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard raw >= 0 else { throw failure() }
        return NativeFD(raw)
    }
    static func sameIdentity(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino
            && (UInt32(a.st_mode) & UInt32(S_IFMT)) == (UInt32(b.st_mode) & UInt32(S_IFMT))
    }
    static func isRegular(_ value: stat) -> Bool { UInt32(value.st_mode) & UInt32(S_IFMT) == UInt32(S_IFREG) }
    static func unchanged(_ a: stat, _ b: stat) -> Bool {
        isRegular(b) && sameIdentity(a, b) && a.st_size == b.st_size
            && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec
            && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
}

private final class OwnedDirectory {
    let url: URL
    let fd: NativeFD
    private let parent: NativeFD
    private let name: String
    private let identity: stat
    var files: [String: stat] = [:]

    private init(url: URL, fd: NativeFD, parent: NativeFD, name: String, identity: stat) {
        self.url = url; self.fd = fd; self.parent = parent; self.name = name; self.identity = identity
    }
    static func create(at url: URL, parent suppliedParent: NativeFD? = nil) throws -> OwnedDirectory {
        let parts = try NativePath.components(url)
        let name = parts.last!
        let parent = try (suppliedParent ?? NativePath.directory(parts.dropLast()))
        guard mkdirat(parent.raw, name, mode_t(0o700)) == 0 else { throw NativePath.failure() }
        let raw = openat(parent.raw, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard raw >= 0 else { throw NativePath.failure() }
        let fd = NativeFD(raw)
        let info = try fd.info()
        guard info.st_uid == geteuid(), UInt32(info.st_mode) & 0o777 == 0o700 else {
            throw FilePreparationError.denied
        }
        return OwnedDirectory(url: url, fd: fd, parent: parent, name: name, identity: info)
    }
    func revalidate() throws {
        try revalidateEntry()
        let parts = try NativePath.components(url)
        let current = try NativePath.directory(parts[...])
        guard NativePath.sameIdentity(identity, try current.info()) else { throw FilePreparationError.invalidSource }
    }
    func revalidateEntry() throws {
        var current = stat()
        guard fstatat(parent.raw, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
              NativePath.sameIdentity(identity, current), current.st_uid == geteuid(),
              UInt32(current.st_mode) & 0o777 == 0o700 else { throw FilePreparationError.invalidSource }
    }
    func matches(_ name: String, _ expected: stat) -> Bool {
        var current = stat()
        return fstatat(fd.raw, name, &current, AT_SYMLINK_NOFOLLOW) == 0 && NativePath.sameIdentity(expected, current)
    }
    func remove() -> Bool {
        // No path-based recursive sweep: only registered entries relative to the retained descriptor.
        // Foreign substitutions and nonempty directories remain intact and report controlled cleanup failure.
        for name in Array(files.keys) {
            var current = stat()
            if fstatat(fd.raw, name, &current, AT_SYMLINK_NOFOLLOW) != 0 {
                if errno == ENOENT { files.removeValue(forKey: name); continue }
                return false
            }
            guard let expected = files[name], NativePath.sameIdentity(expected, current),
                  unlinkat(fd.raw, name, 0) == 0 else { return false }
            files.removeValue(forKey: name)
        }
        var current = stat()
        guard fstatat(parent.raw, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
              NativePath.sameIdentity(identity, current), unlinkat(parent.raw, name, AT_REMOVEDIR) == 0 else { return false }
        return true
    }
}
