import Foundation
import Darwin

@MainActor
@main
enum ShelfStorageTests {
    static func main() async {
        let cases: [(String, @MainActor () async throws -> Void)] = [
            ("two_leases_keep_path_until_last_release", two_leases_keep_path_until_last_release),
            ("legacy_cancel_cannot_delete_leased_shelf_asset", legacy_cancel_cannot_delete_leased_shelf_asset),
            ("unknown_and_cross_namespace_ids_have_no_delete_authority", unknown_and_cross_namespace_ids_have_no_delete_authority),
            ("nil_duplicate_and_cancel_before_admission_ids_refused", nil_duplicate_and_cancel_before_admission_ids_refused),
            ("removed_leased_assets_count_toward_32_asset_bound", removed_leased_assets_count_toward_32_asset_bound),
            ("preparing_32nd_asset_counts_before_worker_completion", preparing_32nd_asset_counts_before_worker_completion),
            ("32_lease_bound_refuses_without_eviction", lease_bound_refuses_without_eviction),
            ("remove_before_publish_refuses_late_success", remove_before_publish_refuses_late_success),
            ("remove_after_publish_refuses_late_success", remove_after_publish_refuses_late_success),
            ("preparing_asset_is_owned_and_concurrent_copy_is_refused", preparing_asset_is_owned_and_concurrent_copy_is_refused),
            ("remove_during_acquire_revokes_delivery_and_drains_pin", remove_during_acquire_revokes_delivery_and_drains_pin),
            ("shutdown_during_acquire_drains_pending_delivery", shutdown_during_acquire_drains_pending_delivery),
            ("namespace_change_during_acquire_refuses_delivery", namespace_change_during_acquire_refuses_delivery),
            ("concurrent_shutdown_waits_for_last_lease_and_allows_remove", concurrent_shutdown_waits_for_last_lease_and_allows_remove),
            ("shutdown_revokes_preparing_worker", shutdown_revokes_preparing_worker),
            ("ready_file_replacement_retains_failed_cleanup_authority", ready_file_replacement_retains_failed_cleanup_authority),
            ("ready_symlink_replacement_preserves_foreign_file", ready_symlink_replacement_preserves_foreign_file),
            ("ready_ancestor_swap_refuses_acquire_and_cleans_anchored_owner", ready_ancestor_swap_refuses_acquire_and_cleans_anchored_owner),
            ("item_namespace_pressure_closes_admission_without_forgetting_removals", item_namespace_pressure_closes_admission_without_forgetting_removals),
            ("folder_round_trip_preserves_nested_and_empty_directories", folder_round_trip_preserves_nested_and_empty_directories),
            ("folder_4096_entries_admitted_and_4097th_refused", folder_4096_entries_admitted_and_4097th_refused),
            ("folder_depth_64_admitted_and_65_refused", folder_depth_64_admitted_and_65_refused),
            ("folder_symlink_and_special_entries_refused", folder_symlink_and_special_entries_refused),
            ("folder_symlinked_root_and_ancestor_refused", folder_symlinked_root_and_ancestor_refused),
            ("folder_existing_item_directory_refused", folder_existing_item_directory_refused),
            ("refused_folder_leaves_no_partial_tree_and_preserves_original", refused_folder_leaves_no_partial_tree_and_preserves_original),
            ("revoked_folder_copy_removes_its_partial_tree", revoked_folder_copy_removes_its_partial_tree),
            ("folder_cleanup_preserves_foreign_entries_and_reports_failure", folder_cleanup_preserves_foreign_entries_and_reports_failure),
            ("folder_and_text_ingest_refuse_concurrent_preparation", folder_and_text_ingest_refuse_concurrent_preparation),
            ("text_payload_bounds_and_utf8_are_explicit", text_payload_bounds_and_utf8_are_explicit),
            ("link_is_stored_as_text_and_never_opened", link_is_stored_as_text_and_never_opened),
        ]
        for (name, run) in cases {
            diagnostic("RUN \(name)")
            do { try await run() }
            catch { preconditionFailure("\(name): controlled synthetic shelf check failed") }
            diagnostic("PASS \(name)")
        }
        print("Shelf storage: \(cases.count) cases passed")
    }

    static func two_leases_keep_path_until_last_release() async throws {
        try await withFixture { f in
            let asset = try await f.prepare()
            precondition(asset.name == "source.bin" && asset.size == 5)
            let first = try await f.hold(asset, .drag), second = try await f.hold(asset, .share)
            precondition(first.leaseID != second.leaseID && first.assetID == asset.assetID && second.assetID == asset.assetID)
            let one = try f.open(first), two = try f.open(second)
            precondition(first.readyFile.operationID == asset.operationID && first.readyFile.size == 5)
            await f.copies.remove(itemID: asset.itemID)
            await refuses(.cancelled) { try await f.copies.acquire(assetID: asset.assetID, purpose: .mail) }
            try checkBytes(first.readyFile.url, f.expected)
            let firstBytes = try one.readToEnd()
            precondition(firstBytes == f.expected)
            try one.close()
            await f.release(first)
            await f.release(first) // Idempotent; cannot release the other registered lease.
            try checkBytes(second.readyFile.url, f.expected)
            let secondBytes = try two.readToEnd()
            precondition(secondBytes == f.expected)
            try two.close()
            await f.release(second)
            precondition(!exists(second.readyFile.url), "last release must await native disposal")
            await f.release(second)
            await f.copies.remove(itemID: asset.itemID)
            try checkBytes(f.source, f.expected)
        }
    }

    static func legacy_cancel_cannot_delete_leased_shelf_asset() async throws {
        try await withFixture { f in
            let asset = try await f.prepare(), lease = try await f.hold(asset, .transfer)
            let consumer = try f.open(lease)
            await f.copies.cancel(operationID: asset.operationID)
            await f.copies.cancel(operationID: asset.operationID)
            await f.copies.remove(itemID: asset.itemID)
            try checkBytes(lease.readyFile.url, f.expected)
            let consumed = try consumer.readToEnd()
            precondition(consumed == f.expected)
            await refuses(.cancelled) { try await f.copies.acquire(assetID: asset.assetID, purpose: .drag) }
            try consumer.close()
            await f.release(lease)
            precondition(!exists(lease.readyFile.url))
            let legacy = try await f.copies.prepare(source: f.source, operationID: UUID())
            await f.copies.cancel(operationID: legacy.operationID)
            precondition(!exists(legacy.url), "unleased legacy cancellation keeps its existing deletion contract")
        }
    }

