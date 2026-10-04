# Agent inspector — implementation and verification receipt

Updated 2026-10-04. **Phase 1 is incomplete; this is not release qualification.**

## Implemented locally

- Minimal baseline producers omit prompts/responses, file bodies/diffs, raw
  arguments/results/errors and guessed directories before relay delivery.
- Source callbacks are passive and silent; one instance-owned relay child,
  bounded 17-packet pending queue, 2-second deadline and unload cleanup.
- Both Python relays and native receiver routes suppress private event logging
  and environment enrichment, filter fields and cap private envelopes at 64 KiB.
- Tauri snapshot validation, session isolation, unknown usage/directory handling,
  passive approval observations and the 640 × 280 two-card inspector are implemented.
  Keyed controls retain focus/scroll; Back/Escape and reduced-motion behavior have
  synthetic browser checks. The current adapters do not emit rich snapshots yet.
- Display content clears synchronously on end/pause/clear/expiry, including hidden
  view text and task copies. With the user's explicit approval, up to 64 opaque
  replay keys per agent remain for 30 seconds solely to reject delayed updates.
  They contain deadlines, not commands/paths/usage/history. Pressure fails closed.

No feature analytics, activity persistence, raw-content collection, uploads,
new runtime dependencies or global account/configuration changes were added.
This is a scoped implementation statement, not an audit of other app features.

## Reproducible checks

Run from the repository root:

```sh
bash scripts/test-agent-monitor.sh
bash scripts/test-agent-monitor.sh --require-platform-checks
```

Default runs the real Node/Python adapter, relay and reducer suites and available
TypeScript/Vite/Rust/Swift checks. Strict mode must remain nonzero while runtime
or platform acceptance is pending. Fixture parsing is not runtime compatibility.

| Check | Current evidence |
| --- | --- |
| Source/bounded sender Node checks | Qualified V2 repair: 25 pass; obsolete legacy-envelope tests replaced, not retained as V2 evidence |
| Shared Tauri wire/replay + replay protection | Final controller combined run: 58 pass; shared expectations reconciled |
| Python producer/sender/relay checks | Tool-label repair: 10 + 7 + 66 = 83 pass |
| Actual extracted Python relay variants | 66 behavioral checks pass on Linux synthetic sockets, not macOS sandbox proof |
| Browser DOM | Fix-wave receipt: 73 normal / 74 reduced-motion checks; main independently observed final synthetic results in built-in browser |
| TypeScript / Vite web build | Final controller installed-tool checks pass (37 modules); this is a web build, not the Cargo/native build |
| Linux Rust | Prepared workspace initially passed 23 tests. After repair, separate app `--lib` / relay targets pass 17 + 10 = 27; full archive rebuild hit temporary disk quota |
| OpenCode V2 baseline | Public 2.0.6 binary and @opencode/plugin 2.0.6: actual plugin + rebuilt release relay delivers 12 exact canonical packets for two synthetic locations; strict plugin typecheck passes |
| Hermes registration/dispatch | Real host discovery registers 7 hooks/0 tools; five supplied synthetic hook paths reach the actual native relay unchanged/minimized with no policy returns; unload checked |
| Final combined script / strict mode | Default exit 0; strict exit 1 for pending acceptance; unknown flag exit 2 |
| Independent review | Four Important findings fixed and re-reviewed as ADDRESSED; no new Critical/Important fix-diff findings |

Earlier main verification: `bash scripts/test-agent-monitor.sh`,
`bash scripts/test-agent-monitor.sh --require-platform-checks`, `git diff --check`
and the fixture README integrity command: **78 Node + 73 Python = 151 tests**
before the qualification repairs. The earlier review fixed detached ticker-content retention, attached credential flags,
failed-turn recovery and dirty-frame overview throttling. This does not qualify
the full rich-agent/native flow. Changes are uncommitted; prior work is preserved.

Qualification additionally found and repaired two real blockers: the baseline
mapper used legacy `properties`/message-part events instead of V2's native `data`
events, and private relays/receivers stripped safe canonical tool labels. The
mapper now filters actual location scope and bounds ownership/deduplication;
only the three canonical tool events may retain grammar-valid 256-byte labels.
Content bodies, permission decisions and display-control labels remain excluded.

Only invented test IDs, paths, commands and usage values are used. There were no
real user app/session captures, user credential reads or outgoing feature-data exports.

