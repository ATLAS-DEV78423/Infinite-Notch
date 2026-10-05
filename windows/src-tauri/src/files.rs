// Temporary shelf copies. The legacy inbox is neither reused nor swept.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use uuid::Uuid;

use crate::file_copy::{self, CopiedFile, CopyError};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

const MAX_SHELF_ASSETS: usize = 32;
const MAX_SHELF_LEASES: usize = 32;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShelfAsset {
    pub item_id: String,
    pub operation_id: String,
    pub asset_id: String,
    pub name: String,
    pub size: u64,
}

/// The approved native seam: drag/share/mail/transfer. Same spellings as the
/// Mac `ShelfLeasePurpose`, so both shelves expose one purpose contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShelfLeasePurpose { Drag, Share, Mail, Transfer }

type Reader = Arc<Mutex<Option<file_copy::ReadyLease>>>;

// Native-only. Neither the lease nor its ready pathname is an IPC receipt.
pub struct ShelfLease {
    lease_id: String,
    pub asset_id: String,
    pub purpose: ShelfLeasePurpose,
    pub data: DroppedFile,
    reader: Reader,
    copies: DropCopies,
}

impl ShelfLease {
    pub fn lease_id(&self) -> &str { &self.lease_id }
}

impl std::io::Read for ShelfLease {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let mut reader = self.reader.lock().unwrap();
        std::io::Read::read(reader.as_mut().ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotConnected))?, bytes)
    }
}

impl Drop for ShelfLease {
    fn drop(&mut self) { let _ = self.copies.release(&self.lease_id); }
}

struct LeaseRecord { operation_id: String, reader: Reader }

fn uuid_id(id: &str) -> Result<String, String> {
    Uuid::parse_str(id).ok().filter(|id| !id.is_nil()).map(|id| id.to_string())
        .ok_or_else(|| CopyError::InvalidOperation.message().to_owned())
}

struct Operation {
    cancelled: Arc<AtomicBool>,
    preparing: bool,
    admitted: bool,
    shelf: Option<ShelfAsset>,
    ready: Option<DroppedFile>,
    disposed: bool,
    native: Arc<Mutex<Option<file_copy::CopyOwner>>>,
}

impl Operation {
    fn refresh_ownership(&mut self) {
        self.disposed = !self.native.lock().unwrap().as_ref().is_some_and(file_copy::CopyOwner::retained);
        if self.disposed {
            self.ready = None;
            if let Some(asset) = &mut self.shelf { asset.name.clear(); asset.size = 0; }
        }
    }
}

