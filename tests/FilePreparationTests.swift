import Foundation
import Darwin

@MainActor
@main
enum FilePreparationTests {
    static func main() async {
        testDiagnostic("RUN pending_after_ten_seconds_has_no_check_or_choose")
        pending_after_ten_seconds_has_no_check_or_choose()
        testDiagnostic("PASS pending_after_ten_seconds_has_no_check_or_choose")
        let cases: [(String, @MainActor () async throws -> Void)] = [
            ("basic_actor_copy_is_ready", basic_actor_copy_is_ready),
            ("concurrent_same_name_preserves_bytes", concurrent_same_name_preserves_bytes),
            ("thousand_duplicates_do_not_overwrite", thousand_duplicates_do_not_overwrite),
            ("cancel_removes_only_owned_partial", cancel_removes_only_owned_partial),
            ("failure_and_publish_collision_preserve_foreign_data", failure_and_publish_collision_preserve_foreign_data),
            ("unknown_ids_and_operation_collisions_preserve_foreign_data", unknown_ids_and_operation_collisions_preserve_foreign_data),
            ("source_root_and_ancestor_symlinks_rejected", source_root_and_ancestor_symlinks_rejected),
            ("source_and_root_swaps_before_commit_are_rejected", source_and_root_swaps_before_commit_are_rejected),
            ("ancestor_swap_after_publish_refuses_ready_receipt", ancestor_swap_after_publish_refuses_ready_receipt),
            ("mutation_does_not_publish_ready", mutation_does_not_publish_ready),
            ("invalid_reused_and_cancel_before_admit_refused", invalid_reused_and_cancel_before_admit_refused),
            ("capacity_fails_closed_without_eviction", capacity_fails_closed_without_eviction),
            ("large_copy_has_exact_bytes", large_copy_has_exact_bytes),
            ("slow_copy_has_no_ready_context", slow_copy_has_no_ready_context),
            ("replaced_drop_ignores_old_completion", replaced_drop_ignores_old_completion),
            ("cancel_and_shutdown_clear_tasks", cancel_and_shutdown_clear_tasks),
            ("failed_has_no_success", failed_has_no_success),
            ("success_after_real_completion_grows_once", success_after_real_completion_grows_once),
            ("normal_gulp_and_shrink_geometry_preserved", normal_gulp_and_shrink_geometry_preserved),
            ("sleep_catch_up_is_bounded", sleep_catch_up_is_bounded),
            ("reduced_motion_keeps_actual_readiness", reduced_motion_keeps_actual_readiness),
            ("future_lease_lifetime_remove_keeps_open_consumer_path", future_lease_lifetime_remove_keeps_open_consumer_path),
        ]
        for (name, run) in cases {
            testDiagnostic("RUN \(name)")
            do { try await run() }
            catch let error as FilePreparationError {
                testDiagnostic("checkpoint=case_execution error=\(preparationErrorCase(error))")
                preconditionFailure("\(name): synthetic file preparation check failed")
            }
            catch { preconditionFailure("\(name): synthetic file preparation check failed") }
            testDiagnostic("PASS \(name)")
        }
        print("File preparation: \(cases.count + 1) cases passed")
    }

    static func pending_after_ten_seconds_has_no_check_or_choose() {
        let engine = UploadSequenceEngine()
        engine.enterZone(x: 140, y: 90)
        engine.performDrop(uploadDuration: 2.4)

        // Elapsed animation time alone is not an I/O completion receipt.
        let frame = engine.frame(at: Date().addingTimeInterval(10))
        precondition(frame.check == 0 && frame.chooseAlpha == 0 && frame.progress < 1,
                     "pending_after_ten_seconds_has_no_check_or_choose: awaiting I/O must not show success; "
                     + "got check=\(frame.check), chooseAlpha=\(frame.chooseAlpha), progress=\(frame.progress)")
    }