Latest controller checks after both qualification repairs: **193 tests (83 Node,
83 Python, 27 Rust)**, all passing in their named runners. TypeScript,
Vite, strict plugin typecheck, fixture integrity and whitespace checks pass.
Strict acceptance still exits 1. Actual baseline host probes above pass; neither
the full post-repair archive build nor rich/native release acceptance is claimed.

## Qualification gaps

1. **OpenCode V2:** installed CLI `1.18.32` is unchanged. A disposable public
   `2.0.6` binary runs and its authenticated standalone API responds. Native
   baseline events and the actual plugin/relay flow now pass using two disposable
   sessions and a scripted loopback-only model, including tool success/failure,
   generic completion and deletion. Permission asked/replied, model limits and
   numeric usage structures were observed separately. Accounting/current-context,
   retry, compaction, move/reset and rich normalization remain unqualified.
2. **Hermes:** isolated version probe returned
   `v0.21.5+5360.g44a1ce9 (2026.9.24)`, Python 3.14.7, OpenAI SDK not installed.
   The isolated CLI doctor timed out after 45 seconds. A later direct isolated
   `doctor_plugin` check passes registration after installing required packages
   only in a disposable venv, with network/provider-setup subprocesses blocked.
   Five real-host hook-dispatch paths now also pass through the rebuilt relay;
   their kwargs are test-supplied, not generated by a real model turn. Expanded
   hooks, CLI boot and real turns remain unqualified; OpenAI SDK is still absent.
3. **Native:** a disposable Rust toolchain now compiles the Linux workspace and
   separate Rust app/relay targets now pass 27 tests with task-local library and
   resource overrides. The full archive rebuild failed on temporary disk quota;
   no full post-repair workspace build pass is claimed. Swift and Xcode remain
   unavailable; the SwiftUI inspector lane is not implemented. No
   Linux Tauri/Windows/macOS app, App Store sandbox, screen-reader or native
   animation/approval regression run is claimed.
4. **Replay/privacy lifetime:** synthetic tests reject known/explicitly retired
   identities within the approved window. Actual socket/pipe ordering, arbitrary
   post-expiry delays, first unseen identity without control knowledge and restart
   after volatile protection disappears remain unqualified. Do not promise that
   the temporary marker window proves unlimited stale-packet rejection.
5. **Rich sources:** full upstream file/usage/permission normalization, scoped
   snapshot coalescing/control barriers and live liveness production are pending.
   Baseline FIFO overload may drop a newest lifecycle event; it is not a complete
   session-finalization guarantee.

Next: finish rich runtime qualification, resolve native ingress lifetime bounds,
then implement the rich source and SwiftUI lanes and run real composed acceptance.

### Disposable qualification lane

All setup is under `/tmp/opencode/coucou-qualification-wzd3y1yh`; installed agents,
global configuration and accounts are unchanged. Public V2/plugin version: 2.0.6;
strict typecheck: task-local @types/node 26.6.4. Rust 1.99.0 and Arch
gtk-layer-shell 0.10.1 are also task-local. Test-generated service auth and
synthetic databases use disposable child directories, removed on cleanup;
no user credentials or real sessions are accessed.

Controller probes (temporary scripts, not deployment installers):

```sh
python3 -B /tmp/opencode/coucou-qualification-wzd3y1yh/probe-opencode.py
python3 -B /tmp/opencode/coucou-qualification-wzd3y1yh/probe-hermes.py
```

The first loads actual staged Coucou source and verifies exact per-session
delivery, no cross-location duplication and no approval packets. The second
uses real Hermes discovery/dispatch/unload with invented kwargs and checks exact
minimized native delivery. Neither runs the Coucou UI or proves rich snapshot
privacy/lifetime. Only schema summaries and enum/count assertions are retained,
never prompt/response/path/ID payload captures.

## Synthetic preview

Current development URL: http://127.0.0.1:5176/tests/agent-session-ui.html

Use the fixture's Approvals / paths, Burst, Clear, Overview and Details controls.
The automated checks and preview use production web code with invented packets;
they do not connect to user sessions or verify native animation quality.

References: [protocol](../AGENT_MONITOR_PROTOCOL.md),
[spec](../superpowers/specs/2026-10-03-agent-session-inspector-design.md),
[plan](../superpowers/plans/2026-10-03-agent-session-inspector.md),
[synthetic fixtures](../../tests/fixtures/agent-monitor/README.md).