#[derive(Default)]
struct CopyState {
    operations: HashMap<String, Operation>,
    items: HashMap<String, Option<String>>,
    assets: HashMap<String, String>,
    leases: HashMap<String, LeaseRecord>,
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

fn known_operation<'a>(state: &'a CopyState, id: &str) -> Option<&'a str> {
    state.operations.get_key_value(id).or_else(|| {
        let canonical = uuid_id(id).ok()?;
        state.operations.get_key_value(&canonical).filter(|(_, operation)| operation.shelf.is_some())
    }).map(|(key, _)| key.as_str())
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
        self.admit(id, None)
    }

    pub fn begin_shelf(&self, item_id: String, operation_id: String) -> Result<ShelfCopyJob, String> {
        let item_id = uuid_id(&item_id)?;
        let operation_id = uuid_id(&operation_id)?;
        let asset = ShelfAsset { item_id, operation_id: operation_id.clone(), asset_id: Uuid::new_v4().to_string(), name: String::new(), size: 0 };
        self.admit(operation_id, Some(asset)).map(ShelfCopyJob)
    }

    fn admit(&self, id: String, shelf: Option<ShelfAsset>) -> Result<CopyJob, String> {
        let mut state = self.0.state.lock().unwrap();
        if state.paused || state.stopping { return Err(CopyError::Cancelled.message().into()); }
        if !state.storage_ready { return Err("File storage is not ready.".into()); }
        if state.operations.contains_key(&id) { return Err(CopyError::DuplicateOperation.message().into()); }
        if let Some(asset) = &shelf {
            // UUID aliases share retirement for shelf operations; legacy begin
            // retains its exact string-ID semantics and existing admission cap.
            if state.items.contains_key(&asset.item_id) || state.operations.keys().any(|used| uuid_id(used).is_ok_and(|used| used == id)) {
                return Err(CopyError::DuplicateOperation.message().into());
            }
            if state.items.len() >= file_copy::MAX_OPERATIONS || state.assets.contains_key(&asset.asset_id)
                || state.operations.values().filter(|operation| operation.shelf.is_some() && (operation.preparing || !operation.disposed)).count() >= MAX_SHELF_ASSETS {
                return Err(CopyError::Storage.message().into());
            }
        }
        // ponytail: one preparing worker; add a bounded queue only in a later
        // slice that requires overlapping preparation.
        if state.operations.values().any(|operation| operation.preparing) {
            return Err("Another file is still preparing.".into());
        }
        if state.operations.len() >= file_copy::MAX_OPERATIONS { return Err(CopyError::Storage.message().into()); }
        let cancelled = Arc::new(AtomicBool::new(false));
        let native = Arc::new(Mutex::new(None));
        if let Some(asset) = &shelf {
            state.items.insert(asset.item_id.clone(), Some(id.clone()));
            state.assets.insert(asset.asset_id.clone(), id.clone());
        }
        state.operations.insert(id.clone(), Operation { cancelled: cancelled.clone(), preparing: true, admitted: true, shelf, ready: None, disposed: false, native: native.clone() });
        Ok(CopyJob { copies: self.clone(), id, cancelled, native })
    }

    pub fn revoke(&self, id: &str) -> bool {
        let mut state = self.0.state.lock().unwrap();
        if let Some(key) = known_operation(&state, id) {
            let operation = &state.operations[key];
            operation.cancelled.store(true, Ordering::Release);
            return operation.admitted;
        }
        let id = if file_copy::validate_id(id).is_ok() { id.to_owned() }
            else if let Ok(id) = uuid_id(id) { id } else { return false; };
        // A synchronous cancel can precede the first poll of prepare_file.
        // Retire its ID at the same lock as begin(), without cleanup authority.
        // The budget never evicts entries: once full, begin() refuses all new IDs.
        if state.operations.len() < file_copy::MAX_OPERATIONS {
            state.operations.insert(id, Operation {
                cancelled: Arc::new(AtomicBool::new(true)), preparing: false, admitted: false,
                shelf: None, ready: None, disposed: true, native: Arc::new(Mutex::new(None)),
            });
        }
        false
    }

    pub fn cancel(&self, id: &str) {
        if !self.revoke(id) { return; }
        let mut state = self.0.state.lock().unwrap();
        if let Some(key) = known_operation(&state, id).map(str::to_owned) { let _ = self.dispose_locked(&mut state, &key); }
    }

    fn dispose_locked(&self, state: &mut CopyState, id: &str) -> Result<(), CopyError> {
        let operation = state.operations.get_mut(id).ok_or(CopyError::InvalidOperation)?;
        if !operation.admitted { return Ok(()); }
        // A token is issued only by this worker's successful primitive
        // admission. A duplicate/foreign registry entry grants no authority.
        let result = operation.native.lock().unwrap().as_ref().map_or(Ok(()), file_copy::CopyOwner::discard);
        operation.refresh_ownership();
        result
    }

    pub fn acquire(&self, asset_id: &str, purpose: ShelfLeasePurpose) -> Result<ShelfLease, String> {
        let asset_id = uuid_id(asset_id)?;
        let mut state = self.0.state.lock().unwrap();
        if state.paused || state.stopping { return Err(CopyError::Cancelled.message().into()); }
        if state.leases.len() >= MAX_SHELF_LEASES { return Err(CopyError::Storage.message().into()); }
        let id = state.assets.get(&asset_id).cloned().ok_or_else(|| CopyError::InvalidOperation.message().to_owned())?;
        let operation = &state.operations[&id];
        if operation.preparing || operation.disposed || operation.cancelled.load(Ordering::Acquire) || operation.ready.is_none() {
            return Err(CopyError::Cancelled.message().into());
        }
        // Keep the state lock through anchored acquisition: remove/pause/exit
        // cannot win between validation and registration of the native reader.
        let (copy, native) = operation.native.lock().unwrap().as_ref().ok_or_else(|| CopyError::InvalidOperation.message().to_owned())?
            .acquire().map_err(|error| error.message().to_owned())?;
        let path = copy.path.to_str().ok_or_else(|| CopyError::InvalidSource.message().to_owned())?.to_owned();
        let data = DroppedFile { name: copy.name, path, size: copy.size };
        let lease_id = Uuid::new_v4().to_string();
        if state.leases.contains_key(&lease_id) { return Err(CopyError::Storage.message().into()); }
        let reader = Arc::new(Mutex::new(Some(native)));
        state.leases.insert(lease_id.clone(), LeaseRecord { operation_id: id, reader: reader.clone() });
        Ok(ShelfLease { lease_id, asset_id, purpose, data, reader, copies: self.clone() })
    }

    pub fn release(&self, lease_id: &str) -> Result<(), String> {
        let mut state = self.0.state.lock().unwrap();
        let Some(record) = state.leases.remove(lease_id) else { return Ok(()); };
        let result = record.reader.lock().unwrap().take().map_or(Ok(()), file_copy::ReadyLease::release);
        if let Some(operation) = state.operations.get_mut(&record.operation_id) {
            operation.refresh_ownership();
        }
        // Always wake exit, including failed cleanup. It must retry or report
        // failure, not wait forever for a lease that has already been closed.
        self.0.idle.notify_all();
        result.map_err(|error| error.message().to_owned())
    }

    pub fn remove(&self, item_id: &str) -> Result<(), String> {
        let item_id = uuid_id(item_id)?;
        let mut state = self.0.state.lock().unwrap();
        let Some(id) = state.items.get(&item_id).cloned().flatten() else {
            if !state.items.contains_key(&item_id) {
                if state.items.len() >= file_copy::MAX_OPERATIONS { return Err(CopyError::Storage.message().into()); }
                state.items.insert(item_id, None); // Revoke-before-admission; no I/O authority.
            }
            return Ok(());
        };
        state.operations[&id].cancelled.store(true, Ordering::Release);
        self.dispose_locked(&mut state, &id).map_err(|error| error.message().to_owned())
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

    /// Best-effort teardown for tests that deliberately leave foreign entries
    /// behind. The native exit path uses shutdown_checked and never ignores it.
    #[cfg(test)]
    pub fn shutdown(&self) {
        let _ = self.shutdown_checked();
    }

    pub fn shutdown_checked(&self) -> Result<(), String> {
        let mut state = self.0.state.lock().unwrap();
        state.stopping = true;
        for operation in state.operations.values() { operation.cancelled.store(true, Ordering::Release); }
        let ids = state.operations.iter().filter(|(_, operation)| operation.admitted).map(|(id, _)| id.clone()).collect::<Vec<_>>();
        for id in &ids { let _ = self.dispose_locked(&mut state, id); }
        while state.starting || state.operations.values().any(|operation| operation.preparing) || !state.leases.is_empty() {
            state = self.0.idle.wait(state).unwrap();
        }
        let mut failure = None;
        for id in &ids {
            if let Err(error) = self.dispose_locked(&mut state, id) { failure.get_or_insert(error); }
        }
        // Cleanup is finished either way, so the exit gate opens and the app can
        // always quit. Unremovable content is a reported failure to the caller,
        // never a silent success and never a permanently stuck process: the
        // refusable cases are foreign entries we must not delete, which no
        // amount of retrying will ever clear.
        state.stopped = true;
        match failure { Some(error) => Err(error.message().to_owned()), None => Ok(()) }
    }

    /// Returns true exactly once, and None once cleanup has finished, allowing
    /// the follow-up native exit request through.
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
    native: Arc<Mutex<Option<file_copy::CopyOwner>>>,
}

