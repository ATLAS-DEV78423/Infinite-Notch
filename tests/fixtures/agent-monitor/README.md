# Agent monitor fixtures — rich contract draft

[Protocol](../../../docs/AGENT_MONITOR_PROTOCOL.md) ·
[Spec](../../../docs/superpowers/specs/2026-10-03-agent-session-inspector-design.md) ·
[Plan](../../../docs/superpowers/plans/2026-10-03-agent-session-inspector.md)

All IDs, paths, commands, counts and forbidden-content markers here are invented.
Negative privacy cases are hostile parser inputs, **not permitted producer output**.
No session capture, real prompt, response, secret or user configuration was used.
Wire/replay files specify synthetic checks; the verification receipt distinguishes
baseline host evidence from still-missing rich/native acceptance.

## Qualification receipt (updated 2026-10-04)

- **OpenCode V2: baseline-only.** Installed `1.18.32` remains unchanged. The
  controller ran disposable public `2.0.6` with @opencode/plugin `2.0.6`, a
  scripted loopback-only model, two isolated locations and the actual Coucou
  baseline plugin/rebuilt Rust relay. Twelve exact canonical packets passed,
  including tool success/failure and deletion, without cross-location duplicates
  or permission packets. Native events use `data`, not legacy `properties`.
  Accounting/current-context, retry, compaction, move/reset and rich monitoring
  remain unqualified. See the [current receipt](../../../docs/research/agent-inspector-verification.md).
- **Hermes: registration/dispatch-only; rich monitoring BLOCKED.** Observed
  version is `v0.21.5+5360.g44a1ce9 (2026.9.24)`, Python 3.14.7. Direct isolated
  doctor now passes 7-hook registration; five real-host dispatch paths with
  invented kwargs pass exact minimized native relay delivery and unload. Those
  kwargs were not produced by a real model turn. Earlier CLI doctor timed out;
  CLI boot, full turns and expanded hooks remain unqualified. OpenAI SDK is absent.
