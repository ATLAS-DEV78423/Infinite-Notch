use std::path::PathBuf;
#[cfg(legacy_collision)]
use std::path::Path;
#[cfg(not(legacy_collision))]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let base = std::env::var_os("COUCOU_COPY_TEST_ROOT").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&base).unwrap();
        loop {
            let path = base.join(format!("coucou-copy-{}-{}", std::process::id(), NEXT_ROOT.fetch_add(1, Ordering::Relaxed)));
            match std::fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(_) => panic!("synthetic test root unavailable"),
            }
        }
    }
    fn source(&self, folder: &str, bytes: &[u8]) -> PathBuf {
        let dir = self.0.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.txt");
        std::fs::write(&path, bytes).unwrap();
        path
    }
    fn copies(&self) -> PathBuf { self.0.join("copies") }
}
impl Drop for Root {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

// Exact legacy name-reservation/copy algorithm, with an injected synthetic root
// and a barrier representing two workers scheduled between check and copy.
// It never calls settings::local_dir(), ingest(), or the live inbox.
#[cfg(legacy_collision)]
fn legacy_copy(src: &Path, root: &Path, before_copy: Option<&Barrier>) -> PathBuf {
    std::fs::create_dir_all(root).unwrap();
    let name = src.file_name().unwrap();
    let mut dest = root.join(name);
    if dest.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        for i in 2..1000 {
            let candidate = root.join(format!("{stem} ({i}){ext}"));
            if !candidate.exists() { dest = candidate; break; }
        }
    }
    if let Some(barrier) = before_copy { barrier.wait(); }
    std::fs::copy(src, &dest).unwrap();
    dest
}

#[cfg(legacy_collision)]
#[test]
fn thousand_duplicates_do_not_overwrite() {
    let root = Root::new();
    let source = root.source("source", b"first");
    let first = legacy_copy(&source, &root.copies(), None);
    std::fs::write(&source, b"later").unwrap();
    for _ in 1..1000 { legacy_copy(&source, &root.copies(), None); }
    assert!(std::fs::read(first).unwrap() == b"first", "legacy exhausted suffixes overwrote the first destination");
}

#[cfg(legacy_collision)]
#[test]
fn concurrent_same_name_preserves_bytes() {
    let root = Root::new();
    let a = root.source("a", b"first");
    let b = root.source("b", b"second");
    let barrier = Arc::new(Barrier::new(2));
    let copies = root.copies();
    std::thread::scope(|scope| {
        let left = scope.spawn(|| legacy_copy(&a, &copies, Some(&barrier)));
        let right = scope.spawn(|| legacy_copy(&b, &copies, Some(&barrier)));
        let left = left.join().unwrap();
        let right = right.join().unwrap();
        assert!(left != right, "legacy simultaneous drops share a destination");
    });
}

#[cfg(not(legacy_collision))]
#[path = "../windows/src-tauri/src/file_copy.rs"]
mod file_copy;

#[cfg(not(legacy_collision))]
mod checks {
    use super::*;
    use file_copy::{copy_into, discard, CopyError, CopyPhase};

    #[test]
    fn concurrent_same_name_preserves_bytes() {
        let root = Root::new();
        let a = root.source("a", b"first");
        let b = root.source("b", b"second");
        let barrier = Barrier::new(2);
        std::thread::scope(|scope| {
            let left = scope.spawn(|| { barrier.wait(); copy_into(&a, &root.copies(), "a", &AtomicBool::new(false)).unwrap() });
            let right = scope.spawn(|| { barrier.wait(); copy_into(&b, &root.copies(), "b", &AtomicBool::new(false)).unwrap() });
            let left = left.join().unwrap();
            let right = right.join().unwrap();
            assert_eq!(left.name, "note.txt");
            assert_eq!(left.size, 5);
            assert_eq!(right.size, 6);
            assert_ne!(left.path.parent(), right.path.parent());
            assert!(std::fs::read(&left.path).unwrap() == b"first");
            assert!(std::fs::read(&right.path).unwrap() == b"second");
            assert!(std::fs::read(&a).unwrap() == b"first");
            assert!(std::fs::read(&b).unwrap() == b"second");
        });
    }

