import Foundation

@MainActor
@main
enum FilePreparationTests {
    static func main() {
        pending_after_ten_seconds_has_no_check_or_choose()
        print("  ✓ pending_after_ten_seconds_has_no_check_or_choose")
        print("File preparation: 1 case passed")
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
}