impl CopyJob {
    pub fn run(self, source: String) -> Result<DroppedFile, String> {
        self.prepare(source)
    }

    fn prepare(&self, source: String) -> Result<DroppedFile, String> {
        let result = file_copy::copy_owned(Path::new(&source), &self.copies.0.root, &self.id, &self.cancelled, &self.native);
        let result = result.and_then(|CopiedFile { name, path, size }| {
            path.to_str().map(|path| DroppedFile { name, path: path.to_owned(), size }).ok_or(CopyError::InvalidSource)
        });
        // Delivery is serialized with cancel/pause/exit, not just publication.
        // No late completion can become ready after native revocation wins.
        let mut state = self.copies.0.state.lock().unwrap();
        let revoked = self.cancelled.load(Ordering::Acquire) || state.paused || state.stopping;
        if revoked {
            let _ = self.copies.dispose_locked(&mut state, &self.id);
            Err(CopyError::Cancelled.message().into())
        } else {
            match result {
                Ok(ready) => {
                    let operation = state.operations.get_mut(&self.id).unwrap();
                    if let Some(asset) = &mut operation.shelf { asset.name = ready.name.clone(); asset.size = ready.size; }
                    operation.ready = Some(ready.clone());
                    Ok(ready)
                }
                Err(error) => {
                    let _ = self.copies.dispose_locked(&mut state, &self.id);
                    Err(error.message().to_owned())
                }
            }
        }
    }
}

pub struct ShelfCopyJob(CopyJob);

impl ShelfCopyJob {
    pub fn run(self, source: String) -> Result<ShelfAsset, String> {
        self.0.prepare(source)?;
        let state = self.0.copies.0.state.lock().unwrap();
        if self.0.cancelled.load(Ordering::Acquire) || state.paused || state.stopping { return Err(CopyError::Cancelled.message().into()); }
        state.operations[&self.0.id].shelf.clone().ok_or_else(|| CopyError::InvalidOperation.message().to_owned())
    }
}

impl Drop for CopyJob {
    fn drop(&mut self) {
        // Runs inside the blocking task, even if its awaiting webview goes away.
        let mut state = self.copies.0.state.lock().unwrap();
        if let Some(operation) = state.operations.get_mut(&self.id) {
            operation.preparing = false;
            operation.refresh_ownership();
        }
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

    trait Fixture<T> { fn fixture(self) -> T; }
    impl<T, E> Fixture<T> for Result<T, E> {
        fn fixture(self) -> T { self.unwrap_or_else(|_| panic!("synthetic native shelf fixture failed")) }
    }
    impl<T> Fixture<T> for Option<T> {
        fn fixture(self) -> T { self.unwrap_or_else(|| panic!("synthetic native shelf fixture failed")) }
    }

    fn shelf_ids(index: u64) -> (String, String) {
        (format!("00000000-0000-4000-8000-{index:012x}"),
         format!("00000000-0000-4000-9000-{index:012x}"))
    }

    fn shelf_copy(source: &str, copies: &DropCopies, index: u64) -> ShelfAsset {
        let (item, operation) = shelf_ids(index);
        let asset = copies.begin_shelf(item, operation)
            .unwrap_or_else(|_| panic!("synthetic shelf admission failed"))
            .run(source.to_owned())
            .unwrap_or_else(|_| panic!("synthetic shelf preparation failed"));
        assert!(std::fs::read(source).fixture() == b"synthetic", "shelf preparation changed original bytes");
        asset
    }

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
        let (item_id, operation_id) = shelf_ids(1);
        let ready = copies.begin_shelf(item_id.clone(), operation_id.clone())
            .unwrap_or_else(|_| panic!("synthetic copy admission failed"))
            .run(source.clone())
            .unwrap_or_else(|_| panic!("synthetic copy preparation failed"));
        let lease = copies.acquire(&ready.asset_id, ShelfLeasePurpose::Share)
            .unwrap_or_else(|_| panic!("synthetic native lease acquisition failed"));
        let path = lease.data.path.clone();
        let mut consumer = std::fs::File::open(&path)
            .unwrap_or_else(|_| panic!("synthetic native reader could not open"));

        // The legacy operation API must not bypass registered shelf leases.
        copies.cancel(&operation_id);
        copies.remove(&item_id).unwrap_or_else(|_| panic!("synthetic shelf removal failed"));
        let mut bytes = Vec::new();
        consumer.read_to_end(&mut bytes)
            .unwrap_or_else(|_| panic!("synthetic native reader could not read after cancel"));
        let path_usable = std::fs::File::open(&path).is_ok();
        drop(consumer);
        copies.release(&lease.lease_id).unwrap_or_else(|_| panic!("synthetic native lease release failed"));
        copies.shutdown();
        assert!(bytes == b"synthetic", "cancel changed native reader bytes");
        let original = std::fs::read(source)
            .unwrap_or_else(|_| panic!("synthetic original could not be read"));
        assert!(original == b"synthetic", "cancel changed original bytes");
        assert!(path_usable, "cancel invalidated ready managed pathname while native read consumer was open");
        assert!(!Path::new(&path).exists(), "last release retained revoked synthetic content");
    }

