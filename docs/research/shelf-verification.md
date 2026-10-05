# Temporary shelf verification receipt

2026-10-05. [Approved shelf plan](../superpowers/plans/2026-10-05-temporary-shelf.md),
first slice S1a: regular-file native asset/lease lifetime. Not a completed shelf.

## Starting point and tests-first checkpoint

Planning source `04f8534f99ed3dc3ea40c1310155ff020cf5c11f` is independently
remote-verified. Native Mac/Windows/Linux baseline passes at `76b4ee2` are recorded
in [native qualification](native-qualification.md). User approved the remaining
feature, shelf and capability plans, including the proposed admission bounds.

Two disjoint implementers added real native read-consumer tests against current
copy/cancel owners. Production behavior is unchanged. The current owners have no
registered shelf lease API; the tests intentionally expose pathname loss during
disposal while a read consumer remains open. They check actual copied and original
bytes using synthetic explicitly owned fixtures, not mocked lease behavior.

| Target | Added executable test | Initial evidence |
| --- | --- | --- |
| Mac | `future_lease_lifetime_remove_keeps_open_consumer_path` (23rd preparation case) | Hosted behavioral RED pending; local `swiftc` unavailable |
| Windows/Linux | `files::tests::cancel_preserves_ready_path_until_native_reader_closes` | Hosted behavioral RED pending; local Cargo/Rust unavailable |

Expected RED is a real pathname-survival assertion after successful native copy,
consumer open/read and unchanged-original assertions. Compiler errors, fixture
failure, a skipped case or missing local tool are not behavioral RED. Ordinary
source checkpoints may intentionally carry these failing native tests while the
observed RED→GREEN cycle is performed; this is not a release or passing milestone.

Controller preflight: 109 Node TS/MJS tests, foundation 26 portable cases and
TS/Vite checks, and 66 Python relay tests passed before product changes. No local
Swift/Rust execution is claimed. No compiler/global account/runtime setup changed.

## Next required evidence

Observe actual hosted RED before native asset/lease implementation. Then test real
registered acquire/remove/release lifetimes, unknown/duplicate/cross-asset IDs,
cancel/remove races, shutdown waiting, namespace substitution and bounded assets/
leases, followed by existing native full builds at the new source revision.

Folders, crash reaping, shelf UI, received references, LocalSend, real Finder/
Explorer/share/Mail consumer lifetimes, sandbox/accessibility/performance and
installer/signing/rights gates remain pending. An open read handle proves only
this native storage regression, not a qualified OS export/attachment consumer.
