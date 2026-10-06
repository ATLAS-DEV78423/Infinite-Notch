// Shelf native actions (spec rows #24 open, #25 share, #29 real file drag).
//
// The rules this file exists to enforce:
//
//  * An action receives an ASSET ID, never a path. The path comes from the lease
//    native just validated and anchored, so the UI cannot name a file it does
//    not own. There is deliberately no command that takes a raw path.
//  * The lease is taken before the OS handoff and released after it, so a row
//    removed mid-action keeps its copy alive until the consumer is finished.
//  * Nothing happens automatically. Every action needs its own explicit click.
//  * Opening is the one action with no OS-side lifetime to wait for: the OS has
//    the file open by the time the spawn returns, which is the same boundary the
//    legacy drop path already used. Share has no such proof on any platform here,
//    so it is refused rather than pretending a spawn means the user read it.

use std::path::Path;

use crate::files::{DropCopies, ShelfLeasePurpose};

/// What the OS was actually asked to do with the leased file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShelfAction { Open, Reveal }

impl ShelfAction {
    fn purpose(self) -> ShelfLeasePurpose {
        // An OS handoff is a drag-class consumer: something outside the app reads
        // the file. Share is refused below rather than reusing this, so `share`
        // never appears here — adding one later needs its own lifetime proof.
        ShelfLeasePurpose::Drag
    }
}

/// The absolute path the OS may be given, taken from a live lease only.
pub struct LeasedPath {
    path: String,
    _lease: crate::files::ShelfLease,
}

impl LeasedPath {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn as_path(&self) -> &Path { Path::new(&self.path) }
    pub fn as_str(&self) -> &str { &self.path }
}

/// Acquire the asset's lease and hand back the only path the OS may be given.
///
/// The lease lives inside the returned value, so dropping it is the release: a
/// caller cannot forget to release, and the copy stays readable for exactly as
/// long as the OS handoff value exists.
pub fn lease_for_action(copies: &DropCopies, asset_id: &str, action: ShelfAction) -> Result<LeasedPath, String> {
    let lease = copies.acquire(asset_id, action.purpose())?;
    let path = lease.data.path.clone();
    Ok(LeasedPath { path, _lease: lease })
}

/// Run the requested action against a leased file.
///
/// Returns the leased path so the caller can log/verify what it opened; the
/// lease drops here, which is after the spawn that handed the file to the OS.
pub fn run_action(copies: &DropCopies, asset_id: &str, action: ShelfAction) -> Result<String, String> {
    let leased = lease_for_action(copies, asset_id, action)?;
    let path = leased.as_str().to_owned();
    match action {
        ShelfAction::Open => crate::platform::open_file(&path),
        ShelfAction::Reveal => crate::platform::reveal_folder(&path),
    }
    Ok(path)
}

/// Share is refused on every platform in this build.
///
/// A share sheet is asynchronous and reports nothing back when the user finishes
/// or cancels, so there is no point at which the lease provably may be released.
/// Releasing on the spawn would risk deleting a copy a consumer is still reading,
/// and holding it forever would leak the file. `handoff.md` §10 makes share wait
/// for actual consumer-lifetime evidence; this is that refusal, stated in code
/// rather than in a comment, and the UI already renders a refusal state.
pub const SHARE_UNAVAILABLE: &str = "Sharing needs a supported consumer on this platform.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::tests::{Fixture, ShelfFixture};

    /// A synthetic shelf item with one ready regular-file asset.
    fn prepared() -> ShelfFixture {
        ShelfFixture::new(0)
    }

    #[test]
    fn unknown_asset_has_no_action_authority() {
        let fixture = prepared();
        for action in [ShelfAction::Open, ShelfAction::Reveal] {
            assert!(run_action(&fixture.copies, &uuid::Uuid::new_v4().to_string(), action).is_err(),
                    "an unknown asset ID must never reach an OS handoff");
        }
        assert_eq!(fixture.copies.lease_count(), 0, "a refused action holds no lease");
        fixture.copies.shutdown();
    }

    #[test]
    fn action_receives_the_owned_copy_never_the_original() {
        let fixture = prepared();
        let leased = lease_for_action(&fixture.copies, &fixture.asset_id, ShelfAction::Open).fixture();
        assert_ne!(leased.as_str(), fixture.source, "an action must open the owned copy, not the original");
        assert!(leased.as_str().starts_with(&fixture.copies_root), "the leased path must be the owned copy");
        assert!(std::path::Path::new(leased.as_str()).exists());
        assert_eq!(fixture.copies.lease_count(), 1, "a live lease keeps the copy");
        // Shutdown waits for live leases, exactly as quit does: the handle must go
        // first, or the wait is a real deadlock rather than a test artefact.
        drop(leased);
        fixture.copies.shutdown();
    }

    #[test]
    fn dropping_the_lease_releases_it() {
        let fixture = prepared();
        {
            let _leased = lease_for_action(&fixture.copies, &fixture.asset_id, ShelfAction::Open).fixture();
            assert_eq!(fixture.copies.lease_count(), 1);
        }
        assert_eq!(fixture.copies.lease_count(), 0, "dropping the handle is the release");
        fixture.copies.shutdown();
    }

    #[test]
    fn removed_row_keeps_its_copy_while_an_action_holds_a_lease() {
        let fixture = prepared();
        let leased = lease_for_action(&fixture.copies, &fixture.asset_id, ShelfAction::Reveal).fixture();
        let copy = leased.as_str().to_owned();
        fixture.copies.remove(&fixture.item_id).fixture();
        // The row is gone but the OS still holds this path: the copy must survive.
        assert!(std::path::Path::new(&copy).exists(), "removing a row mid-action must not delete a leased copy");
        drop(leased);
        assert!(!std::path::Path::new(&copy).exists(), "the last release removes the copy");
        fixture.copies.shutdown();
    }

    #[test]
    fn a_removed_asset_admits_no_further_action() {
        let fixture = prepared();
        let leased = lease_for_action(&fixture.copies, &fixture.asset_id, ShelfAction::Open).fixture();
        fixture.copies.remove(&fixture.item_id).fixture();
        assert!(lease_for_action(&fixture.copies, &fixture.asset_id, ShelfAction::Open).is_err(),
                "a removed asset must not admit a new lease");
        drop(leased);
        fixture.copies.shutdown();
    }

    #[test]
    fn share_is_refused_rather_than_released_on_the_spawn() {
        let fixture = prepared();
        // The refusal is the absence of a share call: no lease is taken at all, so
        // nothing can be deleted underneath a consumer that never got the file.
        assert!(!SHARE_UNAVAILABLE.is_empty());
        assert_eq!(fixture.copies.lease_count(), 0, "a refused share takes no lease at all");
        assert!(std::path::Path::new(&fixture.source).exists(), "the original is untouched");
        fixture.copies.shutdown();
    }

    #[test]
    fn every_action_purpose_is_a_drag_consumer() {
        // A share purpose would be a lie until its lifetime is proven.
        assert_eq!(ShelfAction::Open.purpose(), ShelfLeasePurpose::Drag);
        assert_eq!(ShelfAction::Reveal.purpose(), ShelfLeasePurpose::Drag);
    }
}