    static func unknown_and_cross_namespace_ids_have_no_delete_authority() async throws {
        try await withFixture { f in
            let a = try await f.prepare(), b = try await f.prepare()
            let first = try await f.hold(a, .mail), second = try await f.hold(b, .share)
            precondition(first.readyFile.operationID == a.operationID && second.readyFile.operationID == b.operationID)
            precondition(first.readyFile.url != second.readyFile.url)
            let unknown = UUID()
            let foreign = f.root.appendingPathComponent(unknown.uuidString).appendingPathComponent("foreign.bin")
            try FileManager.default.createDirectory(at: foreign.deletingLastPathComponent(), withIntermediateDirectories: false)
            try Data([99]).write(to: foreign, options: .withoutOverwriting)
            for id in [unknown, a.assetID, a.operationID, first.leaseID] { await f.copies.remove(itemID: id) }
            for id in [unknown, a.itemID, a.assetID, first.leaseID] { await f.copies.cancel(operationID: id) }
            for id in [unknown, a.itemID, a.operationID, a.assetID, b.assetID] { await f.copies.release(leaseID: id) }
            await refuses(.invalidOperation) { try await f.copies.acquire(assetID: a.itemID, purpose: .drag) }
            await refuses(.invalidOperation) { try await f.copies.acquire(assetID: first.leaseID, purpose: .drag) }
            try checkBytes(first.readyFile.url, f.expected); try checkBytes(second.readyFile.url, f.expected)
            await f.copies.remove(itemID: a.itemID)
            await f.release(second) // A valid lease for B cannot unpin A.
            try checkBytes(first.readyFile.url, f.expected)
            await f.release(first)
            precondition(!exists(first.readyFile.url) && exists(second.readyFile.url))
            await f.copies.remove(itemID: b.itemID)
            await f.copies.shutdown()
            let failed = await f.copies.cleanupFailed
            precondition(failed, "unregistered foreign directory blocks root cleanup")
            try checkBytes(foreign, Data([99])); try checkBytes(f.source, f.expected)
        }
    }

    static func nil_duplicate_and_cancel_before_admission_ids_refused() async throws {
        try await withFixture { f in
            let zero = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
            await refuses(.invalidOperation) { try await f.prepare(itemID: zero) }
            await refuses(.invalidOperation) { try await f.prepare(operationID: zero) }
            await refuses(.invalidOperation) { try await f.copies.acquire(assetID: zero, purpose: .drag) }
            await f.copies.release(leaseID: zero); await f.copies.remove(itemID: zero)
            let unseenItem = UUID(), unseenOperation = UUID()
            await f.copies.remove(itemID: unseenItem)
            await refuses(.duplicateOperation) { try await f.prepare(itemID: unseenItem) }
            await f.copies.cancel(operationID: unseenOperation)
            await refuses(.duplicateOperation) { try await f.prepare(operationID: unseenOperation) }
            let cancelledItem = UUID(), cancelledOperation = UUID()
            let task = Task { try await f.prepare(itemID: cancelledItem, operationID: cancelledOperation) }
            task.cancel()
            await refuses(.cancelled) { try await task.value }
            await refuses(.duplicateOperation) { try await f.prepare(itemID: cancelledItem) }
            await refuses(.duplicateOperation) { try await f.prepare(operationID: cancelledOperation) }
            let asset = try await f.prepare()
            await refuses(.duplicateOperation) { try await f.prepare(itemID: asset.itemID) }
            await refuses(.duplicateOperation) { try await f.prepare(operationID: asset.operationID) }
            await refuses(.duplicateOperation) { try await f.copies.prepare(source: f.source, operationID: asset.operationID) }
            let lease = try await f.hold(asset, .drag)
            await f.copies.remove(itemID: asset.itemID)
            await f.release(lease)
            await refuses(.duplicateOperation) { try await f.prepare(itemID: asset.itemID) }
            await refuses(.duplicateOperation) { try await f.prepare(operationID: asset.operationID) }
            try checkBytes(f.source, f.expected)
        }
    }

    static func removed_leased_assets_count_toward_32_asset_bound() async throws {
        try await withFixture { f in
            let removed = try await f.prepare(), held = try await f.hold(removed, .drag)
            await f.copies.remove(itemID: removed.itemID)
            var leases = [held]
            for _ in 0..<31 {
                let asset = try await f.prepare()
                leases.append(try await f.hold(asset, .share))
            }
            await refuses(.capacity) { try await f.prepare() }
            let count = await f.copies.assetCount
            precondition(count == 32)
            for lease in leases { try checkBytes(lease.readyFile.url, f.expected) }
            await f.release(held)
            precondition(!exists(held.readyFile.url))
            let replacement = try await f.prepare(), replacementLease = try await f.hold(replacement, .mail)
            try checkBytes(replacementLease.readyFile.url, f.expected)
        }
    }

    static func lease_bound_refuses_without_eviction() async throws {
        try await withFixture { f in
            let asset = try await f.prepare()
            var leases: [ShelfLease] = []
            let purposes: [ShelfLeasePurpose] = [.drag, .share, .mail, .transfer]
            for index in 0..<32 {
                let lease = try await f.hold(asset, purposes[index % 4])
                _ = try f.open(lease)
                precondition(lease.purpose == purposes[index % 4])
                leases.append(lease)
            }
            await refuses(.capacity) { try await f.copies.acquire(assetID: asset.assetID, purpose: .drag) }
            await f.copies.remove(itemID: asset.itemID)
            f.closeConsumers()
            for lease in leases.dropLast() { await f.release(lease); try checkBytes(lease.readyFile.url, f.expected) }
            await f.release(leases[31])
            precondition(!exists(leases[31].readyFile.url))
            let count = await f.copies.leaseCount
            precondition(count == 0)
        }
    }

