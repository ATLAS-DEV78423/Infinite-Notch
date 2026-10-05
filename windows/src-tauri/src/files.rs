// Temporary shelf copies. The legacy inbox is neither reused nor swept.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::file_copy::{self, CopiedFile, CopyError};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

struct Operation {
    cancelled: Arc<AtomicBool>,
    preparing: bool,
    admitted: bool,
}

#[derive(Default)]
struct CopyState {
    operations: HashMap<String, Operation>,
    paused: bool,
    stopping: bool,
    stopped: bool,
    starting: bool,
    storage_ready: bool,
}

struct Owner {
    root: PathBuf,
    state: Mutex<CopyState>,
    idle: Condvar,
}

#[derive(Clone)]
pub struct DropCopies(Arc<Owner>);

impl Default for DropCopies {
    fn default() -> Self {
        let copies = Self::at(crate::settings::local_dir().join("shelf-copies"));
        {
            let mut state = copies.0.state.lock().unwrap();
            state.starting = true;
            state.storage_ready = false;
        }
        copies
    }
}

pub fn ingest(source: &str, root: &Path, id: &str, cancelled: &AtomicBool) -> Result<DroppedFile, CopyError> {
    let CopiedFile { name, path, size } = file_copy::copy_into(Path::new(source), root, id, cancelled)?;
    match path.to_str() {
        Some(path) => Ok(DroppedFile { name, path: path.to_owned(), size }),
        None => { let _ = file_copy::discard(root, id); Err(CopyError::InvalidSource) }
    }
}

impl DropCopies {
    fn at(root: PathBuf) -> Self {
        Self(Arc::new(Owner { root, state: Mutex::new(CopyState { storage_ready: true, ..Default::default() }), idle: Condvar::new() }))
    }

    /// Runs once at native startup, on the blocking executor. Markers supply
    /// cleanup authority only; they never reconstruct shelf rows or history.
    pub fn startup(&self) -> Result<file_copy::ReapOutcome, CopyError> {
        let result = file_copy::reap_abandoned(&self.0.root);
        let mut state = self.0.state.lock().unwrap();
        state.storage_ready = result.as_ref().is_ok_and(|outcome| !outcome.limit_reached);
        state.starting = false;
        self.0.idle.notify_all();
        result
    }