    #[test]
    fn thousand_duplicates_do_not_overwrite() {
        let root = Root::new();
        let source = root.source("source", b"first");
        let first = copy_into(&source, &root.copies(), "first", &AtomicBool::new(false)).unwrap();
        std::fs::write(&source, b"later").unwrap();
        for i in 1..1000 {
            let copy = copy_into(&source, &root.copies(), &format!("op-{i}"), &AtomicBool::new(false)).unwrap();
            assert_ne!(copy.path.parent(), first.path.parent());
            assert!(std::fs::read(&copy.path).unwrap() == b"later");
            discard(&root.copies(), &format!("op-{i}")).unwrap();
        }
        assert!(std::fs::read(&first.path).unwrap() == b"first");
        assert!(std::fs::read(&source).unwrap() == b"later");
    }

    #[test]
    fn cancel_removes_only_owned_partial() {
        let root = Root::new();
        let source = root.source("source", &vec![7; 3 * 65536]);
        let first = copy_into(&source, &root.copies(), "ready", &AtomicBool::new(false)).unwrap();
        let unowned = root.copies().join("unowned");
        std::fs::create_dir(&unowned).unwrap();
        std::fs::write(unowned.join("keep"), b"keep").unwrap();
        let copies = root.copies();
        file_copy::test_hook(move |phase| {
            if phase == CopyPhase::Chunk { discard(&copies, "cancel").unwrap(); }
            Ok(())
        });
        assert!(matches!(copy_into(&source, &root.copies(), "cancel", &AtomicBool::new(false)), Err(CopyError::Cancelled)));
        assert!(!root.copies().join("cancel").exists());
        assert!(std::fs::read(&first.path).unwrap() == vec![7; 3 * 65536]);
        assert!(std::fs::read(unowned.join("keep")).unwrap() == b"keep");
        assert!(std::fs::read(source).unwrap() == vec![7; 3 * 65536]);
    }

    #[test]
    fn failure_does_not_publish_ready() {
        let root = Root::new();
        let source = root.source("source", &vec![9; 2 * 65536]);
        file_copy::test_hook(|phase| if phase == CopyPhase::Chunk { Err(CopyError::Storage) } else { Ok(()) });
        assert!(matches!(copy_into(&source, &root.copies(), "failed", &AtomicBool::new(false)), Err(CopyError::Storage)));
        assert!(!root.copies().join("failed").exists());
        assert!(std::fs::read(source).unwrap() == vec![9; 2 * 65536]);
    }