    static func preparing_32nd_asset_counts_before_worker_completion() async throws {
        let gate = CopyGate(skipping: 31)
        try await withFixture(checkpoint: { if $0 == .beforePublish { gate.pause() } }) { f in
            defer { gate.release() }
            var assets: [ShelfAsset] = []
            for _ in 0..<31 { assets.append(try await f.prepare()) }
            let item = UUID(), operation = UUID()
            let task = Task { try await gate.prepare(f.copies, source: f.source, itemID: item, operationID: operation) }
            try await gate.waitUntilPaused()
            let count = await f.copies.assetCount
            precondition(count == 32)
            await refuses(.capacity) { try await f.prepare() }
            let removing = Task { await f.copies.remove(itemID: item) }
            try await eventually { await f.copies.itemCount == 31 }
            let stillOwned = await f.copies.assetCount
            precondition(stillOwned == 32, "revoked preparing work remains charged until native disposal finishes")
            gate.release()
            await refuses(.cancelled) { try await task.value }
            await removing.value
            for asset in assets {
                let lease = try await f.hold(asset, .drag)
                try checkBytes(lease.readyFile.url, f.expected)
            }
        }
    }

    static func remove_before_publish_refuses_late_success() async throws { try await removalRace(.beforePublish) }
    static func remove_after_publish_refuses_late_success() async throws { try await removalRace(.afterPublish) }

    static func preparing_asset_is_owned_and_concurrent_copy_is_refused() async throws {
        let gate = CopyGate()
        try await withFixture(checkpoint: { if $0 == .beforePublish { gate.pause() } }) { f in
            defer { gate.release() }
            let item = UUID(), operation = UUID()
            let task = Task { try await gate.prepare(f.copies, source: f.source, itemID: item, operationID: operation) }
            try await gate.waitUntilPaused()
            let assets = await f.copies.assetCount, active = await f.copies.activeCount
            precondition(assets == 1 && active == 1)
            await refuses(.duplicateOperation) { try await f.prepare(itemID: item) }
            await refuses(.busy) { try await f.prepare() }
            gate.release()
            let asset = try await task.value, lease = try await f.hold(asset, .drag)
            try checkBytes(lease.readyFile.url, f.expected)
        }
    }

    static func removalRace(_ stage: FilePreparationCheckpoint) async throws {
        let gate = CopyGate()
        try await withFixture(checkpoint: { if $0 == stage { gate.pause() } }) { f in
            defer { gate.release() }
            let item = UUID(), operation = UUID()
            let task = Task { try await gate.prepare(f.copies, source: f.source, itemID: item, operationID: operation) }
            try await gate.waitUntilPaused()
            let ready = f.root.appendingPathComponent(operation.uuidString).appendingPathComponent("source.bin")
            if stage == .afterPublish { try checkBytes(ready, f.expected) }
            let removal = Task { await f.copies.remove(itemID: item) }
            try await eventually { await f.copies.itemCount == 0 }
            gate.release()
            await refuses(.cancelled) { try await task.value }
            await removal.value
            precondition(!exists(ready), "revoked preparation cannot deliver late success")
            await refuses(.duplicateOperation) { try await f.prepare(itemID: item) }
            await refuses(.duplicateOperation) { try await f.prepare(operationID: operation) }
            try checkBytes(f.source, f.expected)
        }
    }

    static func remove_during_acquire_revokes_delivery_and_drains_pin() async throws {
        let gate = CopyGate()
        try await withFixture(checkpoint: { if $0 == .beforeLeaseDelivery { gate.pause() } }) { f in
            defer { gate.release() }
            let asset = try await f.prepare()
            let acquisition = Task { try await gate.acquire(f.copies, assetID: asset.assetID) }
            defer { acquisition.cancel() } // Cancel before releasing the gate on throw; no unclaimed lease can leak.
            try await gate.waitUntilPaused()
            await f.copies.remove(itemID: asset.itemID) // Returns without deleting a pending acquisition's pin.
            let ready = f.root.appendingPathComponent(asset.operationID.uuidString).appendingPathComponent(asset.name)
            try checkBytes(ready, f.expected)
            gate.release()
            await refuses(.cancelled) { try await acquisition.value }
            precondition(!exists(ready))
            let count = await f.copies.leaseCount
            precondition(count == 0, "refused delivery must release its provisional native pin")
        }
    }

    static func shutdown_during_acquire_drains_pending_delivery() async throws {
        let gate = CopyGate()
        try await withFixture(checkpoint: { if $0 == .beforeLeaseDelivery { gate.pause() } }) { f in
            defer { gate.release() }
            let asset = try await f.prepare()
            let acquisition = Task { try await gate.acquire(f.copies, assetID: asset.assetID) }
            defer { acquisition.cancel() }
            try await gate.waitUntilPaused()
            let stopping = Task { await f.copies.shutdown() }
            try await eventually { await f.copies.isShutDown }
            gate.release()
            await refuses(.cancelled) { try await acquisition.value }
            await stopping.value
            precondition(!exists(f.root))
            let count = await f.copies.leaseCount
            precondition(count == 0)
        }
    }

