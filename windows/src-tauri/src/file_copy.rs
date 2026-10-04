// File copies have exclusive, private operation directories. All filesystem
// access is anchored to native handles; caller-provided IDs are never paths.
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug)]
pub struct CopiedFile {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyError {
    InvalidSource,
    Denied,
    Storage,
    Cancelled,
    InvalidOperation,
    DuplicateOperation,
}

impl CopyError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidSource => "Select an unchanged regular file without symbolic links.",
            Self::Denied => "File access denied.",
            Self::Storage => "Could not prepare file storage.",
            Self::Cancelled => "File preparation cancelled.",
            Self::InvalidOperation => "Invalid file operation.",
            Self::DuplicateOperation => "File operation already used.",
        }
    }
}

fn io_error(error: std::io::Error) -> CopyError {
    if error.kind() == std::io::ErrorKind::PermissionDenied { CopyError::Denied } else { CopyError::Storage }
}

pub fn validate_id(id: &str) -> Result<(), CopyError> {
    if (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(())
    } else { Err(CopyError::InvalidOperation) }
}

fn absolute(path: &Path) -> Result<PathBuf, CopyError> {
    let path = if path.is_absolute() { path.to_owned() } else { std::env::current_dir().map_err(io_error)?.join(path) };
    if path.components().any(|c| matches!(c, Component::ParentDir)) { return Err(CopyError::InvalidSource); }
    Ok(path.components().collect())
}

struct Owned {
    root: native::Dir,
    dir: native::Dir,
    content: Option<File>,
    marker: Option<native::CleanupMarker>,
    partial: String,
    name: String,
    preparing: bool,
    ready: bool,
}

struct Operation {
    cancelled: AtomicBool,
    owned: Mutex<Option<Owned>>,
}

type Key = (PathBuf, String);
type Registry = HashMap<Key, Arc<Operation>>;
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> { REGISTRY.get_or_init(|| Mutex::new(HashMap::new())) }

struct WorkerCleanup<'a> {
    operation: Arc<Operation>,
    id: &'a str,
    complete: bool,
}

impl Drop for WorkerCleanup<'_> {
    fn drop(&mut self) {
        if !self.complete {
            if let Some(owned) = self.operation.owned.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                owned.preparing = false;
            }
            // Keep failed cleanup owned and retryable; never publish failure.
            let _ = cleanup(&self.operation, self.id);
        }
        #[cfg(test)]
        HOOK.with(|slot| *slot.borrow_mut() = None);
    }
}

// Tombstones refuse ID reuse even after cancellation. Fail closed on pressure,
// rather than evicting completed copies that may be leased by a later exporter.
pub(crate) const MAX_OPERATIONS: usize = 4096;
const MAX_REAP_ENTRIES: usize = 4096;

#[derive(Debug, Default)]
pub struct ReapOutcome {
    pub inspected: usize,
    pub reaped: usize,
    pub limit_reached: bool,
    pub supported: bool,
}

/// Cleanup authority only: bounded native-selected root, no shelf/history load.
pub fn reap_abandoned(root: &Path) -> Result<ReapOutcome, CopyError> {
    native::reap(&absolute(root)?, MAX_REAP_ENTRIES).map_err(io_error)
}

fn cleanup(operation: &Operation, id: &str) -> Result<(), CopyError> {
    let mut slot = operation.owned.lock().unwrap_or_else(|e| e.into_inner());
    let Some(owned) = slot.as_mut() else { return Ok(()); };
    if owned.preparing { return Ok(()); } // The worker owns cleanup until its I/O ends.
    if let Some(content) = &owned.content {
        native::remove_content(&owned.dir, if owned.ready { &owned.name } else { &owned.partial }, content).map_err(io_error)?;
        // Windows deletes a marked file only when its last owned handle closes.
        owned.content = None;
    }
    native::remove_dir(&owned.root, id, &owned.dir).map_err(io_error)?;
    if let Some(marker) = &owned.marker { native::remove_owner(&owned.root, id, marker).map_err(io_error)?; }
    *slot = None;
    Ok(())
}