- Task 1 used `webfetch` to read the official [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins)
  and [Hermes observer contract](https://hermes-agent.nousresearch.com/docs/developer-guide/observer-hooks).
  They support the lifecycle/identity facts in [upstream.json](upstream.json),
  not an inferred native event envelope. Main also confirms reading these two
  sources. The controller also read V2 client/API/provider documentation and
  inspected public OpenAPI structure. No legacy events are substituted.
- `version` is the controller-observed probe version, **not a rich support claim**.
  `qualification.qualified_runtime_version: null` means full rich monitoring is
  unqualified. `docs_derived` is documentation evidence; `qualification`
  distinguishes controller observations,
  and `cases: []` means **zero curated rich-mapper input cases**, not an absence
  of baseline host checks. Baseline native regressions use invented values in
  `tests/opencode-privacy.test.mjs`; synthetic wire cases are not native inputs.
- Remaining gates: rich accounting/context/lifecycle and expanded Hermes fields,
  native ingress lifetime and composed platform acceptance. User credentials,
  real sessions/history and global configuration were not accessed or changed.

## Exact fixture shapes

`wire.json` is an array of exactly `{name, packet, valid}`. Names are unique.
`valid` says whether the monitor/control is structurally usable **after** the
protocol's allowlist and optional-group omissions. It does not mean every raw
input field may be sent by a producer. Unsupported required fields yield false;
invalid optional usage/tool groups can yield true with that group omitted.
Stateful ordering/capacity is tested in replay, not this boolean.

`upstream.json` has exactly `opencode` and `hermes`. Each has `version` (observed
probe version string or null), `source_urls` (first-party documents actually
read with `webfetch`), `qualification`,
`docs_derived` (facts sourced from those URLs), and `cases`. Future qualified cases
must be `{name, input, expected}` with invented values matching an actually
observed structure, a qualified version, and explicit evidence provenance.
Do not fill empty cases merely to make an adapter test green.

`replay.json` is an array of exactly `{name, events, expected}`:

- Each event is exactly `{at_ms, packet}`; monotonic non-negative integer local
  milliseconds, stable file order for equal timestamps. Fresh empty store for
  every case. Ordinary `packet` objects are literal wire envelopes, no macros.
- `expected` is exactly `{results, checkpoints}`. `results` has one exact string
  per event: the apply disposition, or the fixture-operation result below.
- Each checkpoint is `{after, checks}` with a zero-based event index. Each check
  is either `{path, equals}` or `{path, absent: true}`. `path` is an RFC 6901 JSON
  Pointer into the state projection below; object/array equality is deep equality,
  never a substring, wildcard or partial-object match. Null is distinct from
  absence. No tolerance is required for the binary-exact fractions in this file.
- Observe checkpoints immediately after their event. Run `prune` only at null
  events here; do not introduce implicit time ticks or sleeps.

### Test-only operations (never sent over IPC)

The fixture driver models the app ingress generation and dispatches real store
methods. These controls are reserved to this fixture file, not a new product API:

| `packet` | Exact operation / result |
| --- | --- |
| `null` | `prune(at_ms)`; result `pruned`, including when nothing expires. |
| `{"$fixture":"select","agent":…, "key":[…]}` | Select that existing session; `selected`. |
| `{"$fixture":"clear"}` | Increment generation, clear store and queued UI/ingress work; `cleared`. Does not change pause flag. |
| `{"$fixture":"pause"}` | Increment generation, set paused, clear all monitor state/queued work; `paused`. |
| `{"$fixture":"resume"}` | Increment generation, clear, set unpaused; `resumed`. No restored content. |
| `{"$fixture":"deliver","generation":N,"packet":{…}}` | Invoke a captured ingress callback; ignore if paused or N differs from current generation, otherwise apply its wire packet. |
| `{"$fixture":"finish","key":[…],"turn_id":…}` | Fire the old finish-animation callback. If session is gone or its turn differs, return `animation_ignored` and change nothing. No session content may be removed by an old animation. |

Initial generation is 0, paused is false. Ordinary wire packets use the current
generation; packets while paused yield `ignored`. Cleanup controls pass `at_ms`
to the actual store. The `deliver` fixture models a locally tagged callback.
The user-approved replay amendment also permits up to 64 temporary opaque keys
and deadlines per agent for 30000 ms, never retained content/history. Native
delivery and post-expiry safety need separate evidence. The finish fixture
checks an old integration callback, not a store expiry.

**Unresolved acceptance gate:** existing fire-and-forget sockets do not establish
per-emitter FIFO processing across connections. Tasks 2–7 must delay an already
sent content packet until after teardown/roster processing, and separately until
after pause/clear/resume, then verify no cleared details reappear. The ordered
replays and local callback generations alone do not pass those tests. Tauri's
synthetic checks reject known/explicitly retired identities within the approved
window, including a late heartbeat in `quiet-connected-tool-versus-emitter-loss`.
They do not prove native delay bounds, arbitrary post-expiry protection or
previously unseen ingress without control knowledge. No new reverse transport
or unlimited replay guarantee is implied.

### State projection for checkpoints

Project the actual tested store, never fixture-provided fake parser results:

```text
{
  sessions: [{key, cwd?, monitor, received_at_ms, context_fraction, content_stale}],
  observations: [{agent, emitter_id, approval, received_at_ms}],
  counts: {opencode: integer, hermes: integer},
  selected: {opencode: key|null, hermes: key|null},
  badges: {opencode: "approval"|"error"|"finished"|null, hermes: same},
  overflow: {opencode: integer, hermes: integer},
  canonical: [canonical_event_name, ...],
  last_result: apply_result|null,
  generation: integer,
  paused: boolean
}
```

`key` is `[agent, emitter_id, "session", session_id]`. Sort session projection
rows lexicographically by this tuple's Unicode scalar values; this is test
ordering, not UI ordering. `monitor` is the complete sanitized current snapshot,
including required fields and sticky terminal status/outcome; omitted optional
fields remain absent (the UI can render absent arrays as empty). No raw envelope
is retained. `context_fraction` is the protocol gauge or null; `content_stale`
is `at_ms - received_at_ms >= 30000`, independent of heartbeat freshness.

Project observations by `[agent, emitter_id, approval.id]` in Unicode scalar order
after the protocol's eight-row cap. Counts/badges/selections are actual store
values. Overflow is the protocol's reported/local lower bound. `canonical` is
test-driver-only dispatch evidence: append canonical names on `accepted` or
`legacy`, never on `stale`/`ignored`, and never for either `AgentDisplay*` event.
It is not product history or logging. `last_result` is the actual most recent
`apply` result (null before any apply); fixture controls leave it unchanged.
The driver discards its entire synthetic projection after each case.

## Bounds and additional deterministic checks

The compact JSON contains a 272-byte rejected identity, Unicode/path spaces,
literal markup/metacharacters, duplicate IDs and nine-tool overflow. Avoid a
65-KiB literal fixture: Task 7's parser/transport driver must derive these exact
cases from a deep copy of `wire.json`'s `healthy-session.packet`:

| Mutation | Expected |
| --- | --- |
| `session_id = "é" * 128`, then `"é" * 129` | First identity valid (256 bytes), second rejects (258); never truncate IDs. |
| `files[0].path = "界" * 341 + "a"` | Exactly 1024 bytes, keep entire path. |
| `files[0].path = "界" * 342` | 1026 bytes; receiver omits `files` group. Producer trims to 341 characters and marks `files[0].path`. |
| `tools[0].command = "é" * 500`, then `"é" * 501` | Keep 1000 bytes; receiver omits 1002-byte optional command. Producer trims to 500 characters and marks truncation. |
| Add top-level `padding = "x" * 65536` | Whole envelope exceeds 64 KiB: reject before optional-field stripping. |
| Set context tokens to null, false, -1, 1.5 or string `"Infinity"` | Omit `usage.context`; preserve valid totals. |
| Pass JS NaN/Infinity directly to parser; use JSON number `1e999` for byte-oriented decoder | Never admit a non-finite counter. A decoder rejecting the whole raw JSON is also safe; it must not dispatch canonical side effects from malformed JSON. |
| Feed raw bytes `{`, invalid UTF-8, or a JSON string with an unpaired surrogate | Drop packet; no state mutation or logging. |

JSON cannot represent NaN/Infinity literals. The committed JSON stays portable;
these generated invalid-input checks belong in the real platform suites.

## Acceptance coverage (spec items 1–11)

| Item | Fixture / remaining concrete check |
| --- | --- |
| 1. Real compatibility | `upstream.json` records baseline-only V2 and registration/dispatch-only Hermes evidence; zero curated rich cases. Full agent/runtime acceptance remains open. |
| 2. Visible flow | `healthy-session`; Task 7 performs the full synthetic turn/read/tool/two-approval/resolution/outcome flow on both UIs and agents. |
| 3. Identity | `agent-emitter-session-and-parent-isolation`; Tasks 5–7 verify selection/focus and concurrent existing Claude approval ownership. |
| 4. Lifecycle/deduplication | `stale-stop-and-duplicate-do-not-run-canonical-effects`, `retry-failure-idle-new-turn-and-old-finish-timer`; Tasks 3–4 assert duplicate completed API request IDs do not accumulate usage. |
| 5. Usage | `context-compaction-model-switch-and-unknown-counters`, healthy 32000/128000 = 25% versus 96000 cumulative, numeric wire cases and generated non-finite checks above; Tasks 3–4 test the 256-ID dedupe ceiling. |
| 6. Passive safety | `hermes-uncorrelated-approval-stays-agent-level`, parallel requests in `healthy-session`; Tasks 3–4 assert no reply calls, hook returns None, inputs unchanged. |
| 7. Transport/bounds | Wire bounds/Unicode cases, `seventeenth-session-never-evicts-or-merges`, stale replay and mutations above. Tasks 2–4/7 use fake relay executables for ENOENT/EPIPE/stall, <=1 child, <=17 content keys, <=2000 ms relay deadline and stdin-only commands. Cross-connection FIFO/control-barrier behavior remains unresolved and needs the delayed-delivery test above. |
| 8. Privacy/cleanup | `prohibited-content-and-unsafe-command-never-enter-state`, `clear-pause-resume-discards-old-generation` (locally tagged callback only), `roster-reset-and-emitter-clear-isolation`, both liveness replays. Task 7 must verify no logs/stores/network/export, no retained UI text and no resurrection from already-sent packets first arriving after resume. That last race is unresolved. |
| 9. UI polish | Tasks 5–7 render Unicode/long commands, 20 files/16 sessions/overflow, pending and unknown approvals, missing cwd/context, error and cleared Details; inspect 640×280 geometry, motion, scroll/focus stability and one Mochi. |
| 10. Accessibility | Tasks 5–7 exercise keyboard selector/Back/Escape, visible focus, screen-reader labels, reduced motion and text-only status. |
| 11. Regression | Task 7 runs actual adapter/reducer/relay checks, Swift focused scripts, TypeScript build, Rust tests and platform runs; missing runners remain unverified. |

## Runnable document check

From repository root (standard library only; no agents or relay):

```sh
python3 - <<'PY'
import json, pathlib, re
p = pathlib.Path('tests/fixtures/agent-monitor')
def bad_constant(value):
    raise ValueError(value)
w, r, u = [json.loads((p/n).read_text(), parse_constant=bad_constant)
           for n in ('wire.json', 'replay.json', 'upstream.json')]
for cases in (w, r):
    assert len({c['name'] for c in cases}) == len(cases)
for c in w:
    assert set(c) == {'name', 'packet', 'valid'}
    assert isinstance(c['packet'], dict) and type(c['valid']) is bool
for c in r:
    assert set(c) == {'name', 'events', 'expected'}
    assert set(c['expected']) == {'results', 'checkpoints'}
    assert len(c['events']) == len(c['expected']['results'])
    assert set(c['expected']['results']) <= {'accepted', 'stale', 'legacy',
        'ignored', 'pruned', 'selected', 'cleared', 'paused', 'resumed', 'animation_ignored'}
    times = [e['at_ms'] for e in c['events']]
    assert times == sorted(times) and all(type(t) is int and t >= 0 for t in times)
    for e in c['events']:
        assert set(e) == {'at_ms', 'packet'}
        assert e['packet'] is None or isinstance(e['packet'], dict)
        packet = e['packet']
        if isinstance(packet, dict) and '$fixture' in packet:
            fields = {'select': {'agent', 'key'}, 'deliver': {'generation', 'packet'},
                'finish': {'key', 'turn_id'}, 'clear': set(), 'pause': set(), 'resume': set()}
            assert set(packet) == {'$fixture'} | fields[packet['$fixture']]
    for cp in c['expected']['checkpoints']:
        assert set(cp) == {'after', 'checks'} and 0 <= cp['after'] < len(times)
        for check in cp['checks']:
            assert set(check) in ({'path', 'equals'}, {'path', 'absent'})
            assert check['path'].startswith('/')
            assert 'absent' not in check or check['absent'] is True
assert set(u) == {'opencode', 'hermes'}
for host in u.values():
    assert host['qualification']['qualified_runtime_version'] is None
    assert host['cases'] == []
    assert host['qualification']['status'] in ('baseline-only', 'registration-dispatch-only')
    assert host['source_urls'] and host['docs_derived']
healthy = next(c['packet'] for c in w if c['name'] == 'healthy-session')
usage = healthy['coucou_monitor']['usage']
assert usage['context']['tokens'] / usage['context']['limit'] == .25
assert usage['totals']['input'] == 96000
oversize = next(c for c in w if c['name'] == 'oversized-identity-272-bytes')
assert len(oversize['packet']['session_id'].encode()) == 272
docs = [p/'README.md', pathlib.Path('docs/AGENT_MONITOR_PROTOCOL.md'),
        pathlib.Path('docs/superpowers/specs/2026-10-03-agent-session-inspector-design.md'),
        pathlib.Path('docs/superpowers/plans/2026-10-03-agent-session-inspector.md')]
links = 0
for doc in docs:
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', doc.read_text()):
        if '://' not in target and not target.startswith('#'):
            assert (doc.parent / target.split('#')[0]).exists(), (doc, target)
            links += 1
print(f'fixtures parse; shapes OK: {len(w)} wire, {len(r)} replay, 0 curated rich upstream cases; {links} local links OK')
PY
```

This checks document integrity, not production parser/reducer behavior or runtime
compatibility. See the task report for actual checks run and remaining blockers.