    static func concurrent_shutdown_waits_for_last_lease_and_allows_remove() async throws {
        try await withFixture { f in
            let asset = try await f.prepare()
            let first = try await f.hold(asset, .mail), last = try await f.hold(asset, .transfer)
            let consumer = try f.open(last)
            let returned = ReturnProbe()
            let one = Task { await f.copies.shutdown(); returned.count += 1 }
            let two = Task { await f.copies.shutdown(); returned.count += 1 }
            try await eventually { await f.copies.shutdownWaiterCount >= 2 || returned.count > 0 }
            precondition(returned.count == 0, "every shutdown waiter must wait actual leases")
            await f.copies.remove(itemID: asset.itemID)
            await f.copies.cancel(operationID: asset.operationID)
            await f.copies.release(leaseID: UUID())
            await refuses(.cancelled) { try await f.prepare() }
            await refuses(.cancelled) { try await f.copies.acquire(assetID: asset.assetID, purpose: .drag) }
            await f.release(first)
            await f.release(first)
            try checkBytes(last.readyFile.url, f.expected)
            precondition(returned.count == 0)
            let consumed = try consumer.readToEnd()
            precondition(consumed == f.expected)
            try consumer.close()
            await f.release(last) // Must remain admitted while shutdown is suspended.
            await one.value; await two.value
            precondition(returned.count == 2 && !exists(f.root))
            let owned = await f.copies.ownedCount, assets = await f.copies.assetCount, leases = await f.copies.leaseCount
            precondition(owned == 0 && assets == 0 && leases == 0)
            await f.copies.shutdown()
            try checkBytes(f.source, f.expected)
        }
    }

    static func namespace_change_during_acquire_refuses_delivery() async throws {
        let gate = CopyGate()
        try await withFixture(checkpoint: { if $0 == .beforeLeaseDelivery { gate.pause() } }) { f in
            defer { gate.release() }
            let asset = try await f.prepare()
            let task = Task { try await gate.acquire(f.copies, assetID: asset.assetID) }
            defer { task.cancel() }
            try await gate.waitUntilPaused()
            let ready = f.root.appendingPathComponent(asset.operationID.uuidString).appendingPathComponent(asset.name)
            let moved = f.base.appendingPathComponent("moved-during-acquire.bin")
            try FileManager.default.moveItem(at: ready, to: moved)
            try Data([99]).write(to: ready, options: .withoutOverwriting)
            gate.release()
            await refuses(.invalidSource) { try await task.value }
            let leases = await f.copies.leaseCount
            precondition(leases == 0)
            await f.copies.shutdown()
            let failed = await f.copies.cleanupFailed, owned = await f.copies.ownedCount
            precondition(failed && owned == 1)
            try checkBytes(ready, Data([99])); try checkBytes(moved, f.expected)
            try checkBytes(f.source, f.expected)
        }
    }

    static func shutdown_revokes_preparing_worker() async throws {
        let gate = CopyGate()
        try await withFixture(checkpoint: { if $0 == .chunk(1) { gate.pause() } }) { f in
            defer { gate.release() }
            let task = Task { try await gate.prepare(f.copies, source: f.source, itemID: UUID(), operationID: UUID()) }
            try await gate.waitUntilPaused()
            let stopping = Task { await f.copies.shutdown() }
            try await eventually { await f.copies.isShutDown }
            gate.release()
            await refuses(.cancelled) { try await task.value }
            await stopping.value
            precondition(!exists(f.root))
            try checkBytes(f.source, f.expected)
        }
    }

    static func ready_file_replacement_retains_failed_cleanup_authority() async throws { try await leafSubstitution(symlink: false) }
    static func ready_symlink_replacement_preserves_foreign_file() async throws { try await leafSubstitution(symlink: true) }

    static func leafSubstitution(symlink: Bool) async throws {
        try await withFixture { f in
            let asset = try await f.prepare(), lease = try await f.hold(asset, .drag)
            let ready = lease.readyFile.url
            await f.release(lease)
            let moved = f.base.appendingPathComponent("retained-original.bin")
            try FileManager.default.moveItem(at: ready, to: moved)
            let foreign = f.base.appendingPathComponent("foreign.bin")
            try Data([99]).write(to: foreign, options: .withoutOverwriting)
            if symlink { try FileManager.default.createSymbolicLink(at: ready, withDestinationURL: foreign) }
            else { try Data([99]).write(to: ready, options: .withoutOverwriting) }
            await refuses(.invalidSource) { try await f.copies.acquire(assetID: asset.assetID, purpose: .mail) }
            await f.copies.remove(itemID: asset.itemID)
            await f.copies.shutdown()
            await f.copies.shutdown(); await f.copies.cancel(operationID: asset.operationID)
            let failed = await f.copies.cleanupFailed, owned = await f.copies.ownedCount, assets = await f.copies.assetCount
            precondition(failed && owned == 1 && assets == 1, "terminal failed cleanup must retain native owned state")
            precondition(exists(f.root) && exists(ready))
            try checkBytes(ready, Data([99])); try checkBytes(foreign, Data([99]))
            try checkBytes(moved, f.expected); try checkBytes(f.source, f.expected)
        }
    }

