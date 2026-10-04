# Agent monitor protocol — Phase 1, version 1

Draft rich wire contract, 2026-10-03, pending full runtime qualification. Consumers: the existing same-device Coucou
relay, OpenCode/Hermes adapters, and Swift/Tauri stores. This is passive local
display, not an approval API. Disposable OpenCode `2.0.6` baseline plugin/relay
checks pass; Hermes registration/dispatch passes with supplied synthetic kwargs.
The rich source/platform/lifetime gates remain open. See
[`tests/fixtures/agent-monitor/README.md`](../tests/fixtures/agent-monitor/README.md).

## Privacy and minimization (normative)

Only the live cards' agent label, opaque correlation IDs, status, explicitly
reported directory, safe path/command/approval previews, reported counters and
header model/provider labels enter the snapshot. No file bodies/diffs,
prompts/responses/transcripts/reasoning, credentials, environment/terminal metadata,
arbitrary tool output, network metadata, unrelated app state, broad inventories,
analytics or activity collection. Do not enrich from transcripts, directory
scans, process cwd, application inventories or remote agent endpoints.

The latest minimization amendment overrides earlier response-preview requirements.
There are **no** `title`, `final_summary`, subagent `summary`/`goal`/`role`, raw
`error`, activity `text`, or free-text approval-reason fields. Never copy, infer,
summarize or retain assistant responses, prompts, child goals or results. Render
fixed generic wording from the enums below; a short exact session ID identifies
the session. Even an upstream field described as sanitized is not permission to
forward its body. The entire adapter envelope, including canonical-hook fields,
uses this allowlist; canonical events carry no prompt, response or tool body.

`activity` is merely the current live card's bounded status rows, replaced with
the next snapshot and cleared at a new turn/end. It is not a collected history.
No feature data, even IDs/event names/redacted payloads/counters, goes to logs,
debug output, files, preferences, databases, clipboard, crash attachments,
exports, analytics or off-device transport. Never store the received raw packet.
Producer workers own only detached, already-sanitized snapshots.

User-approved replay protection (2026-10-04) is the sole cleanup exception:
temporary opaque identity keys and retirement deadlines may remain in memory to
reject late updates. They contain no commands, paths, request previews, usage,
sequence history or prior snapshots. Maximum 64 markers per agent, expiring
30000 ms after cleanup; stale arrivals cannot renew them. Reserve cleanup slots
for admitted identities. When no protection slot remains, refuse admission or
use a bounded per-agent fail-closed deadline, not eviction of protected keys.

## Envelope and identity

Send one UTF-8 JSON object followed by LF through the existing same-user IPC:

```json
{
  "hook_event_name": "AgentDisplayUpdate",
  "coucou_agent": "opencode",
  "session_id": "fixture-session-a",
  "cwd": "/fixture/alpha",
  "coucou_monitor": {
    "version": 1,
    "emitter_id": "fixture-emitter-a",
    "sequence": 1,
    "scope": "session",
    "status": "thinking",
    "directory_known": true
  }
}
```