    #[test]
    fn invalid_or_reused_id_refused() {
        let root = Root::new();
        let source = root.source("source", b"synthetic");
        for id in ["", "../outside", "a_b", "/a", "é", &"a".repeat(65)] {
            assert!(matches!(copy_into(&source, &root.copies(), id, &AtomicBool::new(false)), Err(CopyError::InvalidOperation)));
            assert!(matches!(discard(&root.copies(), id), Err(CopyError::InvalidOperation)));
        }
        assert_eq!(CopyError::InvalidOperation.message(), "Invalid file operation.");
        let copy = copy_into(&source, &root.copies(), "used", &AtomicBool::new(false)).unwrap();
        assert!(matches!(copy_into(&source, &root.copies(), "used", &AtomicBool::new(false)), Err(CopyError::DuplicateOperation)));
        discard(&root.copies(), "used").unwrap();
        assert!(!copy.path.exists());
        assert!(matches!(copy_into(&source, &root.copies(), "used", &AtomicBool::new(false)), Err(CopyError::DuplicateOperation)));
        let unowned = root.copies().join("foreign");
        std::fs::create_dir(&unowned).unwrap();
        std::fs::write(unowned.join("keep"), b"keep").unwrap();
        assert!(matches!(discard(&root.copies(), "foreign"), Err(CopyError::InvalidOperation)));
        assert!(matches!(copy_into(&source, &root.copies(), "foreign", &AtomicBool::new(false)), Err(CopyError::DuplicateOperation)));
        assert!(std::fs::read(unowned.join("keep")).unwrap() == b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn root_and_source_symlinks_rejected() {
        use std::os::unix::fs::symlink;
        let root = Root::new();
        let source = root.source("source", b"synthetic");
        let link = root.0.join("source-link");
        symlink(&source, &link).unwrap();
        assert!(copy_into(&link, &root.copies(), "source-link", &AtomicBool::new(false)).is_err());
        let parent_link = root.0.join("parent-link");
        symlink(source.parent().unwrap(), &parent_link).unwrap();
        assert!(copy_into(&parent_link.join("note.txt"), &root.copies(), "parent-link", &AtomicBool::new(false)).is_err());
        let root_link = root.0.join("root-link");
        symlink(source.parent().unwrap(), &root_link).unwrap();
        assert!(copy_into(&source, &root_link, "root-link", &AtomicBool::new(false)).is_err());
        assert!(copy_into(&source, &root_link.join("nested"), "nested", &AtomicBool::new(false)).is_err());
        assert!(!source.parent().unwrap().join("nested").exists());
        assert!(copy_into(source.parent().unwrap(), &root.copies(), "directory", &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn cancel_before_publish_wins() {
        let root = Root::new();
        let source = root.source("source", b"synthetic");
        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        file_copy::test_hook(move |phase| { if phase == CopyPhase::BeforePublish { signal.store(true, Ordering::Release); } Ok(()) });
        assert!(matches!(copy_into(&source, &root.copies(), "cancelled", &cancelled), Err(CopyError::Cancelled)));
        assert!(!root.copies().join("cancelled").exists());
    }

    #[test]
    fn discard_races_publish_at_owner_boundary() {
        let root = Root::new();
        let source = root.source("source", b"synthetic");
        let barrier = Arc::new(Barrier::new(2));
        let copies = root.copies();
        let worker_barrier = barrier.clone();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                file_copy::test_hook(move |phase| {
                    if phase == CopyPhase::BeforePublish { worker_barrier.wait(); worker_barrier.wait(); }
                    Ok(())
                });
                copy_into(&source, &copies, "race", &AtomicBool::new(false))
            });
            barrier.wait();
            discard(&copies, "race").unwrap();
            barrier.wait();
            assert!(matches!(worker.join().unwrap(), Err(CopyError::Cancelled)));
        });
        assert!(!copies.join("race").exists());
    }

    #[cfg(unix)]
    #[test]
    fn source_mutation_is_not_ready() {
        let root = Root::new();
        let source = root.source("source", &vec![3; 2 * 65536]);
        let mutate = source.clone();
        file_copy::test_hook(move |phase| {
            if phase == CopyPhase::Chunk { std::fs::write(&mutate, b"changed").unwrap(); }
            Ok(())
        });
        assert!(matches!(copy_into(&source, &root.copies(), "mutation", &AtomicBool::new(false)), Err(CopyError::InvalidSource)));
        assert!(!root.copies().join("mutation").exists());
    }

    #[cfg(unix)]
    #[test]
    fn parent_swap_never_writes_or_cleans_outside_owned_root() {
        use std::os::unix::fs::symlink;
        let root = Root::new();
        let source = root.source("source", b"synthetic");
        let outside = root.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), b"keep").unwrap();
        let copies = root.copies();
        let moved = root.0.join("moved");
        let swap = copies.clone();
        let target = outside.clone();
        file_copy::test_hook(move |phase| {
            if phase == CopyPhase::BeforePublish {
                std::fs::rename(&swap, &moved).unwrap();
                symlink(&target, &swap).unwrap();
            }
            Ok(())
        });
        assert!(copy_into(&source, &copies, "swap", &AtomicBool::new(false)).is_err());
        assert!(std::fs::read(outside.join("keep")).unwrap() == b"keep");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(root.0.join("moved")).unwrap().count(), 0);
    }

    #[test]
    fn publish_refuses_existing_destination_and_keeps_foreign_bytes() {
        let root = Root::new();
        let source = root.source("source", b"selected");
        let operation = root.copies().join("conflict");
        let foreign = operation.join("note.txt");
        let destination = foreign.clone();
        file_copy::test_hook(move |phase| {
            if phase == CopyPhase::BeforePublish { std::fs::write(&destination, b"foreign").unwrap(); }
            Ok(())
        });
        assert!(copy_into(&source, &root.copies(), "conflict", &AtomicBool::new(false)).is_err());
        assert!(std::fs::read(foreign).unwrap() == b"foreign");
        assert!(!operation.join(".partial").exists());
        assert!(std::fs::read(source).unwrap() == b"selected");
    }

    #[cfg(unix)]
    #[test]
    fn substituted_operation_is_never_deleted() {
        let root = Root::new();
        let source = root.source("source", b"selected");
        let copy = copy_into(&source, &root.copies(), "owned", &AtomicBool::new(false)).unwrap();
        let moved = root.copies().join("moved");
        std::fs::rename(copy.path.parent().unwrap(), &moved).unwrap();
        let replaced = root.copies().join("owned");
        std::fs::create_dir(&replaced).unwrap();
        std::fs::write(replaced.join("note.txt"), b"foreign").unwrap();
        assert!(discard(&root.copies(), "owned").is_err());
        assert!(std::fs::read(replaced.join("note.txt")).unwrap() == b"foreign");
        // Only the copied content in the pinned (renamed) directory was removed.
        assert!(!moved.join("note.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn same_length_mutation_before_commit_is_rejected() {
        let root = Root::new();
        let source = root.source("source", b"initial");
        let modify = source.clone();
        file_copy::test_hook(move |phase| {
            if phase == CopyPhase::BeforePublish { std::fs::write(&modify, b"changed").unwrap(); }
            Ok(())
        });
        assert!(matches!(copy_into(&source, &root.copies(), "same-size", &AtomicBool::new(false)), Err(CopyError::InvalidSource)));
        assert!(!root.copies().join("same-size").exists());
    }

    #[test]
    fn worker_unwind_cleans_owned_partial() {
        let root = Root::new();
        let source = root.source("source", &vec![5; 2 * 65536]);
        file_copy::test_hook(|phase| { if phase == CopyPhase::Chunk { panic!("synthetic worker failure"); } Ok(()) });
        let result = std::panic::catch_unwind(|| copy_into(&source, &root.copies(), "unwind", &AtomicBool::new(false)));
        assert!(result.is_err());
        assert!(!root.copies().join("unwind").exists());
        assert!(std::fs::read(source).unwrap() == vec![5; 2 * 65536]);
    }

    #[cfg(windows)]
    #[test]
    fn source_with_live_writer_is_not_published() {
        let root = Root::new();
        let source = root.source("source", b"synthetic bytes");
        let writer = std::fs::File::options().write(true).open(&source).unwrap();
        assert!(copy_into(&source, &root.copies(), "writer-held", &AtomicBool::new(false)).is_err(), "a source with a live writer was published");
        assert!(!root.copies().join("writer-held").exists());
        assert!(std::fs::read(&source).unwrap() == b"synthetic bytes");
        drop(writer);
        let copy = copy_into(&source, &root.copies(), "writer-closed", &AtomicBool::new(false)).unwrap();
        assert_eq!(copy.size, 15);
        assert!(std::fs::read(&copy.path).unwrap() == b"synthetic bytes");
        assert!(std::fs::read(&source).unwrap() == b"synthetic bytes");
        discard(&root.copies(), "writer-closed").unwrap();
    }

    #[test]
    fn large_file_streams_exact_bytes_in_chunks() {
        use std::io::{Read, Write};
        let root = Root::new();
        let source = root.source("source", b"");
        let mut file = std::fs::File::options().write(true).open(&source).unwrap();
        let chunk = [11u8; 65536];
        for _ in 0..256 { file.write_all(&chunk).unwrap(); }
        file.sync_all().unwrap();
        drop(file);
        let copy = copy_into(&source, &root.copies(), "large", &AtomicBool::new(false)).unwrap();
        assert_eq!(copy.size, 16 * 1024 * 1024);
        let mut output = std::fs::File::open(&copy.path).unwrap();
        let mut read = [0u8; 65536];
        for _ in 0..256 { output.read_exact(&mut read).unwrap(); assert!(read == chunk); }
        assert_eq!(output.read(&mut read).unwrap(), 0);
        assert_eq!(std::fs::metadata(source).unwrap().len(), copy.size);
    }

    #[cfg(target_os = "linux")]
    mod restart {
        use super::*;
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant};

        fn reap(root: &std::path::Path) -> usize {
            #[cfg(reaping_baseline)]
            { let _ = root; 0 } // The previous implementation had no startup reaper.
            #[cfg(not(reaping_baseline))]
            {
                let outcome = file_copy::reap_abandoned(root).unwrap();
                assert!(outcome.supported);
                assert!(outcome.inspected <= 4096);
                assert!(!outcome.limit_reached);
                outcome.reaped
            }
        }

        struct FixtureChild(Child);
        impl Drop for FixtureChild {
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
        }
        fn child(root: &Root, mode: &str) -> FixtureChild {
            FixtureChild(Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "checks::restart::crash_fixture_child"])
                .env("COUCOU_CRASH_FIXTURE", &root.0).env("COUCOU_CRASH_MODE", mode)
                .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap())
        }
        fn crashed(root: &Root, mode: &str) {
            let status = child(root, mode).0.wait().unwrap();
            assert_eq!(status.code(), Some(91), "fixture did not take its deliberate abnormal exit");
        }

        #[test]
        fn crash_fixture_child() {
            let Some(root) = std::env::var_os("COUCOU_CRASH_FIXTURE").map(PathBuf::from) else { return; };
            let source = root.join("source/note.txt");
            let copies = root.join("copies");
            let mode = std::env::var("COUCOU_CRASH_MODE").unwrap();
            if mode == "partial" {
                file_copy::test_hook(|phase| { if phase == CopyPhase::Chunk { std::process::exit(91); } Ok(()) });
            }
            copy_into(&source, &copies, "orphan", &AtomicBool::new(false)).unwrap();
            if mode == "active" {
                std::fs::write(root.join("active-ready"), b"ready").unwrap();
                // The parent kills this disposable process after checking reaping.
                loop { std::thread::sleep(Duration::from_millis(10)); }
            }
            std::process::exit(91); // No Rust destructors: a real process-crash fixture.
        }

        #[test]
        fn restart_reaps_recognized_partial_and_ready_orphans() {
            for mode in ["partial", "ready"] {
                let root = Root::new();
                let source = root.source("source", &vec![23; 3 * 65536]);
                crashed(&root, mode);
                assert!(root.copies().join("orphan").is_dir());
                assert_eq!(reap(&root.copies()), 1, "recognized crash copy was not reaped");
                assert!(!root.copies().join("orphan").exists());
                assert!(std::fs::read(source).unwrap() == vec![23; 3 * 65536]);
                assert_eq!(reap(&root.copies()), 0);
            }
        }

        #[test]
        fn restart_preserves_unknown_foreign_and_substituted_entries() {
            use std::os::unix::fs::symlink;
            let root = Root::new();
            root.source("source", b"selected");
            crashed(&root, "ready");
            let unknown = root.copies().join("unknown");
            std::fs::create_dir(&unknown).unwrap();
            std::fs::write(unknown.join("keep"), b"foreign").unwrap();
            std::fs::write(root.copies().join(".owner-unknown"), b"invalid marker").unwrap();
            std::fs::rename(root.copies().join("orphan"), root.0.join("moved-copy")).unwrap();
            let substituted = root.copies().join("orphan");
            std::fs::create_dir(&substituted).unwrap();
            std::fs::write(substituted.join("keep"), b"replacement").unwrap();
            symlink(&unknown, root.copies().join("linked")).unwrap();
            assert_eq!(reap(&root.copies()), 0);
            assert!(std::fs::read(unknown.join("keep")).unwrap() == b"foreign");
            assert!(std::fs::read(substituted.join("keep")).unwrap() == b"replacement");
            assert!(std::fs::read(root.0.join("moved-copy/note.txt")).unwrap() == b"selected");
            assert!(std::fs::symlink_metadata(root.copies().join("linked")).unwrap().file_type().is_symlink());
        }

        #[test]
        fn restart_preserves_symlinked_operation_and_substituted_content() {
            use std::os::unix::fs::symlink;
            for linked in [true, false] {
                let root = Root::new();
                let source = root.source("source", b"selected");
                crashed(&root, "ready");
                let operation = root.copies().join("orphan");
                if linked {
                    std::fs::rename(&operation, root.0.join("moved-copy")).unwrap();
                    symlink(source.parent().unwrap(), &operation).unwrap();
                } else {
                    std::fs::rename(operation.join("note.txt"), root.0.join("moved-content")).unwrap();
                    std::fs::write(operation.join("note.txt"), b"foreign").unwrap();
                }
                assert_eq!(reap(&root.copies()), 0);
                assert!(std::fs::read(source).unwrap() == b"selected");
                if !linked { assert!(std::fs::read(operation.join("note.txt")).unwrap() == b"foreign"); }
            }
        }

        #[test]
        fn restart_never_reaps_an_active_owner() {
            let root = Root::new();
            let source = root.source("source", b"selected");
            let mut active = child(&root, "active");
            let deadline = Instant::now() + Duration::from_secs(5);
            while !root.0.join("active-ready").exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(5)); }
            assert!(root.0.join("active-ready").exists(), "active fixture did not start");
            assert_eq!(reap(&root.copies()), 0);
            assert!(std::fs::read(root.copies().join("orphan/note.txt")).unwrap() == b"selected");
            active.0.kill().unwrap();
            active.0.wait().unwrap();
            assert_eq!(reap(&root.copies()), 1, "terminated owner was not reaped on restart");
            assert!(std::fs::read(source).unwrap() == b"selected");
        }

        #[cfg(not(reaping_baseline))]
        #[test]
        fn restart_preserves_copied_marker_extra_entries_and_marker_symlinks() {
            use std::os::unix::fs::symlink;
            for mode in ["copied-marker", "extra-entry", "marker-symlink"] {
                let root = Root::new();
                root.source("source", b"selected");
                crashed(&root, "ready");
                let marker = root.copies().join(".owner-orphan");
                let saved = root.0.join("saved-marker");
                if mode != "extra-entry" {
                    std::fs::rename(&marker, &saved).unwrap();
                    if mode == "marker-symlink" { symlink(&saved, &marker).unwrap(); }
                    else { std::fs::copy(&saved, &marker).unwrap(); }
                } else { std::fs::write(root.copies().join("orphan/extra"), b"foreign").unwrap(); }
                assert_eq!(reap(&root.copies()), 0);
                assert!(marker.exists());
                assert!(std::fs::read(root.copies().join("orphan/note.txt")).unwrap() == b"selected");
            }
        }

        #[cfg(not(reaping_baseline))]
        #[test]
        fn restart_scan_is_bounded_and_root_symlink_is_rejected() {
            use std::os::unix::fs::{symlink, PermissionsExt};
            let root = Root::new();
            let copies = root.copies();
            std::fs::create_dir(&copies).unwrap();
            std::fs::set_permissions(&copies, std::fs::Permissions::from_mode(0o700)).unwrap();
            for i in 0..4097 { std::fs::create_dir(copies.join(format!("unknown-{i}"))).unwrap(); }
            let outcome = file_copy::reap_abandoned(&copies).unwrap();
            assert!(outcome.supported);
            assert_eq!(outcome.inspected, 4096);
            assert!(outcome.limit_reached);
            assert_eq!(outcome.reaped, 0);
            assert_eq!(std::fs::read_dir(&copies).unwrap().count(), 4097);
            let linked = root.0.join("linked-root");
            symlink(&copies, &linked).unwrap();
            assert!(file_copy::reap_abandoned(&linked).is_err());
        }
    }
}
