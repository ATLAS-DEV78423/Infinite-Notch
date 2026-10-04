import AppKit
import SwiftUI

// MARK: - NSView drag destination
// Wired at the AppKit level in IslandWindowController (not via SwiftUI NSViewRepresentable)
// so it never interferes with SwiftUI hit-testing.

final class FileDropNSView: NSView {
    var canAcceptDrag: (@MainActor () -> Bool)?
    var onDragEntered: (@MainActor (CGPoint) -> Void)?
    var onDragUpdated: (@MainActor (CGPoint) -> Void)?
    var onDragExited:  (@MainActor () -> Void)?
    var onFilesDropped: (@MainActor ([URL]) -> Bool)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL])
    }
    required init?(coder: NSCoder) { fatalError() }

    // Pass all mouse events through — drag-drop uses NSDraggingDestination, not hitTest
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard canAcceptDrag?() == true else { return [] }
        onDragEntered?(sender.draggingLocation)
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard canAcceptDrag?() == true else { return [] }
        onDragUpdated?(sender.draggingLocation)
        return .copy
    }
    override func draggingExited(_ sender: NSDraggingInfo?) { onDragExited?() }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL], !urls.isEmpty else { return false }
        return onFilesDropped?(urls) ?? false
    }
}

// MARK: - File drop handler

enum FileDropHandler {
    @MainActor
    static func handle(source: URL, operationID: UUID, replacing old: UUID?, state: AppState) async {
        if let old { await state.filePreparer.cancel(operationID: old) }
        guard !Task.isCancelled, state.currentDropOperationID == operationID else {
            await state.filePreparer.cancel(operationID: operationID)
            return
        }
        // Gulp is decorative feedback, not a claim of successful preparation.
        NotificationCenter.default.post(name: .botGulp, object: nil)
        NotificationCenter.default.post(name: .botMorphTo, object: CGFloat(0))
        do {
            let file = try await state.filePreparer.prepare(source: source, operationID: operationID)
            guard !Task.isCancelled, state.completeFilePreparation(file) else {
                if state.currentDropOperationID == operationID { state.clearFilePreparation() }
                await state.filePreparer.cancel(operationID: operationID)
                return
            }
            SoundEngine.shared.play("approve")
            NotificationCenter.default.post(name: .triggerEmote, object: BotEmote.happy)
        } catch {
            guard !Task.isCancelled else { return }
            _ = state.failFilePreparation(operationID: operationID, error: (error as? FilePreparationError) ?? .storage)
        }
    }
}