- `coucou_agent`: exactly `opencode` or `hermes`.
- `hook_event_name`: `AgentDisplayUpdate`, or a canonical lifecycle/animation
  event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`,
  `SubagentStart`, `SubagentStop`). Never `PermissionRequest` for observations.
- `version`: integer `1`; `emitter_id`: nonempty opaque plugin-instance ID.
- `sequence`: integer 1..9007199254740991, increasing per scoped identity.
- `scope`: `session` requires nonempty exact top-level `session_id`; `agent`
  forbids `session_id` and is only for unattributed approvals/emitter cleanup.
- `directory_known`: boolean. True requires a nonempty explicit top-level
  `cwd`; false permits only absent/empty cwd. Never substitute process cwd.
- `status`: `idle | thinking | working | awaiting_approval | retrying |
  ratelimited | compacting | finished | failed | interrupted | ended | unknown`.
- Optional `turn_id`, `parent_session_id`, `model`, `provider` are
  strings. Opaque IDs preserve exact bytes: no case folding, normalization,
  parsing compound IDs, trimming or truncation. Restart/reenable uses a new
  emitter ID and clears old-generation callbacks.

Session keys are the tuple `[agent, emitter_id, "session", session_id]`, not
delimiter concatenation. Agent observations use `[agent, emitter_id, "agent",
null]`. Identical session IDs in other agents/emitters remain independent.
Top-level `request_id`, prompt/message bodies and raw `tool_input` are not part
of producer monitor envelopes. Relay CLI arguments never contain previews.

Canonical `PreToolUse`, `PostToolUse` and `PostToolUseFailure` may additionally
carry a `tool_name`: nonempty, at most 256 UTF-8 bytes, Unicode letters/numbers
or `_.:-` only. Other events (including display controls) omit this top-level
label. It is safe name metadata, never a tool argument/command or approval ID.

Optional `capabilities` is a map whose only keys are `files`, `context`,
`approvals`, `subagents`, `compaction`, with `reported | unavailable` values.
Absent means unknown; availability requires a qualified public upstream source.

## Full replacement snapshot

All optional groups below live inside `coucou_monitor`. An accepted newer
snapshot replaces, never merges, previous details: omitted arrays become empty;
omitted scalars/counters become unknown. Arrays preserve the producer's stable
row order; the UI may prioritize pending rows using their IDs. IDs are unique within each
array. `?` means optional; all other row fields are required.

| Group | Row shape | Maximum |
| --- | --- | --- |
| `files` | `{id, tool_call_id?, path, action, state, cwd?}` | 20 |
| `tools` | `{id, name, state, command?, target?, cwd?, duration_ms?}` | 8 |
| `approvals` | `{id, request_id?, tool_call_id?, state, command?, target?, reason?, cwd?}` | 8 |
| `subagents` | `{id, session_id?, state, duration_ms?}` | 8 |
| `activity` | `{id, kind, attempt?}` | 20 |

Enums:

- File `action`: `read | write | edit | reference`; `state`:
  `pending | running | completed | failed`.
- Tool `state`: `pending | running | completed | failed | blocked | cancelled`.
- Approval `state`: `pending | approved | denied | cancelled | unknown`.
- Subagent `state`: `running | finished | failed | interrupted | unknown`.
- Approval `reason`: `permission_required | policy | unknown`; optional, never
  upstream description text. UI wording: `Approval required`, `Agent policy`,
  `Reason unavailable`, respectively.
- Activity `kind`: `retry | rate_limit | compaction | error | session_reset`.
  UI wording: `Retrying`, `Rate limited`, `Compacting context`, `Operation failed`,
  `Session reset`, respectively. `attempt` is an optional positive safe integer.

`id` is the producer's stable row/observation identity; `tool_call_id`,
`request_id` and nested `session_id` are exact upstream identities when exposed.
The enclosing session is a subagent row's parent. Intent to delegate does not
prove a child started. `duration_ms` is finite and non-negative, only if reported.

Recognized file-tool inputs or explicit references supply paths. A requested
read/edit/write is pending/running, not confirmed; success requires its exact
tool outcome. Never infer paths from arbitrary shell commands. Row `cwd` is an
explicit tool directory, not a replacement session directory. Relative paths
remain relative if session cwd is unknown. Paths are display text only.

Approval `id` is always a producer-local observation ID, not a fabricated
upstream request ID. Only explicit unambiguous identity resolves an observation.
Unrelated tool completion, selection or matching command text cannot resolve it.
Unattributable Hermes `session_key` stays producer-local, never becomes
`session_id`. Use agent scope, `directory_known: false`, and at most 8 approvals;
other content groups and session labels are absent. Age never implies denial.
Timeout/ambiguous reply becomes `unknown` unless upstream confirms cancellation.
No observation enters `pendingApproval` or an approval reply/policy API.

`outcome?`: `completed | failed | interrupted | incomplete`, rendered only as
`Turn completed`, `Turn failed`, `Turn interrupted`, `Turn incomplete`,
respectively. It is valid only for status `finished` (completed), `failed`
(failed/incomplete), or `interrupted` (interrupted). An inconsistent optional
outcome is omitted. A new turn clears prior outcome and activity rows.

## Usage

```text
usage?: {
  context?: {tokens?, limit?, quality: reported|estimated,
             accounting: includes_cache|excludes_cache|unknown},
  totals?: {scope: session|observed, partial?: boolean,
            input?, output?, reasoning?, cache_read?, cache_write?, cost_usd?,
             accounting: includes_cache|excludes_cache|unknown}
}
```

Counts are finite non-negative safe integers (booleans/strings are not numbers);
cost/duration are finite non-negative numbers, at most the safe-integer maximum.
Unknown is absent, never zero. `context.tokens` is the latest whole-input
context, never cumulative input. Only compatible numerator/limit and known
accounting permit a gauge; `accounting: unknown`, missing fields or limit 0
produce no gauge. Estimated input is labeled `~`/`Estimated`. Over-limit fills
clamp to 1, but text preserves the actual count. A reported zero count is valid.
In `healthy-session`, 32000 / 128000 = 0.25; cumulative input 96000 is separate.

Context accounting labels the upstream cache convention; adapters must convert
to a compatible whole-input count using qualified semantics, not guessed sums.
Session totals come from authoritative counters or unique completed request IDs.
Never add progress/retry duplicates or overlapping input/cache/reasoning buckets.
`scope: observed` means `Since monitoring started`; `partial: true` flags gaps.
Bound deduplication to 256 IDs per session. Once dedupe IDs must be evicted, stop
derived accumulation and mark partial until authoritative totals restore it.
`accounting` labels the reported cache convention; no arbitrary metadata label.
Cost is reported only, never a guessed price calculation. Compaction may reduce
context while totals rise. On model switch omit the old limit until refreshed.

## Bounds, scrubbing and validation

| Data | Limit |
| --- | --- |
| IDs, names, header labels | 256 UTF-8 bytes |
| cwd, file path, target | 1024 UTF-8 bytes |
| command | 1000 UTF-8 bytes |
| Complete compact serialized wire object, excluding LF | 65536 UTF-8 bytes |
| Live sessions per agent in producer and receiver | 16 |
| Uncorrelated observations per agent across emitters | 8 |

`overflow?` has non-negative safe-integer `files`, `tools`, `approvals`,
`subagents`, `activity`, `sessions`, `observations` counts. It reports current
omissions, not cumulative statistics; omit zero entries. It is not authority to
accept over-cap arrays. Producers retain existing live sessions at capacity and
report excess count instead of mixing identities. Receivers reject admission of
a seventeenth session without evicting a selected or pending session; signal
capacity to the UI. The receiver's local overflow is a lower bound of 1, not an
ever-increasing counter of rejected identities; repeat rejections remain 1.
Clear that local flag when a slot is freed. Display the maximum of this flag
and current producers' `overflow.sessions` counts. Release slots on cleanup.

`truncated_fields?`: at most 64 strings, each at most 256 UTF-8 bytes. Paths are
relative to the monitor (`tools[0].command`, `files[0].path`) except top-level
`cwd`. Only allowlisted field paths are allowed. Trim complete Unicode scalar
boundaries, never broken UTF-8/JSON. UI says `Truncated`. Redact before trimming.
Opaque IDs are never shortened: an oversized allowlisted identity rejects the monitor.
Producers trim safe previews/drop complete optional rows to meet total size,
preserving identity/status/approvals before optional rows. If still too large,
drop the packet. Receivers do not repair over-size envelopes.

Build allowlisted values without copying raw host objects. Remove sensitive
key/value material, password/token/key flags, assignment-form secrets,
Authorization/Cookie headers, URL userinfo/query/fragment, and nested arbitrary
objects. Commands may embed secrets without a sensitive key: suppress
the entire preview if isolation is uncertain (multiline/free-text ambiguity is
not solved by truncation). No command execution, filesystem probing, clickable
automatic URL or HTML interpretation. Redaction is best-effort, not proof that
arbitrary user text is safe. Receiver allowlisting/scrubbing is mandatory too.

Unpaired Unicode surrogates, required-field, identity, version, scope/directory contradiction or wire-size
errors reject the monitor before state mutation. Invalid optional groups are
omitted: one bad row/duplicate ID/over-cap array omits that array; invalid
`usage.context` omits context but not valid totals, and vice versa. Invalid
optional scalar previews are omitted. Unknown fields are discarded, never
retained or passed through to the UI. This includes prohibited fields at every
depth (`title`, `prompt`, `assistant_response`, `final_summary`, `summary`,
`goal`, `error`, `text`, `environment`, `terminal`, and raw input/result bodies).
Wire fixtures marked valid test acceptance **after** this scrubbing, not producer
permission to emit prohibited fields. Invalid known numbers (negative, null,
boolean, non-finite or fractional counters) omit their whole optional usage
subgroup; absent counters remain absent. Malformed JSON is dropped before parse.
Malformed controls are ignored atomically, never used as an empty roster.

An absent/invalid monitor on a canonical hook yields `legacy`; standalone invalid
`AgentDisplayUpdate` yields `ignored`. Legacy dispatch for these adapters still
receives only the allowlisted envelope, never prohibited content. This
compatibility rule never authorizes producer bodies or logging: all packets
from these two adapters, even malformed/legacy, bypass hook logging. Valid
sequence <= last accepted sequence yields `stale`, including accompanying
canonical side effects: an old `Stop` cannot finish a newer active session.

Shared result: `{disposition: legacy|accepted|stale|ignored, key?,
status_changed: boolean}`. Key uses the tuple above; no decision field. Internal
`MonitorPacket` is `{agent, session_id?, cwd?, monitor}` with validated wire
names unchanged; `Packet` in JS means the outer wire envelope. `MonitorUsage`
mirrors `monitor.usage`. `observations(agent)` exposes at most 8
`{emitter_id, approval, received_at_ms}` values; a new agent snapshot replaces
only that emitter's observations before the overall cap is enforced. Across
emitters retain the newest eight observations by local receipt time, breaking
ties by the tuple `[emitter_id, approval.id]` in Unicode scalar order. Do not keep
discarded observations in a hidden cache. An agent-scope snapshot permits only
required fields, `approvals`, and `overflow`; it has no cwd/session metadata.

For `accepted` session snapshots, `key` is the session tuple and `status_changed`
is true on creation, status change or removal, false for detail-only changes.
For accepted agent snapshots/controls, no key is returned; `status_changed` is
true only when visible status, observations or membership changes. `legacy`,
`ignored` and `stale` have `status_changed: false`; only stale session packets
also return their session key. Capacity rejection is `ignored`.

## Teardown, reset and content-free liveness

An ended snapshot contains only required fields and its envelope identity:

```json
{
  "hook_event_name": "AgentDisplayUpdate",
  "coucou_agent": "hermes",
  "session_id": "fixture-old-session",
  "coucou_monitor": {
    "version": 1, "emitter_id": "fixture-emitter-h", "sequence": 9,
    "scope": "session", "status": "ended", "directory_known": false
  }
}
```

Session-scope `ended` immediately clears that session. Agent-scope `ended`
(no session_id) clears **all sessions and observations for that emitter**.
Content-bearing ended packets are invalid; no directory/rows/usage/labels.
Reset sends an old-session ended marker, then a new-session snapshot only if
the new explicit identity is known. It never copies old details into the new
session. `finished`, `failed`, `interrupted` are turn outcomes, not teardown.
Hermes `on_session_end` is turn-scoped; finalize/reset controls lifetime cleanup.

No additional teardown event name is needed. Shut down producers by cancelling
pending metadata reads, advancing the local enable-generation, clearing queues,
snapshots/counters/lookups/dedupe, and best-effort sending the empty ended marker.
Paused receivers ignore incoming updates before display mutation/logging.
Store `clear()` removes all monitor-owned content/references/timers/UI text,
including hidden DOM, existing task steps/cwd, and currently focused Details.
Only the user-approved temporary replay markers can remain. Process exit removes
those too; replay protection is volatile, not a restart guarantee.
There is no 60-second retention. Generic `Session ended — details cleared` and
Back can remain; the 5.2-second finish animation retains no ended content.

Every 10 seconds while enabled (and immediately at start), send:

```json
{
  "hook_event_name": "AgentDisplayAlive",
  "coucou_agent": "opencode",
  "coucou_monitor": {
    "version": 1,
    "emitter_id": "fixture-emitter-a",
    "active_session_ids": ["fixture-session-a"]
  }
}
```

This exact control shape has no sequence/scope/status/directory or other content;
top-level fields are only event, agent and monitor. `active_session_ids` is at
most 16 unique valid opaque IDs. Empty is valid and clears all session snapshots
for that emitter, not its uncorrelated shelf. The roster is the producer's
admitted live display sessions, not a scan of host history. Missing sessions
are cleared. No valid signal for >=30000 ms clears the whole emitter, including
its uncorrelated observations. Before the first heartbeat, first accepted
display receipt starts a single 30000-ms grace; further content never extends
that grace. Heartbeats never create details or advance content freshness.

`AgentDisplayAlive` returns `accepted` when valid and not retired, otherwise `ignored`. A valid
heartbeat for an unknown emitter allocates no state. It has no content sequence.
The draft requires FIFO processing for all packets from an emitter, **including
controls**; existing fire-and-forget sockets do not prove that ordering across
connections. Never coalesce across a teardown/control barrier. The ordered
fixtures assume this requirement; they do not verify transport enforcement.
Session and agent sequences
are separate positive counters. Repeated/decreasing sequences are stale within
the same live scoped identity; they do not refresh freshness or liveness.

Use injected local monotonic receipt milliseconds, not producer wall-clock
timestamps. A quiet tool with heartbeat stays live with stale content; after
30000 ms without a content update show `Last update … ago`, not invented
disconnect/finish. Known upstream stream loss uses `status: unknown`; no raw
error, endpoint or invented completion. Teardown must cancel queued producer work
and pending UI callbacks. Such cancellation cannot recall bytes already sent.
Receivers check sequence before canonical side effects while that scoped
sequence state still exists. Local generation guards cover callbacks tagged
before invalidation, not previously sent packets first received after resume.
A heartbeat alone never reopens ended details. `prune(now)` clears at the exact
30000-ms boundary; after receiving a valid heartbeat at that same instant it
uses the renewed deadline. Replay events execute in listed order at equal times.
Cleanup retires the affected opaque scoped/emitter identity for the bounded
window above, without retaining its packet, usage, outcome or sequence history.
Session teardown and missing-roster entries protect that session; emitter-end,
liveness expiry and clear/pause/resume protect known emitters. A valid explicit
teardown also protects an identity whose first content has not yet arrived.
Heartbeats referencing retired state are ignored atomically. Caps fail closed.
App resume starts a new local receive generation; a restarted/re-enabled producer
uses a new emitter. Markers do not prove that arbitrary old packets arriving after
expiry, or previously unseen identities arriving without a teardown/control,
are distinguishable: no receiver-generation evidence is defined on this wire.
No new reverse transport is implied.

**Unresolved implementation acceptance test (Tasks 2–7):** hold an already-sent
content packet, process a later teardown or roster clear, then release the held
packet; repeat with pause/clear/resume before its first receipt. Cleared details
must not reappear. Tauri synthetic checks now establish rejection for known or
explicitly retired identities within the approved window. They do not establish
native delivery bounds, post-expiry protection or safe initially unseen ingress.
A real bounded ordering/generation design must still be verified before full
privacy/lifetime acceptance. Do not present the window as an unlimited guarantee.

## UI/reducer invariants

Accepted snapshots use per-session lifecycle, not per-agent legacy removal
timers. For equal `turn_id` (including both absent), idle after failed/interrupted
retains that terminal status and outcome while replacing other details; it still
advances sequence and content receipt. A changed explicit turn ID or canonical
`UserPromptSubmit` starts a new turn and clears the old outcome/activity. Adapters
must preserve failures across idle too. Old finish callbacks cannot clear a new active turn. Selected session
does not move on background updates; a new background approval produces a badge.
Badge priority: pending approval, error, finished. Passive observations never
steal another integration's approval focus. Initial selection is the most recently
received session; once selected it is stable until explicitly changed or removed.
On removal choose the most recently received remaining session (tuple order
breaks equal-time ties); no remaining session means no selection. Status to BotState: thinking to
thinking; working to working; awaiting_approval to approval; retrying/compacting
to thinking; ratelimited to ratelimit; failed to error; finished to finished;
idle/interrupted/ended/unknown to idle.

Intended transport requirements are shell-free, asynchronous, ordered and bounded: one relay child,
finite 2000-ms deadline with pipe closure/reaping, latest snapshot coalescing,
at most 17 content keys (16 sessions plus an agent shelf) and a replaceable
content-free heartbeat. Clear/control priority may not be lost to content
coalescing. Render ordinary changes at most four times/second/session;
approval/terminal changes promptly. Failure drops display work, never changes
agent policy or blocks execution. Existing IPC same-user checks remain intact.

## Synthetic expectations and qualification

Fixture shapes, replay operations, exact state projection/JSON-pointer assertions,
acceptance coverage and source provenance are defined in the
[fixture README](../tests/fixtures/agent-monitor/README.md). These are intended
contract checks, not evidence that a reducer, adapter, runtime or UI already
passes. `upstream.json` has no runtime-qualified cases until the main task records
actual host evidence. Synthetic wire IDs/paths/counts never assert upstream
availability. Consult the [spec](superpowers/specs/2026-10-03-agent-session-inspector-design.md)
and [plan](superpowers/plans/2026-10-03-agent-session-inspector.md) for the remaining
runtime, transport, platform and visual gates.