    pub fn legacy_id(&self) -> String {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        format!("legacy-{}-{now:x}-{:x}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))
    }

    pub fn begin(&self, id: String) -> Result<CopyJob, String> {
        file_copy::validate_id(&id).map_err(|error| error.message().to_owned())?;
        let mut state = self.0.state.lock().unwrap();
        if state.paused || state.stopping { return Err(CopyError::Cancelled.message().into()); }
        if !state.storage_ready { return Err("File storage is not ready.".into()); }
        if state.operations.contains_key(&id) { return Err(CopyError::DuplicateOperation.message().into()); }
        // ponytail: one preparing file for the legacy single-item drop flow;
        // add a bounded multi-item queue when the shelf owns multiple rows.
        if state.operations.values().any(|operation| operation.preparing) {
            return Err("Another file is still preparing.".into());
        }
        if state.operations.len() >= file_copy::MAX_OPERATIONS { return Err(CopyError::Storage.message().into()); }
        let cancelled = Arc::new(AtomicBool::new(false));
        state.operations.insert(id.clone(), Operation { cancelled: cancelled.clone(), preparing: true, admitted: true });
        Ok(CopyJob { copies: self.clone(), id, cancelled })
    }

    pub fn revoke(&self, id: &str) -> bool {
        if file_copy::validate_id(id).is_err() { return false; }
        let mut state = self.0.state.lock().unwrap();
        if let Some(operation) = state.operations.get(id) {
            operation.cancelled.store(true, Ordering::Release);
            return operation.admitted;
        }
        // A synchronous cancel can precede the first poll of prepare_file.
        // Retire its ID at the same lock as begin(), without cleanup authority.
        // The budget never evicts entries: once full, begin() refuses all new IDs.
        if state.operations.len() < file_copy::MAX_OPERATIONS {
            state.operations.insert(id.to_owned(), Operation {
                cancelled: Arc::new(AtomicBool::new(true)), preparing: false, admitted: false,
            });
        }
        false
    }

    pub fn cancel(&self, id: &str) {
        if !self.revoke(id) { return; }
        let _ = file_copy::discard(&self.0.root, id);
    }

    pub fn pause(&self, paused: bool) {
        {
            let mut state = self.0.state.lock().unwrap();
            state.paused = paused;
            if !paused { return; }
            for operation in state.operations.values() {
                // Ready copies may already be in an export/attachment lease;
                // pause revokes preparing work without evicting those files.
                if operation.preparing {
                    operation.cancelled.store(true, Ordering::Release);
                }
            }
        }
    }

    /// Called off the UI executor after native ExitRequested has been deferred.
    /// Workers complete their cleanup before the final native exit is allowed.
    pub fn shutdown(&self) {
        let ids = {
            let mut state = self.0.state.lock().unwrap();
            state.stopping = true;
            for operation in state.operations.values() { operation.cancelled.store(true, Ordering::Release); }
            state.operations.iter().filter(|(_, operation)| operation.admitted).map(|(id, _)| id.clone()).collect::<Vec<_>>()
        };
        for id in &ids { let _ = file_copy::discard(&self.0.root, id); }
        let mut state = self.0.state.lock().unwrap();
        while state.starting || state.operations.values().any(|operation| operation.preparing) {
            state = self.0.idle.wait(state).unwrap();
        }
        drop(state);
        for id in &ids { let _ = file_copy::discard(&self.0.root, id); }
        self.0.state.lock().unwrap().stopped = true;
    }

    /// Returns true exactly once for the exit-cleanup worker, and None after it
    /// finishes, allowing the follow-up native exit request through.
    pub fn request_exit(&self) -> Option<bool> {
        let mut state = self.0.state.lock().unwrap();
        if state.stopped { return None; }
        if state.stopping { return Some(false); }
        state.stopping = true;
        Some(true)
    }
}

pub struct CopyJob {
    copies: DropCopies,
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl CopyJob {
    pub fn run(self, source: String) -> Result<DroppedFile, String> {
        let result = ingest(&source, &self.copies.0.root, &self.id, &self.cancelled);
        // Delivery is serialized with cancel/pause/exit, not just publication.
        // No late completion can become ready after native revocation wins.
        let state = self.copies.0.state.lock().unwrap();
        let revoked = self.cancelled.load(Ordering::Acquire) || state.paused || state.stopping;
        drop(state);
        if revoked {
            let _ = file_copy::discard(&self.copies.0.root, &self.id);
            Err(CopyError::Cancelled.message().into())
        } else { result.map_err(|error| error.message().to_owned()) }
    }
}

impl Drop for CopyJob {
    fn drop(&mut self) {
        // Runs inside the blocking task, even if its awaiting webview goes away.
        let mut state = self.copies.0.state.lock().unwrap();
        if let Some(operation) = state.operations.get_mut(&self.id) { operation.preparing = false; }
        self.copies.0.idle.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let base = std::env::var_os("COUCOU_COPY_TEST_ROOT").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
            std::fs::create_dir_all(&base).unwrap();
            loop {
                let root = base.join(format!("coucou-files-{}-{}", std::process::id(), NEXT_ROOT.fetch_add(1, Ordering::Relaxed)));
                match std::fs::create_dir(&root) {
                    Ok(()) => return Self(root),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                    Err(_) => panic!("synthetic test root unavailable"),
                }
            }
        }
        fn source(&self) -> String {
            let source = self.0.join("synthetic.txt");
            std::fs::write(&source, b"synthetic").unwrap();
            source.to_str().unwrap().to_owned()
        }
        fn copies(&self) -> DropCopies { DropCopies::at(self.0.join("copies")) }
    }
    impl Drop for Root { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let first = copies.begin(copies.legacy_id()).unwrap().run(source.clone()).unwrap();
        std::fs::write(&source, b"second").unwrap();
        let second = copies.begin(copies.legacy_id()).unwrap().run(source.clone()).unwrap();
        assert_ne!(first.path, second.path);
        assert!(std::fs::read(&first.path).unwrap() == b"synthetic");
        assert!(std::fs::read(&second.path).unwrap() == b"second");
        assert!(std::fs::read(source).unwrap() == b"second");
        copies.shutdown();
        assert!(!Path::new(&first.path).exists());
        assert!(!Path::new(&second.path).exists());
    }