pub fn discard(root: &Path, operation_id: &str) -> Result<(), CopyError> {
    validate_id(operation_id)?;
    let key = (absolute(root)?, operation_id.to_owned());
    let operation = registry().lock().unwrap().get(&key).cloned().ok_or(CopyError::InvalidOperation)?;
    {
        // Publish and revoke share this owner boundary. No filesystem deletion
        // can race a worker still using its partial handle.
        let _owner = operation.owned.lock().unwrap();
        operation.cancelled.store(true, Ordering::Release);
    }
    cleanup(&operation, operation_id)
}

pub fn copy_into(source: &Path, root: &Path, operation_id: &str, cancelled: &AtomicBool) -> Result<CopiedFile, CopyError> {
    validate_id(operation_id)?;
    if cancelled.load(Ordering::Acquire) { return Err(CopyError::Cancelled); }
    let root_path = absolute(root)?;
    let source = absolute(source)?;
    let name = source.file_name().and_then(|n| n.to_str()).filter(|n| !n.is_empty()).ok_or(CopyError::InvalidSource)?.to_owned();
    let mut input = native::open_source(&source)?;
    let before = input.metadata().map_err(io_error)?;
    if !before.is_file() { return Err(CopyError::InvalidSource); }
    let key = (root_path.clone(), operation_id.to_owned());
    let operation = {
        let mut entries = registry().lock().unwrap();
        if entries.contains_key(&key) { return Err(CopyError::DuplicateOperation); }
        if entries.len() >= MAX_OPERATIONS { return Err(CopyError::Storage); }
        let operation = Arc::new(Operation { cancelled: AtomicBool::new(false), owned: Mutex::new(None) });
        // Admission consumes the ID even if storage preparation fails.
        entries.insert(key, operation.clone());
        operation
    };
    let mut worker = WorkerCleanup { operation: operation.clone(), id: operation_id, complete: false };
    let result = (|| {
        if cancelled.load(Ordering::Acquire) || operation.cancelled.load(Ordering::Acquire) { return Err(CopyError::Cancelled); }
        let root = native::open_root(&root_path).map_err(io_error)?;
        let dir = native::create_dir(&root, operation_id).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists { CopyError::DuplicateOperation } else { io_error(e) }
        })?;
        let partial = if name == ".partial" { ".partial-copy" } else { ".partial" }.to_owned();
        let content = match native::create_file(&dir, &partial) {
            Ok(file) => file,
            Err(error) => {
                let _ = native::remove_dir(&root, operation_id, &dir);
                return Err(io_error(error));
            }
        };
        let mut output = {
            let mut owner = operation.owned.lock().unwrap();
            *owner = Some(Owned { root, dir, content: Some(content), marker: None, partial, name: name.clone(), preparing: true, ready: false });
            let owned = owner.as_mut().unwrap();
            owned.marker = native::register_owner(&owned.root, &owned.dir, operation_id, owned.content.as_ref().unwrap()).map_err(io_error)?;
            owned.content.as_ref().unwrap().try_clone().map_err(io_error)?
        };
        let mut total = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            if cancelled.load(Ordering::Acquire) || operation.cancelled.load(Ordering::Acquire) { return Err(CopyError::Cancelled); }
            let read = input.read(&mut chunk).map_err(io_error)?;
            if read == 0 { break; }
            total += read as u64;
            if total > before.len() { return Err(CopyError::InvalidSource); }
            output.write_all(&chunk[..read]).map_err(io_error)?;
            #[cfg(test)]
            checkpoint(CopyPhase::Chunk)?;
        }
        output.flush().map_err(io_error)?;
        output.sync_all().map_err(io_error)?;
        let after = input.metadata().map_err(io_error)?;
        if total != before.len() || !native::unchanged(&before, &after) { return Err(CopyError::InvalidSource); }
        #[cfg(test)]
        checkpoint(CopyPhase::BeforePublish)?;
        let mut owner = operation.owned.lock().unwrap();
        let owned = owner.as_mut().ok_or(CopyError::Cancelled)?;
        if cancelled.load(Ordering::Acquire) || operation.cancelled.load(Ordering::Acquire) { return Err(CopyError::Cancelled); }
        // A path usable by the frontend must still resolve to the pinned root
        // and operation directory. A swapped ancestor fails rather than returning
        // a path through it; cleanup stays anchored to our original handles.
        native::verify_location(&root_path, operation_id, &owned.root, &owned.dir).map_err(io_error)?;
        if !native::unchanged(&before, &input.metadata().map_err(io_error)?) { return Err(CopyError::InvalidSource); }
        native::publish(&owned.dir, &owned.partial, &owned.name, owned.content.as_ref().unwrap()).map_err(io_error)?;
        owned.ready = true;
        native::verify_location(&root_path, operation_id, &owned.root, &owned.dir).map_err(io_error)?;
        if cancelled.load(Ordering::Acquire) || operation.cancelled.load(Ordering::Acquire) { return Err(CopyError::Cancelled); }
        owned.preparing = false;
        Ok(CopiedFile { name, path: root_path.join(operation_id).join(&owned.name), size: total })
    })();
    worker.complete = result.is_ok();
    result
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CopyPhase { Chunk, BeforePublish }
#[cfg(test)]
thread_local! {
    static HOOK: std::cell::RefCell<Option<Box<dyn FnMut(CopyPhase) -> Result<(), CopyError>>>> = std::cell::RefCell::new(None);
}
#[cfg(test)]
pub fn test_hook(hook: impl FnMut(CopyPhase) -> Result<(), CopyError> + 'static) {
    HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}