    static func trusted_bases_use_posix_canonical_paths() async throws {
        let count = confstr(Int32(_CS_DARWIN_USER_TEMP_DIR), nil, 0)
        guard count > 1, count <= 4096 else { throw FilePreparationError.storage }
        var path = [CChar](repeating: 0, count: count)
        guard confstr(Int32(_CS_DARWIN_USER_TEMP_DIR), &path, count) == count else { throw FilePreparationError.storage }
        let osBase = URL(fileURLWithPath: try posixCanonicalPath(String(cString: path)), isDirectory: true)
        precondition(directoryAncestorsAreReal(osBase.path), "the POSIX OS base must contain no symbolic-link ancestors")

        // Characterize Apple's documented /private shortening without reading or modifying user files.
        var canonicalComparison = osBase
        var logicalComparison = URL(fileURLWithPath: String(cString: path), isDirectory: true).resolvingSymlinksInPath()
        if logicalComparison.path == canonicalComparison.path {
            // Some OS-selected bases have no shortened alias. /private/tmp is the fixed,
            // read-only system alias documented by Foundation's behavior.
            canonicalComparison = URL(fileURLWithPath: try posixCanonicalPath("/private/tmp"), isDirectory: true)
            logicalComparison = URL(fileURLWithPath: "/private/tmp", isDirectory: true).resolvingSymlinksInPath()
        }
        precondition(logicalComparison.path != canonicalComparison.path && !directoryAncestorsAreReal(logicalComparison.path),
                     "Foundation's shorter system alias must not be mistaken for a no-follow canonical base")
        precondition(directoryAncestorsAreReal(canonicalComparison.path))

        let f = try Fixture()
        precondition(directoryAncestorsAreReal(f.base.path), "the runner-owned fixture must remain POSIX canonical")
        let expected = Data([1, 2, 3])
        let source = try f.source("native-default.bin", expected)
        let copies = FilePreparation() // Exercises the actual trusted Darwin root selection, not root injection.
        let id = UUID()
        let receipt: PreparedFile
        do {
            receipt = try await copies.prepare(source: source, operationID: id)
        } catch {
            await copies.shutdown()
            throw error
        }
        let ownedRoot = receipt.url.deletingLastPathComponent().deletingLastPathComponent()
        let receiptMetadataValid = receipt.operationID == id && receipt.size == 3
        let rootLocationValid = ownedRoot.deletingLastPathComponent().path == osBase.path
        let receiptPathIsReal = directoryAncestorsAreReal(receipt.url.deletingLastPathComponent().path)
        let sourceData: Data
        let receiptData: Data
        do {
            sourceData = try Data(contentsOf: source)
            receiptData = try Data(contentsOf: receipt.url)
        } catch {
            await copies.shutdown()
            throw error
        }
        await copies.shutdown()
        let active = await copies.activeCount, owned = await copies.ownedCount, failedCleanup = await copies.cleanupFailed
        let rootRemoved = !FileManager.default.fileExists(atPath: ownedRoot.path)
        precondition(receiptMetadataValid)
        precondition(rootLocationValid,
                     "the native private copy root must stay under the true Darwin-selected base")
        precondition(receiptPathIsReal)
        precondition(sourceData == expected && receiptData == expected)
        precondition(active == 0 && owned == 0 && !failedCleanup)
        precondition(rootRemoved, "native shutdown must remove only its owned copy root")
    }

    static func basic_actor_copy_is_ready() async throws {
        testDiagnostic("RUN trusted_bases_use_posix_canonical_paths")
        do { try await trusted_bases_use_posix_canonical_paths() }
        catch let error as FilePreparationError {
            testDiagnostic("checkpoint=trusted_base_setup error=\(preparationErrorCase(error))")
            throw error
        }
        testDiagnostic("PASS trusted_bases_use_posix_canonical_paths")
        let f = try Fixture()
        let source = try f.source("basic.bin", Data([1, 2, 3]))
        let copies = FilePreparation(root: f.root("basic-copies"), checkpoint: { stage in
            switch stage {
            case .afterSourceFstat: testDiagnostic("SETUP after_source_fstat")
            case .afterRootRevalidate: testDiagnostic("SETUP after_root_revalidate")
            case .afterOperationCreate: testDiagnostic("SETUP after_operation_create")
            case .afterPartialCreate: testDiagnostic("SETUP after_partial_create")
            case .chunk(_), .beforePublish, .afterPublish: break
            }
        })
        let id = UUID()
        let receipt: PreparedFile
        do {
            receipt = try await copies.prepare(source: source, operationID: id)
        } catch {
            await copies.shutdown()
            throw error
        }
        let receiptMetadataValid = receipt.operationID == id && receipt.size == 3 && receipt.name == "basic.bin"
        let sourceData: Data
        let receiptData: Data
        do {
            sourceData = try Data(contentsOf: source)
            receiptData = try Data(contentsOf: receipt.url)
        } catch {
            await copies.shutdown()
            throw error
        }
        await copies.shutdown()
        precondition(receiptMetadataValid)
        precondition(sourceData == Data([1, 2, 3]) && receiptData == Data([1, 2, 3]))
    }

    static func concurrent_same_name_preserves_bytes() async throws {
        let f = try Fixture()
        let a = try f.source("a/same.bin", Data([1, 2, 3]))
        let b = try f.source("b/same.bin", Data([4, 5, 6]))
        let gate = Barrier(.chunk(1))
        let one = FilePreparation(root: f.root("one"), checkpoint: { if $0 == .chunk(1) { gate.pause() } })
        let two = FilePreparation(root: f.root("two"))
        let first = Task { try await gate.prepare(one, source: a, operationID: UUID()) }
        await gate.waitUntilPaused()
        let second = try await two.prepare(source: b, operationID: UUID())
        gate.release()
        let result = try await first.value
        precondition(result.url != second.url && result.name == second.name)
        try bytes(result.url, Data([1, 2, 3])); try bytes(second.url, Data([4, 5, 6]))
        try bytes(a, Data([1, 2, 3])); try bytes(b, Data([4, 5, 6]))
        await one.shutdown(); await two.shutdown()
    }

    static func thousand_duplicates_do_not_overwrite() async throws {
        let f = try Fixture()
        let source = try f.source("same.bin", Data([8, 9]))
        let copies = FilePreparation(root: f.root("copies"))
        var urls: Set<URL> = []
        for _ in 0...1000 {
            let result = try await copies.prepare(source: source, operationID: UUID())
            precondition(urls.insert(result.url).inserted, "exclusive operation destinations never reuse a suffix")
            try bytes(result.url, Data([8, 9]))
        }
        for url in urls { try bytes(url, Data([8, 9])) }
        try bytes(source, Data([8, 9]))
        await copies.shutdown()
        let owned = await copies.ownedCount
        precondition(owned == 0)
    }

    static func cancel_removes_only_owned_partial() async throws {
        let f = try Fixture()
        let data = Data(repeating: 7, count: 131_073)
        let source = try f.source("large.bin", data)
        let foreign = try f.source("foreign.bin", Data([22]))
        let gate = Barrier(.chunk(1))
        let root = f.root("copies")
        let copies = FilePreparation(root: root, checkpoint: { if $0 == .chunk(1) { gate.pause() } })
        let id = UUID()
        let task = Task { try await gate.prepare(copies, source: source, operationID: id) }
        await gate.waitUntilPaused()
        let owned = root.appendingPathComponent(id.uuidString)
        precondition(!FileManager.default.fileExists(atPath: owned.appendingPathComponent("large.bin").path))
        let partials = try FileManager.default.contentsOfDirectory(at: owned, includingPropertiesForKeys: nil)
        precondition(partials.count == 1)
        let firstChunk = try Data(contentsOf: partials[0])
        precondition(firstChunk.count == 65_536, "the real worker streams 64 KiB chunks")
        task.cancel() // The real prepare cancellation handler revokes the blocked worker synchronously.
        gate.release()
        await refuses { try await task.value }
        await copies.cancel(operationID: id)
        precondition(!FileManager.default.fileExists(atPath: owned.path))
        await copies.cancel(operationID: UUID())
        try bytes(source, data); try bytes(foreign, Data([22]))
        await copies.shutdown()
    }

    static func failure_and_publish_collision_preserve_foreign_data() async throws {
        let f = try Fixture()
        let root = f.root("copies")
        let source = try f.source("same.bin", Data([1]))
        let id = UUID()
        let gate = Barrier(.beforePublish)
        let copies = FilePreparation(root: root, checkpoint: { if $0 == .beforePublish { gate.pause() } })
        let task = Task { try await gate.prepare(copies, source: source, operationID: id) }
        await gate.waitUntilPaused()
        let destination = root.appendingPathComponent(id.uuidString).appendingPathComponent("same.bin")
        try Data([99]).write(to: destination)
        gate.release()
        await refuses { try await task.value }
        try bytes(source, Data([1])); try bytes(destination, Data([99]))
        await copies.shutdown()
        try bytes(destination, Data([99]))
        let failedCleanup = await copies.cleanupFailed
        precondition(failedCleanup, "foreign data blocks removal instead of gaining delete authority")
        let missing = FilePreparation(root: f.root("missing"))
        await refuses { try await missing.prepare(source: f.root("absent.bin"), operationID: UUID()) }
        await missing.shutdown()
    }

    static func source_root_and_ancestor_symlinks_rejected() async throws {
        let f = try Fixture()
        let source = try f.source("original.bin", Data([3]))
        let sourceAlias = f.root("source-alias.bin")
        try FileManager.default.createSymbolicLink(at: sourceAlias, withDestinationURL: source)
        let copies = FilePreparation(root: f.root("copies"))
        await refuses { try await copies.prepare(source: sourceAlias, operationID: UUID()) }
        let alias = f.root("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: f.base)
        await refuses { try await copies.prepare(source: alias.appendingPathComponent("original.bin"), operationID: UUID()) }
        let rootAlias = FilePreparation(root: alias)
        await refuses { try await rootAlias.prepare(source: source, operationID: UUID()) }
        let ancestorAlias = FilePreparation(root: alias.appendingPathComponent("owned"))
        await refuses { try await ancestorAlias.prepare(source: source, operationID: UUID()) }
        await refuses { try await copies.prepare(source: f.base, operationID: UUID()) }
        try bytes(source, Data([3]))
        await copies.shutdown(); await rootAlias.shutdown(); await ancestorAlias.shutdown()
    }

    static func unknown_ids_and_operation_collisions_preserve_foreign_data() async throws {
        let f = try Fixture()
        let source = try f.source("source.bin", Data([3]))
        let root = f.root("copies")
        let copies = FilePreparation(root: root)
        let ready = try await copies.prepare(source: source, operationID: UUID())
        let unknown = UUID(), collision = UUID()
        let unregistered = try f.source("copies/\(unknown.uuidString)/foreign.bin", Data([77]))
        let existing = try f.source("copies/\(collision.uuidString)/foreign.bin", Data([88]))
        await copies.cancel(operationID: unknown)
        await refuses { try await copies.prepare(source: source, operationID: unknown) }
        await refuses { try await copies.prepare(source: source, operationID: collision) }
        try bytes(unregistered, Data([77])); try bytes(existing, Data([88])); try bytes(ready.url, Data([3]))
        await copies.shutdown()
        try bytes(unregistered, Data([77])); try bytes(existing, Data([88])); try bytes(source, Data([3]))
        let failedCleanup = await copies.cleanupFailed
        precondition(failedCleanup, "unregistered directories must never be recursively swept")
    }

    static func source_and_root_swaps_before_commit_are_rejected() async throws {
        let f = try Fixture()
        let source = try f.source("source-parent/file.bin", Data([5]))
        let gate = Barrier(.beforePublish)
        let copies = FilePreparation(root: f.root("copies"), checkpoint: { if $0 == .beforePublish { gate.pause() } })
        let task = Task { try await gate.prepare(copies, source: source, operationID: UUID()) }
        await gate.waitUntilPaused()
        let originalParent = source.deletingLastPathComponent()
        let movedParent = f.root("moved-source")
        try FileManager.default.moveItem(at: originalParent, to: movedParent)
        try FileManager.default.createSymbolicLink(at: originalParent, withDestinationURL: movedParent)
        gate.release()
        await refuses { try await task.value }
        try bytes(movedParent.appendingPathComponent("file.bin"), Data([5]))
        await copies.shutdown()

        let safeSource = try f.source("safe.bin", Data([6]))
        let parent = f.root("root-parent")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        let other = try f.source("other/sentinel.bin", Data([77]))
        let rootGate = Barrier(.beforePublish)
        let rooted = FilePreparation(root: parent.appendingPathComponent("owned"), checkpoint: {
            if $0 == .beforePublish { rootGate.pause() }
        })
        let rootTask = Task { try await rootGate.prepare(rooted, source: safeSource, operationID: UUID()) }
        await rootGate.waitUntilPaused()
        let moved = f.root("moved-root-parent")
        try FileManager.default.moveItem(at: parent, to: moved)
        try FileManager.default.createSymbolicLink(at: parent, withDestinationURL: other.deletingLastPathComponent())
        rootGate.release()
        await refuses { try await rootTask.value }
        await rooted.shutdown()
        try bytes(other, Data([77])); try bytes(safeSource, Data([6]))
    }

    static func mutation_does_not_publish_ready() async throws {
        let f = try Fixture()
        let source = try f.source("mutable.bin", Data(repeating: 1, count: 65_537))
        let gate = Barrier(.beforePublish)
        let root = f.root("copies")
        let copies = FilePreparation(root: root, checkpoint: { if $0 == .beforePublish { gate.pause() } })
        let id = UUID()
        let task = Task { try await gate.prepare(copies, source: source, operationID: id) }
        await gate.waitUntilPaused()
        try Data([2]).write(to: source)
        gate.release()
        await refuses { try await task.value }
        precondition(!FileManager.default.fileExists(atPath: root.appendingPathComponent(id.uuidString).path))
        try bytes(source, Data([2]))
        await copies.shutdown()

        let timestampSource = try f.source("timestamp.bin", Data([2]))
        let stampGate = Barrier(.beforePublish)
        let stamped = FilePreparation(root: f.root("stamped"), checkpoint: { if $0 == .beforePublish { stampGate.pause() } })
        let timestampTask = Task { try await stampGate.prepare(stamped, source: timestampSource, operationID: UUID()) }
        await stampGate.waitUntilPaused()
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 100)],
                                             ofItemAtPath: timestampSource.path)
        stampGate.release()
        await refuses { try await timestampTask.value }
        try bytes(timestampSource, Data([2]))
        await stamped.shutdown()
    }

    static func ancestor_swap_after_publish_refuses_ready_receipt() async throws {
        let f = try Fixture()
        let sourceBytes = Data([1, 2, 3])
        let foreignBytes = Data([7, 8, 9])
        let source = try f.source("source.bin", sourceBytes)
        let parent = f.root("copy-parent")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        let root = parent.appendingPathComponent("owned")
        let id = UUID()
        let gate = Barrier(.afterPublish)
        let copies = FilePreparation(root: root, checkpoint: { if $0 == .afterPublish { gate.pause() } })
        var owner = CurrentDropPreparation()
        _ = owner.begin(operationID: id)
        let task = Task { try await gate.prepare(copies, source: source, operationID: id) }
        await gate.waitUntilPaused()
        defer { gate.release() }
        let receiptPath = root.appendingPathComponent(id.uuidString).appendingPathComponent("source.bin")
        try bytes(receiptPath, sourceBytes) // The actual worker has published, but has not delivered a receipt.
        precondition(owner.isPreparing && owner.readyFile == nil)
        let foreign = try f.source("foreign-parent/owned/\(id.uuidString)/source.bin", foreignBytes)
        let moved = f.root("moved-copy-parent")
        try FileManager.default.moveItem(at: parent, to: moved)
        try FileManager.default.createSymbolicLink(at: parent, withDestinationURL: f.root("foreign-parent"))
        try bytes(receiptPath, foreignBytes) // An unchecked returned URL now resolves through the substituted namespace.
        gate.release()

        var received = false
        do {
            let receipt = try await task.value
            received = true
            _ = owner.complete(receipt)
        } catch is FilePreparationError {
            precondition(owner.fail(operationID: id))
        } catch { preconditionFailure("post-publication refusal must remain a controlled error") }
        precondition(!received && owner.readyFile == nil && owner.disposition == .failed,
                     "ancestor_swap_after_publish_refuses_ready_receipt: a substituted delivered path must never become ready")
        let originalOperation = moved.appendingPathComponent("owned").appendingPathComponent(id.uuidString)
        precondition(!FileManager.default.fileExists(atPath: originalOperation.path),
                     "failed delivery removes only the operation behind the original retained handles")
        await copies.cancel(operationID: id)
        try bytes(foreign, foreignBytes); try bytes(source, sourceBytes)
        await copies.shutdown()
        precondition(!FileManager.default.fileExists(atPath: moved.appendingPathComponent("owned").path))
        let active = await copies.activeCount, owned = await copies.ownedCount, failedCleanup = await copies.cleanupFailed
        precondition(active == 0 && owned == 0 && !failedCleanup)
        try bytes(foreign, foreignBytes); try bytes(source, sourceBytes)
    }

    static func invalid_reused_and_cancel_before_admit_refused() async throws {
        let f = try Fixture()
        let source = try f.source("file.bin", Data([4]))
        let copies = FilePreparation(root: f.root("copies"))
        let zero = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
        await refuses { try await copies.prepare(source: source, operationID: zero) }
        let cancelled = UUID()
        await copies.cancel(operationID: cancelled)
        await refuses { try await copies.prepare(source: source, operationID: cancelled) }
        let beforeAdmission = UUID()
        let preCancelled = Task { try await copies.prepare(source: source, operationID: beforeAdmission) }
        preCancelled.cancel()
        await refuses { try await preCancelled.value }
        await refuses { try await copies.prepare(source: source, operationID: beforeAdmission) }
        let id = UUID()
        let ready = try await copies.prepare(source: source, operationID: id)
        await refuses { try await copies.prepare(source: source, operationID: id) }
        try bytes(ready.url, Data([4]))
        await copies.cancel(operationID: UUID())
        try bytes(ready.url, Data([4]))
        await copies.cancel(operationID: id)
        precondition(!FileManager.default.fileExists(atPath: ready.url.path))
        await refuses { try await copies.prepare(source: source, operationID: id) }
        try bytes(source, Data([4]))
        await copies.shutdown()
    }

    static func capacity_fails_closed_without_eviction() async throws {
        let f = try Fixture()
        let source = try f.source("file.bin", Data([9]))
        let copies = FilePreparation(root: f.root("copies"))
        let ready = try await copies.prepare(source: source, operationID: UUID())
        for _ in 0..<4095 { await copies.cancel(operationID: UUID()) }
        await refuses { try await copies.prepare(source: source, operationID: UUID()) }
        await copies.cancel(operationID: UUID()) // Pressure cannot make an unseen late ID admissible.
        try bytes(ready.url, Data([9])); try bytes(source, Data([9]))
        let owned = await copies.ownedCount, retired = await copies.retiredCount
        precondition(owned == 1 && owned + retired <= 4096)
        await copies.shutdown()
    }

    static func large_copy_has_exact_bytes() async throws {
        let f = try Fixture()
        let data = Data((0..<196_625).map { UInt8($0 % 251) })
        let source = try f.source("large.bin", data)
        let copies = FilePreparation(root: f.root("copies"))
        let result = try await copies.prepare(source: source, operationID: UUID())
        precondition(result.size == 196_625 && result.name == "large.bin")
        try bytes(source, data); try bytes(result.url, data)
        await copies.shutdown()
    }

    static func slow_copy_has_no_ready_context() async throws {
        let f = try Fixture()
        let source = try f.source("slow.bin", Data(repeating: 2, count: 65_537))
        let gate = Barrier(.chunk(1))
        let copies = FilePreparation(root: f.root("copies"), checkpoint: { if $0 == .chunk(1) { gate.pause() } })
        let id = UUID()
        var owner = CurrentDropPreparation()
        _ = owner.begin(operationID: id)
        let task = Task { try await gate.prepare(copies, source: source, operationID: id) }
        await gate.waitUntilPaused()
        precondition(owner.isPreparing && owner.readyFile == nil)
        await refuses { try await copies.prepare(source: source, operationID: UUID()) }
        gate.release()
        let receipt = try await task.value
        precondition(owner.complete(receipt) && owner.readyFile?.url == receipt.url)
        precondition(owner.clear() == nil, "clearing accepted ready UI does not revoke an existing action's copy")
        try bytes(receipt.url, Data(repeating: 2, count: 65_537))
        await copies.shutdown()
    }

    static func replaced_drop_ignores_old_completion() async throws {
        let f = try Fixture()
        let source = try f.source("file.bin", Data([3]))
        let copies = FilePreparation(root: f.root("copies"))
        let old = UUID(), new = UUID()
        var owner = CurrentDropPreparation()
        _ = owner.begin(operationID: old)
        let oldReceipt = try await copies.prepare(source: source, operationID: old)
        precondition(owner.begin(operationID: new) == old)
        precondition(!owner.complete(oldReceipt) && !owner.fail(operationID: old) && owner.readyFile == nil)
        await copies.cancel(operationID: old)
        let current = try await copies.prepare(source: source, operationID: new)
        precondition(owner.complete(current) && !owner.complete(current))
        precondition(owner.readyFile?.operationID == new)
        _ = owner.clear()
        precondition(!owner.complete(current) && owner.readyFile == nil)
        try bytes(current.url, Data([3]))
        await copies.shutdown()
    }

    static func cancel_and_shutdown_clear_tasks() async throws {
        let f = try Fixture()
        let source = try f.source("slow.bin", Data(repeating: 2, count: 65_537))
        let gate = Barrier(.chunk(1))
        let root = f.root("copies")
        let copies = FilePreparation(root: root, checkpoint: { if $0 == .chunk(1) { gate.pause() } })
        let task = Task { try await gate.prepare(copies, source: source, operationID: UUID()) }
        await gate.waitUntilPaused()
        let shutdown = Task { await copies.shutdown() }
        while !(await copies.isShutDown) { await Task.yield() }
        gate.release()
        await refuses { try await task.value }
        await shutdown.value
        let active = await copies.activeCount, owned = await copies.ownedCount
        precondition(active == 0 && owned == 0 && !FileManager.default.fileExists(atPath: root.path))
        try bytes(source, Data(repeating: 2, count: 65_537))
        await refuses { try await copies.prepare(source: source, operationID: UUID()) }
    }

    static func failed_has_no_success() async throws {
        let f = try Fixture()
        let copies = FilePreparation(root: f.root("copies"))
        let engine = sequence()
        let id = UUID()
        var owner = CurrentDropPreparation()
        _ = owner.begin(operationID: id)
        do {
            _ = try await copies.prepare(source: f.root("missing.bin"), operationID: id)
            preconditionFailure("missing source must fail")
        } catch is FilePreparationError {
            precondition(owner.fail(operationID: id))
            engine.finishPreparation(success: false, at: clock(10))
        } catch { preconditionFailure("failed preparation must return a controlled error") }
        engine.finishPreparation(success: true, at: clock(11))
        let frame = engine.frame(at: clock(20))
        precondition(frame.check == 0 && frame.chooseAlpha == 0 && frame.progress == 0 && frame.isFailed)
        precondition(owner.readyFile == nil && !owner.isPreparing)
        await copies.shutdown()
    }

    static func success_after_real_completion_grows_once() async throws {
        let f = try Fixture()
        let source = try f.source("file.bin", Data([1]))
        let copies = FilePreparation(root: f.root("copies"))
        let receipt = try await copies.prepare(source: source, operationID: UUID())
        try bytes(receipt.url, Data([1]))
        let engine = sequence()
        _ = engine.frame(at: clock(10))
        engine.finishPreparation(success: true, at: clock(10))
        let initial = engine.frame(at: clock(10))
        precondition(initial.progress == 1 && initial.chooseAlpha == 0 && initial.d == 14)
        let grown = engine.frame(at: clock(10.7))
        precondition(grown.chooseAlpha > 0.999 && abs(grown.d - 62) < 0.000_001)
        engine.finishPreparation(success: true, at: clock(12))
        engine.finishPreparation(success: false, at: clock(12))
        let later = engine.frame(at: clock(12))
        precondition(later.growStart == initial.growStart && later.progress == 1 && later.chooseAlpha == 1)
        engine.deactivate()
        engine.finishPreparation(success: true, at: clock(13))
        precondition(!engine.isActive)
        await copies.shutdown()
    }

    static func normal_gulp_and_shrink_geometry_preserved() async throws {
        let engine = sequence()
        let mouth = engine.frame(at: clock(0.380_001)) // just beyond canonical t_ref = 2.33
        precondition(abs(mouth.suck - 1) < 0.000_001 && !mouth.fileVisible)
        let shrink = engine.frame(at: clock(1.280_001)) // just beyond canonical t_ref = 3.23
        precondition(abs(shrink.x - 46) < 0.000_001 && abs(shrink.y - 118) < 0.000_001)
        precondition(abs(shrink.d - 14) < 0.000_001 && abs(shrink.morph) < 0.000_001)
        precondition(shrink.check == 0 && shrink.chooseAlpha == 0)
    }

    static func sleep_catch_up_is_bounded() async throws {
        let engine = sequence()
        let frame = engine.frame(at: clock(1_000_000_000))
        precondition(engine.lastSimulationStepCount <= 481, "only two seconds of simulation may catch up")
        precondition(frame.x.isFinite && frame.y.isFinite && frame.mouth.isFinite)
        precondition(frame.check == 0 && frame.chooseAlpha == 0 && frame.progress == 0)
    }

    static func reduced_motion_keeps_actual_readiness() async throws {
        let preview = UploadSequenceEngine()
        preview.enterZone(x: 140, y: 90, at: clock(0))
        let previewFrame = preview.frame(at: clock(10), reducedMotion: true)
        precondition(abs(previewFrame.morph - 1) < 0.000_001 && previewFrame.fileVisible && previewFrame.check == 0)
        let f = try Fixture()
        let source = try f.source("file.bin", Data([1]))
        let copies = FilePreparation(root: f.root("copies"))
        let engine = sequence()
        let pending = engine.frame(at: clock(10), reducedMotion: true)
        precondition(pending.progress == 0 && pending.check == 0 && pending.chooseAlpha == 0)
        _ = try await copies.prepare(source: source, operationID: UUID())
        engine.finishPreparation(success: true, at: clock(10))
        let ready = engine.frame(at: clock(10), reducedMotion: true)
        precondition(ready.progress == 1 && ready.chooseAlpha == 1 && abs(ready.d - 62) < 0.000_001)
        await copies.shutdown()
    }

    static func future_lease_lifetime_remove_keeps_open_consumer_path() async throws {
        testDiagnostic("SETUP future_lease_lifetime_exclusive_fixture")
        guard let path = ProcessInfo.processInfo.environment["COUCOU_PREPARATION_TEST_ROOT"] else {
            throw FilePreparationError.storage
        }
        let fixture = URL(fileURLWithPath: try posixCanonicalPath(path)).appendingPathComponent(UUID().uuidString)
        guard Darwin.mkdir(fixture.path, mode_t(0o700)) == 0 else { throw FilePreparationError.storage }
        defer { try? FileManager.default.removeItem(at: fixture) }
        let expected = Data([3, 1, 4, 1, 5])
        let source = fixture.appendingPathComponent("consumer.bin")
        try expected.write(to: source, options: .withoutOverwriting)
        let copies = FilePreparation(root: fixture.appendingPathComponent("copies"))
        let id = UUID()
        let readyPathPresent: Bool
        let consumed: Data?
        let original: Data
        do {
            testDiagnostic("COPY future_lease_lifetime_prepare")
            let receipt = try await copies.prepare(source: source, operationID: id)
            testDiagnostic("SETUP future_lease_lifetime_consumer_open")
            let consumer = try FileHandle(forReadingFrom: receipt.url)
            defer { try? consumer.close() }
            // Future lease-lifetime regression: this is a real open consumer, not a registered native lease.
            // Use today's real cancellation/disposal boundary until the shelf lease/remove API exists.
            testDiagnostic("REMOVE future_lease_lifetime_native_cancel")
            await copies.cancel(operationID: id)
            var info = stat()
            readyPathPresent = Darwin.lstat(receipt.url.path, &info) == 0
            consumed = try consumer.readToEnd() // Read the retained descriptor while its pathname may be gone.
            original = try Data(contentsOf: source)
        } catch {
            await copies.shutdown()
            throw error
        }
        await copies.shutdown() // Close the consumer and clean native ownership before any assertion trap.
        testDiagnostic("ASSERT future_lease_lifetime_original_untouched")
        precondition(original == expected, "future_lease_lifetime: the original bytes must remain untouched")
        testDiagnostic("ASSERT future_lease_lifetime_open_consumer_bytes")
        precondition(consumed == expected, "future_lease_lifetime: the real open consumer must still read the copied bytes")
        testDiagnostic("ASSERT future_lease_lifetime_ready_path_survives")
        precondition(readyPathPresent,
                     "future_lease_lifetime_remove_keeps_open_consumer_path: removal must retain the managed ready pathname while the native consumer is open")
    }

    static func clock(_ elapsed: Double) -> Date { Date(timeIntervalSinceReferenceDate: 1000 + elapsed) }

    static func sequence() -> UploadSequenceEngine {
        let engine = UploadSequenceEngine()
        engine.enterZone(x: 140, y: 90, at: clock(0))
        engine.performDrop(uploadDuration: 2.4, at: clock(0))
        return engine
    }

    static func bytes(_ url: URL, _ expected: Data) throws {
        let actual = try Data(contentsOf: url)
        precondition(actual == expected, "synthetic bytes must be preserved exactly")
    }

    static func refuses(_ operation: @MainActor () async throws -> PreparedFile) async {
        do { _ = try await operation(); preconditionFailure("unsafe preparation must be refused") }
        catch is FilePreparationError { }
        catch { preconditionFailure("preparation errors must be controlled, without raw filesystem diagnostics") }
    }

}

private struct Fixture {
    let base: URL
    init() throws {
        guard let path = ProcessInfo.processInfo.environment["COUCOU_PREPARATION_TEST_ROOT"] else {
            preconditionFailure("use the owned-root test runner")
        }
        // Only the runner-owned synthetic base is canonicalized, never a selected source.
        base = URL(fileURLWithPath: try posixCanonicalPath(path)).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: false)
    }
    func root(_ name: String) -> URL { base.appendingPathComponent(name) }
    func source(_ name: String, _ data: Data) throws -> URL {
        let url = root(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
        return url
    }
}

private func posixCanonicalPath(_ path: String) throws -> String {
    guard let resolved = path.withCString({ Darwin.realpath($0, nil) }) else {
        throw FilePreparationError.storage
    }
    defer { Darwin.free(resolved) }
    return String(cString: resolved)
}

// Metadata-only assertion for canonical trusted/test directories; never normalizes a selected URL.
private func directoryAncestorsAreReal(_ path: String) -> Bool {
    guard path.hasPrefix("/") else { return false }
    var ancestor = ""
    for component in path.split(separator: "/") {
        ancestor += "/" + component
        var info = stat()
        guard Darwin.lstat(ancestor, &info) == 0,
              UInt32(info.st_mode) & UInt32(S_IFMT) == UInt32(S_IFDIR) else { return false }
    }
    return true
}

// Blocks only the actual native copy worker; the MainActor awaits a signal without sleeping.
private final class Barrier: @unchecked Sendable {
    private let target: FilePreparationCheckpoint
    private let lock = NSLock()
    private let proceed = DispatchSemaphore(value: 0)
    private var entered = false
    private var didPause = false
    private var waiter: CheckedContinuation<Void, Never>?
    init(_ target: FilePreparationCheckpoint) { self.target = target }
    func prepare(_ copies: FilePreparation, source: URL, operationID: UUID) async throws -> PreparedFile {
        defer { finished() }
        do { return try await copies.prepare(source: source, operationID: operationID) }
        catch let error as FilePreparationError {
            // Report before finished() wakes the waiter: an early failure must not masquerade as a pause.
            testDiagnostic("checkpoint=\(checkpointName) reached=\(wasPaused) error=\(preparationErrorCase(error))")
            throw error
        }
    }
    private var checkpointName: String {
        switch target {
        case .afterSourceFstat: return "after_source_fstat"
        case .afterRootRevalidate: return "after_root_revalidate"
        case .afterOperationCreate: return "after_operation_create"
        case .afterPartialCreate: return "after_partial_create"
        case .chunk(let number): return "chunk_\(number)"
        case .beforePublish: return "before_publish"
        case .afterPublish: return "after_publish"
        }
    }
    func pause() {
        signal(paused: true)
        proceed.wait()
    }
    func finished() { signal(paused: false) }
    private func signal(paused: Bool) {
        lock.lock()
        entered = true
        didPause = didPause || paused
        let waiting = waiter
        waiter = nil
        lock.unlock()
        waiting?.resume()
    }
    func waitUntilPaused() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if entered { lock.unlock(); continuation.resume() }
            else { waiter = continuation; lock.unlock() }
        }
        precondition(wasPaused, "the real copy worker must reach the controlled checkpoint")
    }
    private var wasPaused: Bool { lock.lock(); defer { lock.unlock() }; return didPause }
    func release() { proceed.signal() }
}

// Direct stderr writes are unbuffered, so the next native trap cannot hide the current fixed case name.
private func testDiagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private func preparationErrorCase(_ error: FilePreparationError) -> String {
    switch error {
    case .invalidSource: return "invalidSource"
    case .denied: return "denied"
    case .storage: return "storage"
    case .cancelled: return "cancelled"
    case .invalidOperation: return "invalidOperation"
    case .duplicateOperation: return "duplicateOperation"
    case .busy: return "busy"
    case .capacity: return "capacity"
    }
}