    #[test]
    fn cancel_preserves_ready_path_until_native_reader_closes() {
        use std::io::Read;
        let root = Root::new();
        // source() closes its writer before native Windows sharing checks.
        let source = root.source();
        let copies = root.copies();
        let ready = copies.begin("reader-held".into())
            .unwrap_or_else(|_| panic!("synthetic copy admission failed"))
            .run(source.clone())
            .unwrap_or_else(|_| panic!("synthetic copy preparation failed"));
        let mut consumer = std::fs::File::open(&ready.path)
            .unwrap_or_else(|_| panic!("synthetic native reader could not open"));

        copies.cancel("reader-held");
        let mut bytes = Vec::new();
        consumer.read_to_end(&mut bytes)
            .unwrap_or_else(|_| panic!("synthetic native reader could not read after cancel"));
        let path_usable = std::fs::File::open(&ready.path).is_ok();
        // Observe pathname usability with the reader open, then clean up even
        // when the lifecycle assertion below fails against the current owner.
        drop(consumer);
        copies.shutdown();
        assert!(bytes == b"synthetic", "cancel changed native reader bytes");
        let original = std::fs::read(source)
            .unwrap_or_else(|_| panic!("synthetic original could not be read"));
        assert!(original == b"synthetic", "cancel changed original bytes");
        assert!(path_usable, "cancel invalidated ready managed pathname while native read consumer was open");
    }

    #[test]
    fn pause_revokes_pending_job_without_removing_ready_copy() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let ready = copies.begin("ready".into()).unwrap().run(source.clone()).unwrap();
        let job = copies.begin("pending".into()).unwrap();
        assert!(copies.begin("overlapping".into()).is_err());
        copies.pause(true);
        copies.pause(false);
        assert!(job.run(source).is_err());
        assert!(Path::new(&ready.path).exists());
        assert!(!copies.0.root.join("pending").exists());
        copies.shutdown();
    }

    #[test]
    fn cancel_before_worker_starts_and_unowned_id_is_harmless() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        std::fs::create_dir(&copies.0.root).unwrap();
        let foreign = copies.0.root.join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        std::fs::write(foreign.join("keep"), b"keep").unwrap();
        let job = copies.begin("pending".into()).unwrap();
        copies.cancel("pending");
        copies.cancel("foreign");
        copies.cancel("../source");
        assert!(job.run(source).is_err());
        assert!(std::fs::read(foreign.join("keep")).unwrap() == b"keep");
    }

    #[test]
    fn shutdown_waits_for_owned_worker_and_prevents_late_admission() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let job = copies.begin("pending".into()).unwrap();
        assert_eq!(copies.request_exit(), Some(true));
        assert_eq!(copies.request_exit(), Some(false));
        std::thread::scope(|scope| {
            let shutdown = scope.spawn(|| copies.shutdown());
            assert!(job.run(source).is_err());
            shutdown.join().unwrap();
        });
        assert!(copies.begin("after-exit".into()).is_err());
        assert_eq!(copies.request_exit(), None);
    }

    #[test]
    fn pause_and_resume_cannot_revive_worker_at_commit() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let control = copies.clone();
        crate::file_copy::test_hook(move |phase| {
            if phase == crate::file_copy::CopyPhase::BeforePublish {
                control.pause(true);
                control.pause(false);
            }
            Ok(())
        });
        assert!(copies.begin("race".into()).unwrap().run(source).is_err());
        assert!(!copies.0.root.join("race").exists());
        copies.shutdown();
    }

    #[test]
    fn shutdown_cancels_active_chunk_and_waits_for_partial_cleanup() {
        use std::sync::Barrier;
        use std::time::{Duration, Instant};
        let root = Root::new();
        let source = root.source();
        std::fs::write(&source, vec![17; 3 * 65536]).unwrap();
        let copies = root.copies();
        let job = copies.begin("active".into()).unwrap();
        let cancelled = job.cancelled.clone();
        let barrier = Arc::new(Barrier::new(2));
        let worker_barrier = barrier.clone();
        let finished = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let mut first = true;
                crate::file_copy::test_hook(move |phase| {
                    if phase == crate::file_copy::CopyPhase::Chunk && first {
                        first = false;
                        worker_barrier.wait();
                        worker_barrier.wait();
                    }
                    Ok(())
                });
                job.run(source.clone())
            });
            barrier.wait();
            let shutdown = scope.spawn(|| { copies.shutdown(); finished.store(true, Ordering::Release); });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !cancelled.load(Ordering::Acquire) && Instant::now() < deadline { std::thread::yield_now(); }
            let revoked_before_release = cancelled.load(Ordering::Acquire);
            let exited_before_release = finished.load(Ordering::Acquire);
            barrier.wait();
            let result = worker.join().unwrap();
            shutdown.join().unwrap();
            assert!(revoked_before_release);
            assert!(!exited_before_release);
            assert!(result.is_err());
        });
        assert!(finished.load(Ordering::Acquire));
        assert!(!copies.0.root.join("active").exists());
        assert!(std::fs::read(source).unwrap() == vec![17; 3 * 65536]);
    }

    #[test]
    fn startup_gates_admission_and_preserves_active_ready_owner() {
        let root = Root::new();
        let copies = root.copies();
        let ready = copies.begin("active".into()).unwrap().run(root.source()).unwrap();
        {
            let mut state = copies.0.state.lock().unwrap();
            state.starting = true;
            state.storage_ready = false;
        }
        assert!(copies.begin("before-startup".into()).is_err());
        let outcome = copies.startup().unwrap();
        assert_eq!(outcome.inspected, if cfg!(target_os = "linux") { 2 } else { 0 });
        assert_eq!(outcome.reaped, 0);
        assert!(!outcome.limit_reached);
        assert_eq!(outcome.supported, cfg!(target_os = "linux"));
        assert!(std::fs::read(&ready.path).unwrap() == b"synthetic");
        assert!(copies.begin("after-startup".into()).is_ok());
        copies.shutdown();
    }

    #[test]
    fn unknown_valid_cancel_is_retired_before_async_admission() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let foreign = copies.0.root.join("unseen");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("keep"), b"foreign").unwrap();
        // Model native dispatch order directly: synchronous cancel wins before
        // the prepare future is first polled and calls begin(). No IPC ordering
        // or thread timing assumption is needed for this admission check.
        copies.cancel("unseen");
        assert!(copies.begin("unseen".into()).is_err(), "a cancelled unseen ID was admitted");
        copies.cancel("unseen");
        copies.shutdown();
        assert!(std::fs::read(foreign.join("keep")).unwrap() == b"foreign");
        assert!(std::fs::read(source).unwrap() == b"synthetic");
        assert!(!copies.0.root.join(".owner-unseen").exists());
    }

    #[test]
    fn invalid_unknown_revoke_is_harmless_and_does_not_consume_budget() {
        let root = Root::new();
        let copies = root.copies();
        for id in ["", "../outside", "bad_id", "é", &"a".repeat(65)] {
            assert!(!copies.revoke(id));
            copies.cancel(id);
        }
        assert!(copies.0.state.lock().unwrap().operations.is_empty());
        assert!(!copies.0.root.exists());
        let fresh = copies.begin("fresh".into()).unwrap();
        drop(fresh);
    }

    #[test]
    fn retirement_pressure_refuses_new_work_without_evicting_ready_files() {
        let root = Root::new();
        let copies = root.copies();
        let source = root.source();
        let ready = copies.begin("ready".into()).unwrap().run(source.clone()).unwrap();
        let foreign = copies.0.root.join("overflow");
        std::fs::create_dir(&foreign).unwrap();
        std::fs::write(foreign.join("keep"), b"foreign").unwrap();
        for i in 1..file_copy::MAX_OPERATIONS { assert!(!copies.revoke(&format!("unseen-{i}"))); }
        copies.cancel("overflow");
        assert!(copies.begin("overflow".into()).is_err());
        assert!(copies.begin("another".into()).is_err());
        assert_eq!(copies.0.state.lock().unwrap().operations.len(), file_copy::MAX_OPERATIONS);
        assert!(std::fs::read(&ready.path).unwrap() == b"synthetic");
        assert!(std::fs::read(&source).unwrap() == b"synthetic");
        // Known work remains cancellable even with the retirement budget full.
        copies.cancel("ready");
        assert!(!Path::new(&ready.path).exists());
        copies.shutdown();
        assert!(std::fs::read(foreign.join("keep")).unwrap() == b"foreign");
    }

    #[test]
    fn retired_ids_never_gain_cleanup_authority() {
        let root = Root::new();
        let copies = root.copies();
        let source = root.source();
        // Independently owned primitive content is not an admitted job of this
        // DropCopies owner. Repeating revoke/cancel and exit must not discard it.
        let other = file_copy::copy_into(Path::new(&source), &copies.0.root, "unseen", &AtomicBool::new(false)).unwrap();
        assert!(!copies.revoke("unseen"));
        assert!(!copies.revoke("unseen"));
        copies.cancel("unseen");
        assert!(copies.begin("unseen".into()).is_err());
        copies.shutdown();
        assert!(std::fs::read(&other.path).unwrap() == b"synthetic");
        assert!(std::fs::read(source).unwrap() == b"synthetic");
        file_copy::discard(&copies.0.root, "unseen").unwrap();
    }
}