#[cfg(test)]
fn checkpoint(phase: CopyPhase) -> Result<(), CopyError> {
    HOOK.with(|slot| match slot.borrow_mut().as_mut() { Some(hook) => hook(phase), None => Ok(()) })
}

#[cfg(target_os = "linux")]
mod native {
    use super::*;
    use std::ffi::{CString, OsStr};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    const DIRECTORY: i32 = 0x10000;
    const NOFOLLOW: i32 = 0x20000;
    const CLOEXEC: i32 = 0x80000;
    const NONBLOCK: i32 = 0x800;
    unsafe extern "C" {
        fn openat(fd: i32, name: *const std::ffi::c_char, flags: i32, mode: u32) -> i32;
        fn mkdirat(fd: i32, name: *const std::ffi::c_char, mode: u32) -> i32;
        fn unlinkat(fd: i32, name: *const std::ffi::c_char, flags: i32) -> i32;
        fn renameat2(fd: i32, from: *const std::ffi::c_char, to_fd: i32, to: *const std::ffi::c_char, flags: u32) -> i32;
        fn getuid() -> u32;
        fn flock(fd: i32, operation: i32) -> i32;
    }
    pub struct Dir { file: File }
    pub struct CleanupMarker { file: File }
    fn name(name: &OsStr) -> io::Result<CString> {
        CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }
    fn status(value: i32) -> io::Result<()> { if value == 0 { Ok(()) } else { Err(io::Error::last_os_error()) } }
    fn open(dir: &Dir, component: &OsStr, flags: i32) -> io::Result<File> {
        let component = name(component)?;
        // All names passed to openat are single components of a pinned parent.
        let fd = unsafe { openat(dir.file.as_raw_fd(), component.as_ptr(), flags | NOFOLLOW | CLOEXEC, 0o600) };
        if fd < 0 { Err(io::Error::last_os_error()) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
    }
    fn walk(path: &Path, create: bool) -> io::Result<Dir> {
        let mut dir = Dir { file: File::options().read(true).custom_flags(DIRECTORY | NOFOLLOW | CLOEXEC).open("/")? };
        for component in path.components() {
            match component {
                Component::RootDir => (),
                Component::Normal(component) => {
                    let file = match open(&dir, component, DIRECTORY) {
                        Ok(file) => file,
                        Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                            let n = name(component)?;
                            if unsafe { mkdirat(dir.file.as_raw_fd(), n.as_ptr(), 0o700) } != 0 {
                                let error = io::Error::last_os_error();
                                if error.kind() != io::ErrorKind::AlreadyExists { return Err(error); }
                            }
                            open(&dir, component, DIRECTORY)?
                        }
                        Err(error) => return Err(error),
                    };
                    dir = Dir { file };
                }
                _ => return Err(io::Error::from(io::ErrorKind::InvalidInput)),
            }
        }
        Ok(dir)
    }
    pub fn open_root(path: &Path) -> io::Result<Dir> {
        let dir = walk(path, true)?;
        let metadata = dir.file.metadata()?;
        if metadata.uid() != unsafe { getuid() } || metadata.mode() & 0o077 != 0 {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        Ok(dir)
    }
    pub fn open_source(path: &Path) -> Result<File, CopyError> {
        let parent = walk(path.parent().ok_or(CopyError::InvalidSource)?, false).map_err(|e| {
            if e.kind() == io::ErrorKind::PermissionDenied { CopyError::Denied } else { CopyError::InvalidSource }
        })?;
        // NONBLOCK ensures a selected FIFO cannot hang a blocking worker before
        // the regular-file check. It has no effect on regular disk files.
        open(&parent, path.file_name().ok_or(CopyError::InvalidSource)?, NONBLOCK).map_err(|e| {
            if e.kind() == io::ErrorKind::PermissionDenied { CopyError::Denied } else { CopyError::InvalidSource }
        })
    }
    pub fn create_dir(root: &Dir, id: &str) -> io::Result<Dir> {
        let n = name(OsStr::new(id))?;
        status(unsafe { mkdirat(root.file.as_raw_fd(), n.as_ptr(), 0o700) })?;
        Ok(Dir { file: open(root, OsStr::new(id), DIRECTORY)? })
    }
    pub fn create_file(dir: &Dir, n: &str) -> io::Result<File> { open(dir, OsStr::new(n), 2 | 0x40 | 0x80) }
    fn same(a: &File, b: &File) -> io::Result<bool> {
        let a = a.metadata()?;
        let b = b.metadata()?;
        Ok(a.dev() == b.dev() && a.ino() == b.ino())
    }
    pub fn verify_location(path: &Path, id: &str, root: &Dir, dir: &Dir) -> io::Result<()> {
        let current = walk(path, false)?;
        if !same(&current.file, &root.file)? || !same(&open(&current, OsStr::new(id), DIRECTORY)?, &dir.file)? {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        Ok(())
    }
    pub fn unchanged(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
        a.len() == b.len() && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
    }
    pub fn publish(dir: &Dir, from: &str, to: &str, content: &File) -> io::Result<()> {
        if !same(&open(dir, OsStr::new(from), 0)?, content)? { return Err(io::Error::from(io::ErrorKind::PermissionDenied)); }
        let from = name(OsStr::new(from))?;
        let to = name(OsStr::new(to))?;
        // RENAME_NOREPLACE is atomic and refuses an existing destination. A
        // filesystem without this native operation fails closed (no fallback).
        status(unsafe { renameat2(dir.file.as_raw_fd(), from.as_ptr(), dir.file.as_raw_fd(), to.as_ptr(), 1) })
    }
    pub fn remove_content(dir: &Dir, n: &str, content: &File) -> io::Result<()> {
        match open(dir, OsStr::new(n), NONBLOCK) {
            Ok(current) if same(&current, content)? => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            _ => return Err(io::Error::from(io::ErrorKind::PermissionDenied)),
        }
        let n = name(OsStr::new(n))?;
        status(unsafe { unlinkat(dir.file.as_raw_fd(), n.as_ptr(), 0) })
    }
    pub fn remove_dir(root: &Dir, id: &str, dir: &Dir) -> io::Result<()> {
        match open(root, OsStr::new(id), DIRECTORY) {
            Ok(current) if same(&current, &dir.file)? => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            _ => return Err(io::Error::from(io::ErrorKind::PermissionDenied)),
        }
        let id = name(OsStr::new(id))?;
        status(unsafe { unlinkat(root.file.as_raw_fd(), id.as_ptr(), 0x200) })
    }

    const OWNER_PREFIX: &str = ".owner-";
    const OWNER_MAGIC: &[u8; 8] = b"CCCPY01\0";
    const OWNER_BYTES: usize = 72; // magic + root/directory/content/marker dev+inode

    fn identity(file: &File) -> io::Result<(u64, u64)> {
        let meta = file.metadata()?;
        Ok((meta.dev(), meta.ino()))
    }
    fn private_file(file: &File) -> io::Result<bool> {
        let meta = file.metadata()?;
        Ok(meta.is_file() && meta.uid() == unsafe { getuid() } && meta.mode() & 0o077 == 0 && meta.nlink() == 1)
    }
    fn private_dir(dir: &Dir) -> io::Result<bool> {
        let meta = dir.file.metadata()?;
        Ok(meta.is_dir() && meta.uid() == unsafe { getuid() } && meta.mode() & 0o077 == 0)
    }
    fn lock_owner(file: &File) -> io::Result<bool> {
        if unsafe { flock(file.as_raw_fd(), 2 | 4) } == 0 { return Ok(true); } // exclusive, nonblocking
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock { Ok(false) } else { Err(error) }
    }
    pub fn register_owner(root: &Dir, dir: &Dir, id: &str, content: &File) -> io::Result<Option<CleanupMarker>> {
        let mut file = create_file(root, &format!("{OWNER_PREFIX}{id}"))?;
        let result = (|| {
            if !lock_owner(&file)? { return Err(io::Error::from(io::ErrorKind::WouldBlock)); }
            let mut record = Vec::with_capacity(OWNER_BYTES);
            record.extend_from_slice(OWNER_MAGIC);
            // No source path, filename, size, display state or activity history.
            for handle in [&root.file, &dir.file, content, &file] {
                let (dev, ino) = identity(handle)?;
                record.extend_from_slice(&dev.to_le_bytes());
                record.extend_from_slice(&ino.to_le_bytes());
            }
            file.write_all(&record)?;
            file.sync_all()?;
            dir.file.sync_all()?;
            root.file.sync_all()
        })();
        if let Err(error) = result {
            let _ = remove_content(root, &format!("{OWNER_PREFIX}{id}"), &file);
            return Err(error);
        }
        Ok(Some(CleanupMarker { file })) // Lease held until cleanup/process death.
    }
    pub fn remove_owner(root: &Dir, id: &str, marker: &CleanupMarker) -> io::Result<()> {
        remove_content(root, &format!("{OWNER_PREFIX}{id}"), &marker.file)
    }

    fn entries(dir: &Dir, limit: usize) -> io::Result<(Vec<std::ffi::OsString>, bool)> {
        // This kernel-generated descriptor path enumerates the pinned directory,
        // never a caller-selected symlink or an entry path. Every subsequent
        // file/directory open still uses openat(O_NOFOLLOW) on that same handle.
        // A Linux environment without procfs fails closed rather than falling
        // back to an unanchored filesystem path.
        let mut entries = std::fs::read_dir(format!("/proc/self/fd/{}", dir.file.as_raw_fd()))?;
        let mut names = Vec::new();
        for _ in 0..limit {
            match entries.next() {
                Some(entry) => names.push(entry?.file_name()),
                None => return Ok((names, false)),
            }
        }
        let more = entries.next().transpose()?.is_some();
        Ok((names, more))
    }
    fn record(file: &mut File) -> io::Result<Option<[(u64, u64); 4]>> {
        if !private_file(file)? || file.metadata()?.len() != OWNER_BYTES as u64 { return Ok(None); }
        let mut bytes = [0u8; OWNER_BYTES];
        file.read_exact(&mut bytes)?;
        if &bytes[..8] != OWNER_MAGIC { return Ok(None); }
        let mut identities = [(0, 0); 4];
        for (index, pair) in identities.iter_mut().enumerate() {
            let offset = 8 + 16 * index;
            *pair = (u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap()),
                     u64::from_le_bytes(bytes[offset + 8..offset + 16].try_into().unwrap()));
        }
        Ok(Some(identities))
    }
    fn reap_one(root: &Dir, id: &str) -> io::Result<bool> {
        let mut marker = open(root, OsStr::new(&format!("{OWNER_PREFIX}{id}")), 2 | NONBLOCK)?;
        if !private_file(&marker)? || !lock_owner(&marker)? { return Ok(false); }
        let Some(identities) = record(&mut marker)? else { return Ok(false); };
        if identity(&root.file)? != identities[0] || identity(&marker)? != identities[3] { return Ok(false); }
        let dir = match open(root, OsStr::new(id), DIRECTORY) {
            Ok(file) => Dir { file },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                remove_content(root, &format!("{OWNER_PREFIX}{id}"), &marker)?;
                return Ok(true); // Cleanup had removed the directory before crashing.
            }
            Err(error) => return Err(error),
        };
        if !private_dir(&dir)? || identity(&dir.file)? != identities[1] { return Ok(false); }
        let (names, more) = entries(&dir, 1)?;
        if more { return Ok(false); } // Any extra/foreign entry preserves the whole operation.
        if let Some(name) = names.first() {
            let content = open(&dir, name, NONBLOCK)?;
            if !private_file(&content)? || identity(&content)? != identities[2] { return Ok(false); }
            // Reject substitution again at removal; never recurse into entries.
            remove_content(&dir, name.to_str().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?, &content)?;
        }
        remove_dir(root, id, &dir)?;
        remove_content(root, &format!("{OWNER_PREFIX}{id}"), &marker)?;
        Ok(true)
    }
    pub fn reap(path: &Path, limit: usize) -> io::Result<ReapOutcome> {
        let root = match walk(path, false) {
            Ok(root) => root,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(ReapOutcome { supported: true, ..Default::default() }),
            Err(error) => return Err(error),
        };
        if !private_dir(&root)? { return Err(io::Error::from(io::ErrorKind::PermissionDenied)); }
        let (names, limit_reached) = entries(&root, limit)?;
        let mut outcome = ReapOutcome { inspected: names.len(), limit_reached, supported: true, ..Default::default() };
        for name in names {
            let Some(id) = name.to_str().and_then(|name| name.strip_prefix(OWNER_PREFIX)) else { continue; };
            if validate_id(id).is_ok() && matches!(reap_one(&root, id), Ok(true)) { outcome.reaped += 1; }
        }
        Ok(outcome)
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;

    const OPEN_REPARSE: u32 = 0x00200000;
    const BACKUP: u32 = 0x02000000;
    const REPARSE: u32 = 0x400;
    const DELETE: u32 = 0x10000;
    // Excluding FILE_SHARE_DELETE pins each ancestor against rename/reparse
    // replacement. Source handles also exclude FILE_SHARE_WRITE.
    pub struct Dir { file: File, path: PathBuf, _parents: Vec<File> }
    pub struct CleanupMarker;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(handle: *mut std::ffi::c_void, class: u32, info: *const std::ffi::c_void, size: u32) -> i32;
    }
    fn status(ok: i32) -> io::Result<()> { if ok != 0 { Ok(()) } else { Err(io::Error::last_os_error()) } }
    fn directory(path: &Path, owned: bool) -> io::Result<File> {
        let file = File::options().read(true).access_mode(0x80000000 | if owned { DELETE } else { 0 })
            .share_mode(1 | 2).custom_flags(OPEN_REPARSE | BACKUP).open(path)?;
        let meta = file.metadata()?;
        if !meta.is_dir() || meta.file_attributes() & REPARSE != 0 { return Err(io::Error::from(io::ErrorKind::InvalidInput)); }
        Ok(file)
    }
    fn walk(path: &Path, create: bool) -> io::Result<Dir> {
        let mut current = PathBuf::new();
        let mut parents = Vec::new();
        let components: Vec<_> = path.components().collect();
        // Ordinary drive/UNC paths only; device namespaces are not selected files.
        match components.first() {
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::UNC(_, _)) => (),
            _ => return Err(io::Error::from(io::ErrorKind::InvalidInput)),
        }
        for component in components {
            if let Component::Normal(n) = component {
                if n.to_string_lossy().contains(':') { return Err(io::Error::from(io::ErrorKind::InvalidInput)); }
            }
            current.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) { continue; }
            let file = match directory(&current, false) {
                Ok(file) => file,
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    match std::fs::create_dir(&current) {
                        Ok(()) => (),
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                        Err(error) => return Err(error),
                    }
                    directory(&current, false)?
                }
                Err(error) => return Err(error),
            };
            parents.push(file);
        }
        let file = parents.pop().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        Ok(Dir { file, path: path.to_owned(), _parents: parents })
    }
    pub fn open_root(path: &Path) -> io::Result<Dir> { walk(path, true) }
    pub fn open_source(path: &Path) -> Result<File, CopyError> {
        let _parents = walk(path.parent().ok_or(CopyError::InvalidSource)?, false).map_err(|_| CopyError::InvalidSource)?;
        if path.file_name().ok_or(CopyError::InvalidSource)?.to_string_lossy().contains(':') { return Err(CopyError::InvalidSource); }
        let file = File::options().read(true).share_mode(1).custom_flags(OPEN_REPARSE | BACKUP).open(path).map_err(io_error)?;
        let meta = file.metadata().map_err(io_error)?;
        if !meta.is_file() || meta.file_attributes() & REPARSE != 0 { return Err(CopyError::InvalidSource); }
        Ok(file)
    }
    pub fn create_dir(root: &Dir, id: &str) -> io::Result<Dir> {
        let path = root.path.join(id);
        std::fs::create_dir(&path)?;
        Ok(Dir { file: directory(&path, true)?, path, _parents: Vec::new() })
    }
    pub fn create_file(dir: &Dir, n: &str) -> io::Result<File> {
        File::options().read(true).write(true).create_new(true).access_mode(0xc0000000 | DELETE)
            .share_mode(1).custom_flags(OPEN_REPARSE).open(dir.path.join(n))
    }
    pub fn verify_location(_: &Path, _: &str, _: &Dir, _: &Dir) -> io::Result<()> { Ok(()) } // Pinned ancestors cannot be swapped.
    pub fn unchanged(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool { a.len() == b.len() && a.last_write_time() == b.last_write_time() }
    pub fn publish(dir: &Dir, _: &str, to: &str, content: &File) -> io::Result<()> {
        #[repr(C)]
        struct Rename { replace: u8, root: *mut std::ffi::c_void, length: u32, name: [u16; 1] }
        let name: Vec<u16> = std::ffi::OsStr::new(to).encode_wide().collect();
        let offset = std::mem::offset_of!(Rename, name);
        let size = std::mem::size_of::<Rename>().max(offset + name.len() * 2);
        let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let rename = buffer.as_mut_ptr().cast::<Rename>();
        unsafe {
            (*rename).replace = 0; // Never replace an existing destination.
            (*rename).root = dir.file.as_raw_handle();
            (*rename).length = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(name.as_ptr(), buffer.as_mut_ptr().cast::<u8>().add(offset).cast(), name.len());
            status(SetFileInformationByHandle(content.as_raw_handle(), 3, rename.cast(), size as u32))
        }
    }
    fn delete(file: &File) -> io::Result<()> {
        let delete = 1u8;
        unsafe { status(SetFileInformationByHandle(file.as_raw_handle(), 4, (&delete as *const u8).cast(), 1)) }
    }
    pub fn remove_content(_: &Dir, _: &str, content: &File) -> io::Result<()> { delete(content) }
    pub fn remove_dir(_: &Dir, _: &str, dir: &Dir) -> io::Result<()> { delete(&dir.file) }
    // Windows cleanup-marker identity/lease behavior needs a real Windows
    // qualification lane. Do not create markers or guess abandoned ownership.
    pub fn register_owner(_: &Dir, _: &Dir, _: &str, _: &File) -> io::Result<Option<CleanupMarker>> { Ok(None) }
    pub fn remove_owner(_: &Dir, _: &str, _: &CleanupMarker) -> io::Result<()> { Ok(()) }
    pub fn reap(_: &Path, _: usize) -> io::Result<ReapOutcome> { Ok(ReapOutcome::default()) }
}