    #[test]
    fn shelf_receipts_have_native_uuids_and_no_path_authority() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        for invalid in ["", "legacy-1", "../outside", "00000000-0000-0000-0000-000000000000"] {
            let (item, operation) = shelf_ids(1);
            assert!(copies.begin_shelf(invalid.into(), operation).is_err(), "invalid shelf item was admitted");
            assert!(copies.begin_shelf(item, invalid.into()).is_err(), "invalid shelf operation was admitted");
        }
        let asset = shelf_copy(&source, &copies, 1);
        assert!(uuid::Uuid::parse_str(&asset.asset_id).is_ok_and(|id| !id.is_nil()), "asset ID is not a native UUID");
        let value = serde_json::to_value(&asset).unwrap_or_else(|_| panic!("synthetic receipt serialization failed"));
        assert!(value.get("path").is_none(), "shelf receipt exposed path authority");
        assert!(asset.name == "synthetic.txt" && asset.size == 9, "shelf receipt metadata changed");
        assert!(copies.begin_shelf(asset.item_id.clone(), shelf_ids(2).1).is_err(), "shelf item ID was reused");
        assert!(copies.begin_shelf(shelf_ids(2).0, asset.operation_id.clone()).is_err(), "shelf operation ID was reused");
        copies.remove(&asset.item_id).unwrap_or_else(|_| panic!("synthetic shelf removal failed"));
        assert!(copies.begin_shelf(asset.item_id.clone(), shelf_ids(3).1).is_err(), "removed shelf item ID was reused");
        assert!(copies.acquire(&asset.asset_id, ShelfLeasePurpose::Mail).is_err(), "removed asset was acquired");
        copies.shutdown_checked().unwrap_or_else(|_| panic!("synthetic shelf shutdown failed"));
        assert!(std::fs::read(source).fixture() == b"synthetic", "shelf IDs changed original bytes");
    }

    #[test]
    fn shelf_last_of_two_leases_controls_cleanup_and_duplicate_release_is_harmless() {
        use std::io::Read;
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let asset = shelf_copy(&source, &copies, 1);
        let mut first = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Share).fixture();
        let mut last = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Mail).fixture();
        assert!(uuid::Uuid::parse_str(&first.lease_id).is_ok_and(|id| !id.is_nil()), "lease ID is not a native UUID");
        assert!(first.asset_id == asset.asset_id && first.purpose == ShelfLeasePurpose::Share, "native lease lost its asset or purpose binding");
        assert!(first.lease_id != last.lease_id, "distinct native leases reused an ID");
        let path = first.data.path.clone();
        copies.remove(&asset.item_id).fixture();
        assert!(copies.acquire(&asset.asset_id, ShelfLeasePurpose::Share).is_err(), "removed asset admitted a new lease");
        for unknown in [&asset.asset_id, &asset.item_id, &asset.operation_id, "not-a-lease"] {
            copies.release(unknown).fixture();
        }
        copies.release(&first.lease_id).fixture();
        copies.release(&first.lease_id).fixture();
        assert!(first.read(&mut [0; 1]).is_err(), "released native reader remained usable");
        assert!(std::fs::read(&path).fixture() == b"synthetic", "early or duplicate release removed a leased pathname");
        let mut bytes = Vec::new();
        last.read_to_end(&mut bytes).fixture();
        assert!(bytes == b"synthetic", "last native reader changed bytes");
        copies.release(&last.lease_id).fixture();
        assert!(!Path::new(&path).exists(), "last native lease did not dispose revoked content");
        assert!(std::fs::read(source).fixture() == b"synthetic", "lease release changed original bytes");
        copies.shutdown_checked().fixture();
    }

    #[test]
    fn cross_asset_ids_have_no_cleanup_authority_and_live_legacy_revoke_preserves_leases() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let left = shelf_copy(&source, &copies, 1);
        let right = shelf_copy(&source, &copies, 2);
        let lease = copies.acquire(&left.asset_id, ShelfLeasePurpose::Share).fixture();
        let right_lease = copies.acquire(&right.asset_id, ShelfLeasePurpose::Mail).fixture();
        assert!(copies.acquire(&right.operation_id, ShelfLeasePurpose::Share).is_err(), "operation ID acquired an asset");
        assert!(copies.acquire(&left.item_id, ShelfLeasePurpose::Share).is_err(), "item ID acquired an asset");
        copies.release(&right.asset_id).fixture();
        copies.remove(&right.asset_id).fixture();
        copies.cancel(&left.asset_id);
        copies.cancel(&lease.lease_id);
        assert!(copies.revoke(&left.operation_id), "known shelf operation was not revoked");
        copies.cancel(&left.operation_id);
        // The primitive shares the same owner: even direct legacy disposal may
        // revoke, but cannot unlink an asset with a registered native lease.
        file_copy::discard(&copies.0.root, &left.operation_id).fixture();
        assert!(std::fs::read(&lease.data.path).fixture() == b"synthetic", "legacy cancellation bypassed native leases");
        assert!(std::fs::read(&right_lease.data.path).fixture() == b"synthetic", "cross-asset ID removed another copy");
        copies.release(&lease.lease_id).fixture();
        assert!(!Path::new(&lease.data.path).exists(), "revoked asset survived its last release");
        copies.release(&right_lease.lease_id).fixture();
        copies.remove(&right.item_id).fixture();
        assert!(std::fs::read(source).fixture() == b"synthetic", "cross-asset operation changed original bytes");
        copies.shutdown_checked().fixture();
    }

    #[test]
    fn shelf_revocation_before_admission_worker_and_publication_prevents_ready_delivery() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let (item, operation) = shelf_ids(1);
        copies.revoke(&operation);
        assert!(copies.begin_shelf(item, operation).is_err(), "retired shelf operation was admitted");
        let (item, operation) = shelf_ids(2);
        copies.remove(&item).fixture();
        assert!(copies.begin_shelf(item, operation).is_err(), "removed unseen shelf item was admitted");
        let (item, operation) = shelf_ids(3);
        let job = copies.begin_shelf(item.clone(), operation.clone()).fixture();
        copies.remove(&item).fixture();
        assert!(job.run(source.clone()).is_err(), "removed pending shelf job delivered an asset");
        assert!(!copies.0.root.join(&operation).exists(), "removed pending shelf job retained content");
        let (item, operation) = shelf_ids(4);
        let control = copies.clone();
        let removed_item = item.clone();
        file_copy::test_hook(move |phase| {
            if phase == file_copy::CopyPhase::BeforePublish { control.remove(&removed_item).fixture(); }
            Ok(())
        });
        assert!(copies.begin_shelf(item, operation.clone()).fixture().run(source.clone()).is_err(), "removal at publication delivered a shelf asset");
        assert!(!copies.0.root.join(&operation).exists(), "removed publication retained content");
        assert!(std::fs::read(source).fixture() == b"synthetic", "shelf revocation changed original bytes");
        copies.shutdown_checked().fixture();
    }

    #[test]
    fn shelf_pause_revokes_preparation_without_revoking_registered_ready_readers() {
        use std::io::Read;
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let asset = shelf_copy(&source, &copies, 1);
        let mut held = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Drag).fixture();
        let (item, operation) = shelf_ids(2);
        let pending = copies.begin_shelf(item, operation.clone()).fixture();
        copies.pause(true);
        assert!(copies.acquire(&asset.asset_id, ShelfLeasePurpose::Drag).is_err(), "paused shelf admitted a new lease");
        copies.pause(false);
        assert!(pending.run(source.clone()).is_err(), "resume revived revoked shelf preparation");
        assert!(!copies.0.root.join(&operation).exists(), "paused preparation retained synthetic content");
        let mut bytes = Vec::new();
        held.read_to_end(&mut bytes).fixture();
        assert!(bytes == b"synthetic", "pause invalidated a registered native reader");
        let resumed = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Drag).fixture();
        copies.release(held.lease_id()).fixture();
        drop(resumed);
        copies.remove(&asset.item_id).fixture();
        copies.shutdown_checked().fixture();
        assert!(std::fs::read(source).fixture() == b"synthetic", "shelf pause changed original bytes");
    }

    #[test]
    fn shelf_shutdown_waits_for_native_leases_and_refuses_acquisition_after_stop() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let asset = shelf_copy(&source, &copies, 1);
        let first = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Share).fixture();
        let last = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Mail).fixture();
        let (done, completion) = mpsc::channel();
        std::thread::scope(|scope| {
            let stopping = scope.spawn(|| { done.send(copies.shutdown_checked()).fixture(); });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !copies.0.state.lock().fixture().stopping && Instant::now() < deadline { std::thread::yield_now(); }
            let stopped_admission = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Share).is_err();
            let first_completion = completion.recv_timeout(Duration::from_millis(100));
            let waited_for_first = matches!(&first_completion, Err(mpsc::RecvTimeoutError::Timeout));
            let path = first.data.path.clone();
            let held_path = std::fs::File::open(&path).is_ok();
            let first_release = copies.release(&first.lease_id);
            let last_completion = completion.recv_timeout(Duration::from_millis(100));
            let waited_for_last = matches!(&last_completion, Err(mpsc::RecvTimeoutError::Timeout));
            let last_release = copies.release(&last.lease_id);
            let completed = first_completion.ok().or(last_completion.ok())
                .or_else(|| completion.recv_timeout(Duration::from_secs(5)).ok());
            // No unstick: notifying here would wake the very condvar wait this
            // case exists to prove, so a missing notify would pass silently.
            assert!(completed.is_some(), "last release did not wake native shutdown");
            stopping.join().fixture();
            first_release.fixture();
            last_release.fixture();
            completed.fixture().fixture();
            assert!(stopped_admission, "stopping shelf admitted a native lease");
            assert!(waited_for_first && waited_for_last, "shutdown returned while a native lease was active");
            assert!(held_path, "shutdown invalidated a leased pathname");
            assert!(!Path::new(&path).exists(), "shutdown retained released shelf content");
        });
        assert_eq!(copies.request_exit(), None);
        assert!(std::fs::read(source).fixture() == b"synthetic", "shelf shutdown changed original bytes");
    }

    #[test]
    fn failed_duplicate_admission_never_borrows_another_native_owners_cleanup_authority() {
        for shelf in [false, true] {
            let root = Root::new();
            let source = root.source();
            let copies = root.copies();
            let (item, operation) = shelf_ids(1);
            let foreign = file_copy::copy_into(Path::new(&source), &copies.0.root, &operation, &AtomicBool::new(false)).fixture();
            let result = if shelf {
                copies.begin_shelf(item.clone(), operation.clone()).fixture().run(source.clone()).map(|_| ())
            } else {
                copies.begin(operation.clone()).fixture().run(source.clone()).map(|_| ())
            };
            assert!(result.is_err(), "duplicate native copy was delivered");
            copies.cancel(&operation);
            copies.remove(&item).fixture();
            copies.shutdown_checked().fixture();
            assert!(std::fs::read(&foreign.path).fixture() == b"synthetic", "failed admission borrowed another owner's cleanup authority");
            assert!(std::fs::read(source).fixture() == b"synthetic", "duplicate admission changed original bytes");
            file_copy::discard(&copies.0.root, &operation).fixture();
        }
    }

    #[test]
    fn shelf_worker_unwind_retains_native_authority_for_failed_cleanup() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let (item, operation) = shelf_ids(1);
        let job = copies.begin_shelf(item, operation.clone()).fixture();
        let foreign = copies.0.root.join(&operation).join("foreign");
        let injected = foreign.clone();
        file_copy::test_hook(move |phase| {
            if phase == file_copy::CopyPhase::BeforePublish {
                std::fs::write(&injected, b"foreign").fixture();
                panic!("synthetic shelf worker unwind");
            }
            Ok(())
        });
        assert!(std::panic::catch_unwind(|| job.run(source.clone())).is_err(), "synthetic shelf worker did not unwind");
        assert!(copies.shutdown_checked().is_err(), "worker unwind abandoned failed cleanup authority");
        assert_eq!(copies.request_exit(), None);
        assert!(std::fs::read(&foreign).fixture() == b"foreign", "worker unwind deleted unowned bytes");
        assert!(std::fs::read(source).fixture() == b"synthetic", "worker unwind changed original bytes");
        std::fs::remove_file(foreign).fixture();
        copies.shutdown_checked().fixture();
    }

    #[test]
    fn shelf_asset_and_lease_pressure_refuses_without_evicting_detached_assets() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let assets = (1..=32).map(|index| shelf_copy(&source, &copies, index)).collect::<Vec<_>>();
        let detached = copies.acquire(&assets[0].asset_id, ShelfLeasePurpose::Share).fixture();
        copies.remove(&assets[0].item_id).fixture();
        let (item, operation) = shelf_ids(33);
        assert!(copies.begin_shelf(item.clone(), operation.clone()).is_err(), "detached leased asset was evicted under pressure");
        assert!(std::fs::read(&detached.data.path).fixture() == b"synthetic", "asset pressure invalidated detached content");
        copies.release(&detached.lease_id).fixture();
        let admitted = copies.begin_shelf(item, operation).fixture().run(source.clone()).fixture();
        let purposes = [ShelfLeasePurpose::Drag, ShelfLeasePurpose::Share, ShelfLeasePurpose::Mail, ShelfLeasePurpose::Transfer];
        let leases = (0..32).map(|index| {
            let purpose = purposes[index % 4];
            let lease = copies.acquire(&assets[1].asset_id, purpose).fixture();
            assert!(lease.purpose == purpose, "native lease lost its requested purpose");
            lease
        }).collect::<Vec<_>>();
        assert!(copies.acquire(&assets[1].asset_id, ShelfLeasePurpose::Mail).is_err(), "native lease ceiling was exceeded");
        copies.release(&assets[1].asset_id).fixture();
        assert!(copies.acquire(&admitted.asset_id, ShelfLeasePurpose::Share).is_err(), "unknown release freed a live native lease slot");
        copies.release(&leases[0].lease_id).fixture();
        let fresh = copies.acquire(&admitted.asset_id, ShelfLeasePurpose::Share).fixture();
        assert!(std::fs::read(&fresh.data.path).fixture() == b"synthetic", "lease pressure evicted a ready asset");
        drop(leases);
        drop(fresh);
        copies.shutdown_checked().fixture();
        assert!(std::fs::read(source).fixture() == b"synthetic", "shelf pressure changed original bytes");
    }

    #[test]
    fn shelf_cleanup_failure_remains_owned_and_never_allows_exit() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let asset = shelf_copy(&source, &copies, 1);
        let lease = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Share).fixture();
        let foreign = Path::new(&lease.data.path).parent().fixture().join("foreign");
        std::fs::write(&foreign, b"foreign").fixture();
        copies.remove(&asset.item_id).fixture();
        assert!(copies.release(&lease.lease_id).is_err(), "failed native cleanup was promoted as successful release");
        for index in 2..=32 { let _ = shelf_copy(&source, &copies, index); }
        let (item, operation) = shelf_ids(33);
        assert!(copies.begin_shelf(item, operation.clone()).is_err(), "failed disposal was evicted from the native asset ceiling");
        assert!(copies.shutdown_checked().is_err(), "failed native cleanup was promoted as successful shutdown");
        // Reported, not silent — and the app can still quit: the unremovable
        // foreign entry is one no retry can ever clear.
        assert_eq!(copies.request_exit(), None);
        assert!(std::fs::read(&foreign).fixture() == b"foreign", "native cleanup deleted an unowned entry");
        assert!(std::fs::read(source).fixture() == b"synthetic", "failed cleanup changed original bytes");
        std::fs::remove_file(foreign).fixture(); // Test-owned synthetic foreign fixture.
        assert!(copies.0.root.join(&asset.operation_id).exists(),
            "failed disposal was not retained after its obstruction was removed");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shelf_acquisition_rejects_changed_or_foreign_ready_namespace() {
        for changed in ["root", "operation", "content", "bytes"] {
            let root = Root::new();
            let source = root.source();
            let copies = root.copies();
            let asset = shelf_copy(&source, &copies, 1);
            let lease = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Share).fixture();
            let path = PathBuf::from(&lease.data.path);
            copies.release(&lease.lease_id).fixture();
            let original = match changed {
                "root" => copies.0.root.clone(),
                "operation" => path.parent().fixture().to_owned(),
                _ => path.clone(),
            };
            let moved = root.0.join("saved-owned");
            if changed == "bytes" {
                std::fs::write(&path, b"altered!!").fixture();
            } else {
                std::fs::rename(&original, &moved).fixture();
                if changed == "content" { std::fs::write(&original, b"foreign").fixture(); }
                else { std::fs::create_dir(&original).fixture(); std::fs::write(original.join("foreign"), b"foreign").fixture(); }
            }
            assert!(copies.acquire(&asset.asset_id, ShelfLeasePurpose::Mail).is_err(), "changed or foreign ready namespace was leased");
            if changed != "bytes" {
                let foreign = if changed == "content" { original.clone() } else { original.join("foreign") };
                assert!(std::fs::read(&foreign).fixture() == b"foreign", "acquisition changed foreign namespace bytes");
                std::fs::remove_file(foreign).fixture();
                if changed != "content" { std::fs::remove_dir(&original).fixture(); }
                std::fs::rename(&moved, &original).fixture();
            }
            copies.remove(&asset.item_id).fixture();
            copies.shutdown_checked().fixture();
            assert!(std::fs::read(source).fixture() == b"synthetic", "ready namespace changes affected original bytes");
        }
    }

    #[cfg(windows)]
    #[test]
    fn shelf_native_pins_refuse_ready_namespace_replacement_and_writes() {
        let root = Root::new();
        let source = root.source();
        let copies = root.copies();
        let asset = shelf_copy(&source, &copies, 1);
        let lease = copies.acquire(&asset.asset_id, ShelfLeasePurpose::Share).fixture();
        let path = PathBuf::from(&lease.data.path);
        assert!(std::fs::File::options().write(true).open(&path).is_err(), "ready content lost its no-share-write pin");
        assert!(std::fs::rename(&path, root.0.join("moved-content")).is_err(), "ready content lost its no-share-delete pin");
        assert!(std::fs::rename(path.parent().fixture(), root.0.join("moved-operation")).is_err(), "ready operation directory lost its pin");
        assert!(std::fs::rename(&copies.0.root, root.0.join("moved-root")).is_err(), "ready root lost its pin");
        copies.remove(&asset.item_id).fixture();
        assert!(std::fs::read(&path).fixture() == b"synthetic", "remove invalidated pinned leased content");
        copies.release(&lease.lease_id).fixture();
        copies.shutdown_checked().fixture();
        assert!(std::fs::read(source).fixture() == b"synthetic", "ready pins changed original bytes");
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