    static func ready_ancestor_swap_refuses_acquire_and_cleans_anchored_owner() async throws {
        try await withFixture { f in
            let asset = try await f.prepare(), lease = try await f.hold(asset, .drag)
            await f.release(lease)
            let parent = f.root.deletingLastPathComponent(), moved = f.base.appendingPathComponent("moved-parent")
            let foreignParent = f.base.appendingPathComponent("foreign-parent")
            let foreign = foreignParent.appendingPathComponent("owned").appendingPathComponent(asset.operationID.uuidString).appendingPathComponent(asset.name)
            try FileManager.default.createDirectory(at: foreign.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data([99]).write(to: foreign, options: .withoutOverwriting)
            try FileManager.default.moveItem(at: parent, to: moved)
            try FileManager.default.createSymbolicLink(at: parent, withDestinationURL: foreignParent)
            await refuses(.invalidSource) { try await f.copies.acquire(assetID: asset.assetID, purpose: .share) }
            await f.copies.remove(itemID: asset.itemID)
            await f.copies.shutdown()
            let failed = await f.copies.cleanupFailed
            precondition(!failed && !exists(moved.appendingPathComponent("owned")))
            try checkBytes(foreign, Data([99])); try checkBytes(f.source, f.expected)
        }
    }

    static func item_namespace_pressure_closes_admission_without_forgetting_removals() async throws {
        try await withFixture { f in
            // Remove-before-admission tombstones are bounded. Overflow must close
            // shelf admission rather than grow without limit, and closing
            // admission must not make the actor forget a removal it accepted.
            let tombstoned = UUID()
            for index in 0...4096 { await f.copies.remove(itemID: index == 0 ? tombstoned : UUID()) }
            await refuses(.capacity) { try await f.prepare(itemID: UUID()) }
            await f.copies.remove(itemID: tombstoned)
            try checkBytes(f.source, f.expected)
        }
    }

    static func folder_round_trip_preserves_nested_and_empty_directories() async throws {
        try await withFixture { f in
            let tree = try f.folder("tree")
            try f.write("tree/top.txt", Data([1, 2]))
            try f.write("tree/nested/inner/deep.bin", Data([9, 9, 9]))
            try f.folder("tree/nested/empty")
            let asset = try await f.prepareFolder(tree)
            precondition(asset.kind == .folder && asset.name == "tree" && asset.size == 5,
                         "a folder receipt reports its kind, its own name, and the actual streamed total")
            let lease = try await f.hold(asset, .drag), ready = lease.readyFile.url
            try checkBytes(ready.appendingPathComponent("top.txt"), Data([1, 2]))
            try checkBytes(ready.appendingPathComponent("nested/inner/deep.bin"), Data([9, 9, 9]))
            precondition(isDirectory(ready.appendingPathComponent("nested/empty")),
                         "an empty local directory must survive in the copied tree")
            precondition(exists(tree.appendingPathComponent("nested/inner/deep.bin")),
                         "the original folder is never owned by the copy")
            await f.release(lease)
            precondition(!exists(ready), "last release must remove the whole owned tree")
            try checkBytes(tree.appendingPathComponent("nested/inner/deep.bin"), Data([9, 9, 9]))
        }
    }

    static func folder_4096_entries_admitted_and_4097th_refused() async throws {
        try await withFixture { f in
            let wide = try f.folder("wide")
            for index in 0..<4_097 {
                try Data([UInt8(index % 251)]).write(to: wide.appendingPathComponent("\(index)"),
                                                    options: .withoutOverwriting)
            }
            let refused = UUID()
            await refuses(.tooManyEntries) { try await f.prepareFolder(wide, operationID: refused) }
            precondition(!exists(f.root.appendingPathComponent(refused.uuidString)),
                         "an over-count folder leaves no partial tree")
            // The ceiling admits 4096 and refuses 4097, so exactly one entry is removed and
            // the same tree is offered again rather than a second oversized tree built.
            guard Darwin.unlink(wide.appendingPathComponent("4096").path) == 0 else { throw FilePreparationError.storage }
            let asset = try await f.prepareFolder(wide)
            precondition(asset.size == 4_096, "every admitted entry contributes its actual bytes")
            let lease = try await f.hold(asset, .share)
            try checkBytes(lease.readyFile.url.appendingPathComponent("0"), Data([0]))
            try checkBytes(lease.readyFile.url.appendingPathComponent("4095"), Data([UInt8(4095 % 251)]))
            await f.copies.remove(itemID: asset.itemID)
            let failed = await f.copies.cleanupFailed
            precondition(!failed, "a refused oversized folder must clean its own partial tree")
            precondition(exists(wide.appendingPathComponent("0")), "the original tree is untouched")
            try checkBytes(wide.appendingPathComponent("4095"), Data([UInt8(4095 % 251)]))
        }
    }

    static func folder_depth_64_admitted_and_65_refused() async throws {
        try await withFixture { f in
            let deep = try f.folder("deep")
            var chain = ""
            for level in 1...64 { chain = chain.isEmpty ? "\(level)" : "\(chain)/\(level)" }
            try f.folder("deep/\(chain)")
            try f.write("deep/\(chain)/leaf.txt", Data([5]))
            let asset = try await f.prepareFolder(deep)
            precondition(asset.size == 1)
            let lease = try await f.hold(asset, .mail)
            let ready = lease.readyFile.url.appendingPathComponent(chain)
            precondition(isDirectory(ready), "a tree at the depth ceiling is copied whole")
            try checkBytes(ready.appendingPathComponent("leaf.txt"), Data([5]))
            // One level past the ceiling refuses the whole item instead of clipping it.
            try f.folder("deep/\(chain)/65")
            try f.write("deep/\(chain)/65/leaf.txt", Data([5]))
            await refuses(.tooDeep) { try await f.prepareFolder(deep) }
            precondition(exists(deep.appendingPathComponent("\(chain)/65/leaf.txt")),
                         "a refused tree keeps every original entry")
            precondition(isDirectory(lease.readyFile.url), "one refused item cannot disturb a ready neighbour")
            try checkBytes(lease.readyFile.url.appendingPathComponent("\(chain)/leaf.txt"), Data([5]))
        }
    }

    static func folder_symlink_and_special_entries_refused() async throws {
        try await withFixture { f in
            let aliased = try f.folder("aliased")
            try f.write("aliased/kept.txt", Data([7]))
            try f.write("outside.txt", Data([1]))
            try f.symlink("aliased/alias.txt", to: f.base.appendingPathComponent("outside.txt"))
            let aliasOperation = UUID()
            await refuses(.unsupportedEntry) { try await f.prepareFolder(aliased, operationID: aliasOperation) }
            precondition(!exists(f.root.appendingPathComponent(aliasOperation.uuidString)))
            let piped = try f.folder("piped")
            try f.write("piped/kept.txt", Data([7]))
            try f.fifo("piped/pipe")
            let pipeOperation = UUID()
            await refuses(.unsupportedEntry) { try await f.prepareFolder(piped, operationID: pipeOperation) }
            precondition(!exists(f.root.appendingPathComponent(pipeOperation.uuidString)))
            // Refused, not skipped: the entry that caused each refusal is still in the original.
            try checkBytes(aliased.appendingPathComponent("kept.txt"), Data([7]))
            try checkBytes(aliased.appendingPathComponent("alias.txt"), Data([1]))
            try checkBytes(piped.appendingPathComponent("kept.txt"), Data([7]))
            precondition(exists(piped.appendingPathComponent("pipe")), "a refused FIFO stays in the original tree")
            let failed = await f.copies.cleanupFailed
            precondition(!failed, "a refused folder cleans its own partial tree")
        }
    }

    static func folder_symlinked_root_and_ancestor_refused() async throws {
        try await withFixture { f in
            try f.write("real/tree/kept.txt", Data([7]))
            let real = f.base.appendingPathComponent("real/tree")
            let alias = f.base.appendingPathComponent("alias-tree")
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
            let aliasOperation = UUID()
            await refuses(.invalidSource) { try await f.prepareFolder(alias, operationID: aliasOperation) }
            let ancestor = f.base.appendingPathComponent("ancestor")
            try FileManager.default.createSymbolicLink(at: ancestor, withDestinationURL: f.base.appendingPathComponent("real"))
            let ancestorOperation = UUID()
            await refuses(.invalidSource) {
                try await f.prepareFolder(ancestor.appendingPathComponent("tree"), operationID: ancestorOperation)
            }
            // A refused root never creates an owned directory at all.
            precondition(!exists(f.root.appendingPathComponent(aliasOperation.uuidString)))
            precondition(!exists(f.root.appendingPathComponent(ancestorOperation.uuidString)))
            try checkBytes(real.appendingPathComponent("kept.txt"), Data([7]))
        }
    }

    static func folder_existing_item_directory_refused() async throws {
        try await withFixture { f in
            let tree = try f.folder("tree")
            try f.write("tree/kept.txt", Data([7]))
            // One real preparation first, so the owned root the foreign claim lands in is real.
            let seed = try await f.prepareFolder(tree)
            let operation = UUID()
            // Pre-claim the exact operation directory this preparation will ask for: publication
            // refuses an existing name outright, never reuses it and never adds a suffix.
            let claimed = f.root.appendingPathComponent(operation.uuidString)
            guard Darwin.mkdir(claimed.path, mode_t(0o700)) == 0 else { throw FilePreparationError.storage }
            try Data([99]).write(to: claimed.appendingPathComponent("foreign.txt"), options: .withoutOverwriting)
            await refuses(.alreadyExists) { try await f.prepareFolder(tree, operationID: operation) }
            try checkBytes(claimed.appendingPathComponent("foreign.txt"), Data([99]))
            try checkBytes(tree.appendingPathComponent("kept.txt"), Data([7]))
            await f.copies.remove(itemID: seed.itemID)
            await f.copies.shutdown()
            let failed = await f.copies.cleanupFailed
            precondition(failed, "a foreign operation directory is preserved and reported as failed cleanup")
            try checkBytes(claimed.appendingPathComponent("foreign.txt"), Data([99]))
        }
    }

    static func refused_folder_leaves_no_partial_tree_and_preserves_original() async throws {
        try await withFixture { f in
            let tree = try f.folder("tree")
            try f.write("tree/kept.txt", Data([7]))
            try f.write("tree/nested/inner.txt", Data([8, 8]))
            try f.write("outside.txt", Data([1]))
            try f.symlink("tree/nested/alias.txt", to: f.base.appendingPathComponent("outside.txt"))
            let before = try snapshot(tree)
            let operation = UUID()
            await refuses(.unsupportedEntry) { try await f.prepareFolder(tree, operationID: operation) }
            precondition(!exists(f.root.appendingPathComponent(operation.uuidString)),
                         "a refused folder must leave no ready partial tree")
            let failed = await f.copies.cleanupFailed
            precondition(!failed, "a refused folder removes the partial tree it did build")
            let after = try snapshot(tree)
            precondition(before == after, "the original folder must be preserved completely")
        }
    }

    static func revoked_folder_copy_removes_its_partial_tree() async throws {
        let gate = CopyGate()
        try await withFixture(checkpoint: { if $0 == .chunk(1) { gate.pause() } }) { f in
            defer { gate.release() }
            let tree = try f.folder("tree")
            try f.write("tree/only.bin", Data(repeating: 4, count: 300_000))
            let before = try snapshot(tree)
            let item = UUID(), operation = UUID()
            let task = Task { try await gate.prepareFolder(f.copies, source: tree, itemID: item, operationID: operation) }
            try await gate.waitUntilPaused()
            // A real paused worker really does own a staged tree before it is finished.
            let owned = f.root.appendingPathComponent(operation.uuidString)
            let staged = (try? FileManager.default.contentsOfDirectory(atPath: owned.appendingPathComponent("tree").path)) ?? []
            precondition(staged.contains { $0.hasPrefix(".partial-") }, "a paused folder copy owns a staged payload")
            let removing = Task { await f.copies.remove(itemID: item) }
            try await eventually { await f.copies.itemCount == 0 }
            gate.release()
            await refuses(.cancelled) { try await task.value }
            await removing.value
            precondition(!exists(owned), "a revoked folder copy must remove its partial tree")
            let after = try snapshot(tree)
            precondition(before == after, "revoking a folder copy leaves the original tree untouched")
        }
    }

    static func folder_cleanup_preserves_foreign_entries_and_reports_failure() async throws {
        try await withFixture { f in
            let tree = try f.folder("tree")
            try f.write("tree/kept.txt", Data([7]))
            let asset = try await f.prepareFolder(tree), lease = try await f.hold(asset, .drag)
            let ready = lease.readyFile.url
            await f.release(lease)
            // Planted inside a ready tree: neither the new leaf nor the new subtree is registered,
            // so cleanup must keep both and report failure rather than sweeping them.
            let leaf = ready.appendingPathComponent("planted.txt")
            try Data([99]).write(to: leaf, options: .withoutOverwriting)
            let nested = ready.appendingPathComponent("foreign/leaf.txt")
            try FileManager.default.createDirectory(at: nested.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try Data([98]).write(to: nested, options: .withoutOverwriting)
            await f.copies.remove(itemID: asset.itemID)
            await f.copies.shutdown()
            let failed = await f.copies.cleanupFailed, owned = await f.copies.ownedCount
            precondition(failed && owned == 1, "a nonempty foreign tree retains failed cleanup authority")
            precondition(exists(ready), "the owned folder root stays for its retained handles")
            try checkBytes(leaf, Data([99])); try checkBytes(nested, Data([98]))
            try checkBytes(tree.appendingPathComponent("kept.txt"), Data([7]))
        }
    }

    static func folder_and_text_ingest_refuse_concurrent_preparation() async throws {
        let gate = CopyGate()
        try await withFixture(checkpoint: { if $0 == .chunk(1) { gate.pause() } }) { f in
            defer { gate.release() }
            let tree = try f.folder("tree")
            try f.write("tree/only.bin", Data(repeating: 4, count: 200_000))
            let item = UUID(), operation = UUID()
            let task = Task { try await gate.prepareFolder(f.copies, source: tree, itemID: item, operationID: operation) }
            try await gate.waitUntilPaused()
            // Folders and text share the one active copy refusal and the item registry:
            // no ingest queue is introduced for either new kind.
            await refuses(.busy) { try await f.prepareText(Data("blocked".utf8)) }
            await refuses(.duplicateOperation) { try await f.prepareText(Data("blocked".utf8), itemID: item) }
            gate.release()
            let asset = try await task.value
            precondition(asset.kind == .folder, "the paused folder preparation still delivers its own kind")
            let lease = try await f.hold(asset, .transfer)
            try checkBytes(lease.readyFile.url.appendingPathComponent("only.bin"), Data(repeating: 4, count: 200_000))
        }
    }

    static func text_payload_bounds_and_utf8_are_explicit() async throws {
        try await withFixture { f in
            let body = Data(String(repeating: "a", count: 1 << 20).utf8)
            let asset = try await f.prepareText(body, name: "note")
            precondition(asset.kind == .text && asset.name == "note.txt" && asset.size == UInt64(1 << 20),
                         "a payload at exactly 1 MiB is admitted as an explicit .txt asset")
            let lease = try await f.hold(asset, .drag)
            let stored = try Data(contentsOf: lease.readyFile.url)
            precondition(stored == body, "the payload is stored exactly as supplied, never truncated")
            await f.release(lease)
            await f.copies.remove(itemID: asset.itemID)
            // One byte over the ceiling and an undecodable payload are both refused explicitly.
            await refuses(.textTooLarge) { try await f.prepareText(body + Data([97])) }
            await refuses(.invalidText) { try await f.prepareText(Data([0xFF, 0xFE, 0xFD])) }
            await refuses(.invalidSource) { try await f.prepareText(Data("x".utf8), name: "../escape") }
            await f.copies.shutdown()
            let assets = await f.copies.assetCount, owned = await f.copies.ownedCount
            let failed = await f.copies.cleanupFailed
            precondition(assets == 0 && owned == 0 && !failed, "every refused payload leaves no owned state")
            precondition(!exists(f.root), "a text-only run still cleans its own root")
        }
    }

    static func link_is_stored_as_text_and_never_opened() async throws {
        try await withFixture { f in
            guard let target = URL(string: "https://example.com/notes/page?q=1#top") else {
                throw FilePreparationError.storage
            }
            let asset = try await f.prepareLink(target)
            precondition(asset.kind == .link && asset.name == "link.txt"
                         && asset.size == UInt64(target.absoluteString.utf8.count),
                         "a link is a distinct kind stored as its own URL text")
            let lease = try await f.hold(asset, .drag)
            let stored = try Data(contentsOf: lease.readyFile.url)
            // The only bytes that exist are the URL the user supplied. Nothing in the owner
            // resolves, fetches, or launches a link, so there is nothing else to assert.
            precondition(String(data: stored, encoding: .utf8) == target.absoluteString,
                         "a link payload must be exactly the supplied URL text")
            await f.release(lease)
            await f.copies.remove(itemID: asset.itemID)
            try checkBytes(f.source, f.expected)
        }
    }

    private static func withFixture(checkpoint: (@Sendable (FilePreparationCheckpoint) -> Void)? = nil,                                    _ body: @MainActor (ShelfFixture) async throws -> Void) async throws {
        diagnostic("SETUP shelf_exclusive_fixture")
        let f = try ShelfFixture(checkpoint: checkpoint)
        do { try await body(f) }
        catch { await f.finish(); throw error }
        await f.finish()
    }

    static func refuses<T>(_ expected: FilePreparationError? = nil, _ operation: @MainActor () async throws -> T) async {
        do { _ = try await operation(); preconditionFailure("unsafe shelf operation must be refused") }
        catch let error as FilePreparationError {
            if let expected { precondition(error == expected, "controlled refusal must match the intended boundary") }
        }
        catch { preconditionFailure("shelf errors must remain controlled") }
    }

    /// Bounded on purpose: a regression must fail in seconds with this case's
    /// name, not burn the 30-minute native job timeout with no diagnostic.
    static func eventually(_ condition: () async -> Bool) async throws {
        for _ in 0..<2_000 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw FilePreparationError.storage
    }
}

@MainActor
private final class ReturnProbe { var count = 0 }

@MainActor
private final class ShelfFixture {
    let base: URL
    let source: URL
    let root: URL
    let copies: FilePreparation
    let expected = Data([3, 1, 4, 1, 5])
    private var leases: Set<UUID> = []
    private var consumers: [FileHandle] = []

    init(checkpoint: (@Sendable (FilePreparationCheckpoint) -> Void)?) throws {
        guard let path = ProcessInfo.processInfo.environment["COUCOU_PREPARATION_TEST_ROOT"],
              let resolved = path.withCString({ Darwin.realpath($0, nil) }) else { throw FilePreparationError.storage }
        defer { Darwin.free(resolved) }
        base = URL(fileURLWithPath: String(cString: resolved)).appendingPathComponent(UUID().uuidString)
        guard Darwin.mkdir(base.path, mode_t(0o700)) == 0 else { throw FilePreparationError.storage }
        let parent = base.appendingPathComponent("parent")
        guard Darwin.mkdir(parent.path, mode_t(0o700)) == 0 else { throw FilePreparationError.storage }
        root = parent.appendingPathComponent("owned")
        source = base.appendingPathComponent("source.bin")
        copies = FilePreparation(root: root, checkpoint: checkpoint)
        try expected.write(to: source, options: .withoutOverwriting)
    }
    func prepare(itemID: UUID = UUID(), operationID: UUID = UUID()) async throws -> ShelfAsset {
        diagnostic("COPY shelf_prepare")
        return try await copies.prepareShelf(source: source, itemID: itemID, operationID: operationID)
    }
    func prepareFolder(_ folder: URL, itemID: UUID = UUID(), operationID: UUID = UUID()) async throws -> ShelfAsset {
        diagnostic("COPY shelf_prepare_folder")
        return try await copies.prepareShelf(.folder(folder), itemID: itemID, operationID: operationID)
    }
    func prepareText(_ bytes: Data, name: String = "note",
                     itemID: UUID = UUID(), operationID: UUID = UUID()) async throws -> ShelfAsset {
        diagnostic("COPY shelf_prepare_text")
        return try await copies.prepareShelf(.text(bytes: bytes, name: name), itemID: itemID, operationID: operationID)
    }
    func prepareLink(_ link: URL, itemID: UUID = UUID(), operationID: UUID = UUID()) async throws -> ShelfAsset {
        diagnostic("COPY shelf_prepare_link")
        return try await copies.prepareShelf(.link(link), itemID: itemID, operationID: operationID)
    }
    /// Synthetic source trees live under the fixture base only, never inside the owned
    /// copy root, so a prepared item can never contain the owner's own state.
    @discardableResult
    func folder(_ relative: String) throws -> URL {
        let url = base.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    @discardableResult
    func write(_ relative: String, _ bytes: Data) throws -> URL {
        let url = base.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: url, options: .withoutOverwriting)
        return url
    }
    func symlink(_ relative: String, to target: URL) throws {
        let url = base.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
    }
    func fifo(_ relative: String) throws {
        let url = base.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard Darwin.mkfifo(url.path, mode_t(0o600)) == 0 else { throw FilePreparationError.storage }
    }
    func hold(_ asset: ShelfAsset, _ purpose: ShelfLeasePurpose) async throws -> ShelfLease {
        let lease = try await copies.acquire(assetID: asset.assetID, purpose: purpose)
        leases.insert(lease.leaseID)
        return lease
    }
    func open(_ lease: ShelfLease) throws -> FileHandle {
        let consumer = try FileHandle(forReadingFrom: lease.readyFile.url)
        consumers.append(consumer)
        return consumer
    }
    func release(_ lease: ShelfLease) async {
        await copies.release(leaseID: lease.leaseID)
        leases.remove(lease.leaseID)
    }
    func closeConsumers() { for consumer in consumers { try? consumer.close() }; consumers.removeAll() }
    func finish() async {
        closeConsumers()
        for id in Array(leases) { await copies.release(leaseID: id) }
        leases.removeAll()
        await copies.shutdown()
    }
}

// Real worker checkpoints only: no fabricated receipt, lease, or clock-driven race.
private final class CopyGate: @unchecked Sendable {
    private let lock = NSLock()
    private let proceed = DispatchSemaphore(value: 0)
    private var paused = false
    private var skips: Int
    init(skipping: Int = 0) { skips = skipping }
    func prepare(_ copies: FilePreparation, source: URL, itemID: UUID, operationID: UUID) async throws -> ShelfAsset {
        defer { signal(paused: false) }
        return try await copies.prepareShelf(source: source, itemID: itemID, operationID: operationID)
    }
    func prepareFolder(_ copies: FilePreparation, source: URL,
                       itemID: UUID, operationID: UUID) async throws -> ShelfAsset {
        defer { signal(paused: false) }
        return try await copies.prepareShelf(.folder(source), itemID: itemID, operationID: operationID)
    }
    func acquire(_ copies: FilePreparation, assetID: UUID) async throws -> ShelfLease {
        defer { signal(paused: false) }
        return try await copies.acquire(assetID: assetID, purpose: .drag)
    }
    func pause() {
        lock.lock()
        if skips > 0 { skips -= 1; lock.unlock(); return }
        lock.unlock()
        diagnostic("CHECKPOINT shelf_native_worker_paused")
        signal(paused: true)
        proceed.wait()
    }
    private func signal(paused value: Bool) {
        lock.lock()
        paused = paused || value
        lock.unlock()
    }
    /// Polled rather than resumed, so a worker that stops reaching the
    /// checkpoint fails this case instead of hanging the whole job.
    func waitUntilPaused() async throws {
        for _ in 0..<2_000 {
            if wasPaused { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw FilePreparationError.storage
    }
    private var wasPaused: Bool { lock.lock(); defer { lock.unlock() }; return paused }
    func release() { proceed.signal() }
}

private func exists(_ url: URL) -> Bool { var info = stat(); return Darwin.lstat(url.path, &info) == 0 }
private func isDirectory(_ url: URL) -> Bool {
    var info = stat()
    return Darwin.lstat(url.path, &info) == 0 && (UInt32(info.st_mode) & UInt32(S_IFMT)) == UInt32(S_IFDIR)
}
/// Relative name → content for a whole tree, so an original is compared entry by entry
/// before and after an ingest instead of through one spot check.
private func snapshot(_ root: URL) throws -> [String: String] {
    var found: [String: String] = [:]
    guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
        throw FilePreparationError.storage
    }
    for case let url as URL in walker {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
        let relative = String(url.path.dropFirst(root.path.count + 1))
        if values?.isDirectory == true { found[relative] = "directory" }
        else if values?.isRegularFile == true { found[relative] = try Data(contentsOf: url).base64EncodedString() }
        else { found[relative] = "other" }
    }
    return found
}

private func checkBytes(_ url: URL, _ expected: Data) throws {
    let actual = try Data(contentsOf: url)
    precondition(actual == expected, "synthetic bytes must remain unchanged")
}
private func diagnostic(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }
