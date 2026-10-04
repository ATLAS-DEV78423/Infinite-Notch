# OpenCode and Hermes session inspector

Status: design approved on 2026-10-03; apply the latest privacy amendment below.
The [draft protocol](../../AGENT_MONITOR_PROTOCOL.md) and synthetic fixtures are
not full runtime qualification. Disposable OpenCode `2.0.6` baseline checks now
pass; rich-source, Hermes real-turn and native/platform gates remain open. See
[the current verification receipt](../../research/agent-inspector-verification.md).

Privacy clarification: the user approved **local display only**. Coucou receives
only the fields necessary to render the live inspector, temporarily in memory.
No analytics, tracking, activity logs, disk storage, crash-report attachment,
external transmission, or post-session history is permitted for this feature.
This replaces the earlier proposal to retain completed details for 60 seconds.

Replay-safety clarification (2026-10-04): the user permits a small, temporary,
bounded set of opaque replay identifiers solely to reject delayed local updates
after cleanup. This is not session history: all commands, paths, usage and other
display content clears immediately. Replay markers contain no display content,
are never logged/persisted/exported, and cannot authorize actions.

Data minimization rule: collect only the agent label, opaque emitter/session
identity needed for correlation, live status, working directory when explicitly
reported, safe path/command/approval previews needed for the visible cards,
context usage counters when explicitly reported, and model/provider labels when
needed for the header. Do not collect file contents, diffs, prompts, responses,
transcripts, credentials, environment/terminal metadata, arbitrary tool output, network
metadata, unrelated application state, or a broader file/app inventory.
No inferred/session titles, `final_summary`, subagent goals/summaries or raw error
text are permitted. Generic enumerated status/outcome wording replaces every
earlier response-summary requirement, including canonical-hook payloads.

## 1. Outcome and scope

Give a person running OpenCode or Hermes a useful, beautiful view of what their
agent is doing without leaving Coucou: pending commands, files being viewed or
changed, working directory, context usage, and execution status. Preserve the
existing Mochi character, animated pills, spring motion, dark cards, typography,
and restrained accent colors. Extend the existing SwiftUI and Tauri interfaces;
do not replace them with another UI framework or dashboard.

The user selected **both, phased** for command approvals:

- **Phase 1 — session inspector:** passive, display-only monitoring on macOS
  and the shared Windows/Linux Tauri interface. This is the next implementation
  scope, including adapters, relay payload, session state, UI, docs, and tests.
- **Phase 2 — interactive approvals:** separately planned after Phase 1 is
  accepted. OpenCode is a candidate through its documented permission API.
  Hermes requires a supported public decision interface; its documented
  approval observer hooks alone cannot answer requests. Do not promise parity
  by patching Hermes internals or driving its terminal.

Non-goals for Phase 1: automatic installers, permanent catalog/settings pills,
remote monitoring services, session-history databases, full transcripts, live
token streaming, arbitrary tool execution, or changes to Claude/Codex approvals.

## 2. Existing architecture and constraints

- Both adapters already send canonical hook JSON through `COUCOU_HOOK` with
  `coucou_agent` set to `opencode` or `hermes`. Keep the Unix socket/named pipe
  transports and their same-user checks; add no listening service.
- Current dynamic pills are keyed only by agent. Rich details must instead be
  isolated by **agent + emitter + session**, so simultaneous sessions do not
  mix files, usage, directories, approvals, or completion timers.
- The existing `Notification` branches recognize rate-limit text or questions;
  ordinary notifications alone will not render the requested inspector.
- Existing external-agent `PermissionRequest` handlers intentionally decline
  responsibility. Passive approval observations must not enter this blocking
  path or occupy `pendingApproval` used by existing interactive integrations.
- Relay string truncation is **not secret redaction**. Privacy filtering must
  happen in the adapters before forwarding, with validation again on receipt.
- The current adapter smoke tests do not prove real OpenCode V2 compatibility.
  Before extending mappings, verify the supported V2 runtime's typed event
  envelope and names against first-party V2 documentation and real sanitized
  fixtures. Do not treat legacy SDK `properties`/message-part shapes as V2
  evidence merely because the local tests use them. Correct baseline mapping
  defects that would prevent this feature from working.

## 3. Information shown

| Area | Display and meaning |
| --- | --- |
| Identity | Agent, short exact session ID, model/provider, parent session where known, and live-data freshness. |
| Directory | Reported session working directory and project label. Distinguish a tool's explicit working directory from the session directory. |
| Files | Recent read/write/edit/reference paths, action, and pending/running/completed/failed state. A requested read is not a successful read. |
| Current work | Tool name, safe command/path target, elapsed duration where known, and generic enumerated outcome. |
| Approvals | Safe command or resource, enumerated reason, request identity where exposed, pending/approved/denied/cancelled/unknown state, and where to respond. |
| Context | Latest reported input-context usage and model limit when available; estimated and reported values labeled differently. |
| Token totals | Input/output/reasoning/cache counters and cost only when supplied with a known accounting scope. |
| Activity | Current-turn retry/rate-limit/compaction/reset state, subagent identity/status, and generic enumerated turn outcome. No response summaries or retained activity history. |

### Directory and files

Use session/tool metadata, not the plugin process's working directory as a
substitute for a session's location. This matters for shared OpenCode servers,
Hermes gateways, SSH/container tools, and sessions moved between directories.
If unknown, show `Directory unavailable`. Display remote paths as text without
probing the local filesystem or opening them automatically.

Extract paths only from recognized tool inputs/results or explicit reference
metadata. Do not crawl directories, read files to enrich the view, infer reads
from arbitrary shell commands, or forward file bodies/diffs. Display relative
paths against a known directory; preserve the reported path in accessible
details up to the payload cap, visibly marking any truncation. Mark attempted
edits separately from confirmed changes.

### Context and usage semantics

- **Context window:** the latest request's input-context count (or upstream
  estimate), not the sum of all requests in the conversation. Show an estimate
  with `~` and `Estimated` text.
- **Window limit:** use the active model's documented runtime metadata only.
  Show a percentage/ring only when numerator and positive limit are compatible
  and known. Otherwise show the known count or `Context unavailable`.
- **Session tokens:** separate from the context gauge. Consume authoritative
  totals or accumulate unique completed request IDs; never add streaming
  updates or retry duplicates repeatedly. If capture started mid-session,
  label derived totals `Since monitoring started`.
- Show input/output/reasoning/cache buckets as reported; do not sum overlapping
  provider buckets or count cached input twice. Keep accounting-scope metadata
  through normalization. Use `—`, not zero, for absent counters.
- Compaction can lower current context while cumulative totals continue rising.
  Model changes invalidate a previous model's limit until refreshed. Do not
  derive cost from a guessed price table.

### Passive approvals

An amber card says **Awaiting approval in OpenCode/Hermes**. Show the safe
command/resource and directory, with `View details`/`Back` rather than fake
Allow/Deny buttons. Upstream resolution updates only the matching request;
other parallel tool completions must not dismiss it. Do not close another
agent's interactive approval card or steal its focus.

Hermes approval hooks may supply `session_key` instead of `session_id`, and may
omit a request ID. Correlate only with explicit, unambiguous runtime identity.
If not attributable, show an agent-level `Session unavailable` observation;
never guess from the currently focused session. An ambiguous reply must not
mark an unrelated request approved. Show `Status unknown — check agent` when
an observed request can no longer be confirmed; age alone never implies denial.

## 4. UI and animation design

### Compact and overview

Keep compact-mode geometry and Mochi animation behavior unchanged. One pill per
agent remains; it can show a session count and the existing amber/error badge.
Opening its overview shows the selected session's project, short working
directory, current tool/file activity, and a small context indicator when known.
The existing ticker remains the primary activity animation.

Add an accessible **Details** button alongside the existing jump control.
The selected session stays selected during background updates; a small session
selector inside Details permits switching without proliferating pills. An
unselected session's pending approval produces a badge/count, not a focus jump.
Initially select the most recently active session. Aggregate badge priority is
pending approval, then error, then finished; viewing the pill does not erase a
still-pending observation. Distinct session rows remain separately inspectable.

### Inspector

Use a dedicated detail state in the existing island, not a separate window.
It retains the current **640-wide** expanded geometry and uses a **280-high**
layout within the existing 320-high panel. This is an explicit, localized
exception to the current 160-high non-chat-card convention; all other views
retain their existing sizes.

- Header: Back, agent/project identity, session selector, and freshness label.
- Two aligned dark cards: **Activity** on the left, **Context & files** on the
  right. Reuse card backgrounds, fine borders, spacing, and existing accents.
- Activity: pending approval takes priority, otherwise current tool, safe
  command/path, status, and generic outcome. Current-turn activity is internally
  scrollable; no auto-growing island or constantly moving text.
- Context & files: thin progress meter with numeric caption and model label;
  up to three recent file rows initially visible, with remaining rows inside
  the card's scroll area. Secondary details disclose token buckets, reported
  cost, IDs, parent/subagent status, and the full safe directory text.
- Long commands wrap or scroll inside a bounded code block. Truncated fields
  visibly say `Truncated`; missing data has designed empty states. Never
  render upstream text as HTML or an automatically executable link.

### Motion and quality bar

- On macOS, reuse `IslandContainer`'s opening spring (response 0.5, damping
  0.72), closing curve (0.34 s), `CardBackground`, ticker, and single live
  `BotPlacement`. Reuse existing short opacity/detail transitions rather than
  rebuilding the character when entering the inspector.
- On Windows/Linux, reuse `Island.animateGeometry`, existing spring/curve
  helpers, Canvas Mochi, card classes, and `Ticker`. Update keyed content in
  place; do not recreate focused controls or reset scroll on every event.
- Animate meaningful changes: pending badge entrance, detail navigation, and
  usage meter changes. Coalesce live-display rendering to at most four ordinary
  updates per second per session; no token-by-token ticker or flashing errors.
  Approval and terminal-state changes are delivered promptly.
- Respect reduced-motion preferences: immediate geometry/state updates and
  non-looping indicators are acceptable; information remains complete.
- Keyboard navigation, visible focus, screen-reader labels, non-color status
  text, and adequate contrast apply to new controls. Numerical context text
  remains readable even without animation or color.
- Leaving Details returns to the previous overview and session. Auto-collapse
  must not dismiss content while the user is interacting with the inspector.
  Routine background updates must not repeatedly wake or expand the island.

## 5. Data flow and bounded state

### Additive local-display contract

Keep canonical hook events for existing animation/lifecycle behavior. Add an
optional `coucou_monitor` object to those payloads, and use a new non-blocking
`AgentDisplayUpdate` event when only inspector details changed. Older receivers
may ignore this event; existing Claude/generic-agent payloads remain valid.

Version 1 display data is a bounded **session snapshot**, not an arbitrary copy
of the upstream event. It contains:

- Required `version: 1`, opaque `emitter_id` (plugin-instance lifetime), positive
  increasing `sequence` per session, and `status`.
- Existing top-level `coucou_agent`, `session_id`, and `cwd` retain their meaning.
  Optional turn ID, parent session, model/provider, and capabilities are
  nested inside the monitor object.
- Structured sections for files, current tools, observed approvals, usage,
  subagent identity/status, current-turn activity enums, and outcome enum. Optional unknown fields are
  omitted; a newer snapshot replaces this session's previous monitor details.
- Approval identity stays inside the display object. Do not populate the
  legacy top-level `request_id` or emit `PermissionRequest` for observations.

Receivers validate allowed enums, shapes, lengths, and finite non-negative
numbers. A malformed monitor object is ignored without breaking an otherwise
valid legacy hook. Unsupported monitor versions never become approval actions.
Older sequences are ignored only within the same emitter/session identity;
session IDs from different agents/emitters are never conflated.
An out-of-order event with valid monitor identity must also skip its canonical
lifecycle side effects, so stale `Stop` cannot undo a newer active snapshot.

### Limits and lifecycle

Limit each session snapshot to 20 recent files, 8 tools, 8 observed approvals,
8 subagents, and 20 activity rows, with overflow counts. Cap names/IDs at 256
UTF-8 bytes, paths at 1,024, safe command previews at 1,000, and the serialized
display payload at 64 KiB. Trim complete fields/rows on character boundaries;
do not generate broken JSON. Preserve approval/status/identity before optional
current-turn display rows when trimming, and explicitly mark truncation.
Opaque IDs are never truncated: reject an oversized identity instead of risking
collisions. Unattributed approvals use producer-local observation IDs in a
separate agent-level list; these are not presented as upstream session IDs.

Keep at most 16 live session snapshots per agent in each producer and receiver.
If active sessions exceed the cap, indicate overflow rather than merging them.
Lists are bounded working state for the current live display, not an archive.
Local state is memory-only; no activity logs, transcript files, or analytics.

The sender must preserve ordering per session with a bounded, serialized
delivery path rather than one unconstrained thread/process per event. Coalesce
superseded snapshots; keep latest approval/failure/completion status. Relay
execution is shell-free, has a finite deadline, closes pipes, and reaps child
processes. Callbacks do not wait on Coucou. On backpressure or relay failure,
drop display updates safely rather than block the agent or accumulate workers.

Turn completion and session teardown are distinct. A late idle event must not
overwrite a failed turn, a new turn clears the prior turn's failure, and old
completion timers must not remove a newly active session. The current live
session may show its latest generic outcome enum, without response text or past
turns. A new turn clears that outcome. Preserve the existing short finish
animation; there is no separate 60-second completed-session retention window.

On session teardown/reset, monitoring pause/disable, plugin unload or app exit,
discard affected in-memory snapshots, queued content, counters, lookup caches
and rendered detail text, even while Details is open. Clear timers and cancel
pending reads so late work cannot repopulate cleared data. Each component clears
its monitor-owned state when stopped; paused Coucou ignores incoming updates.
Producers signal teardown without command/file/response content. Unexpected
producer loss must also expire its display state through bounded local liveness,
not leave orphaned details indefinitely. Closing Details may keep only current
live-session state needed by the overview, not an invisible history.
Use a generic `Session ended — details cleared` state with Back when necessary.
This means dropping references in application memory, not promising forensic
erasure of managed runtimes or OS memory.

Implementation gate remains unresolved: existing fire-and-forget sockets do not
prove FIFO processing across connections. Local callback generations cannot by
themselves identify an old packet first received after resume. Test delayed
already-sent content arriving after teardown/roster clear and after pause/resume;
it must not restore cleared details. The draft protocol's cleared sequence state
and absence of tombstones do not yet establish that guarantee.

For lost teardown events, a content-free local liveness signal every 10 seconds
lists only emitter identity and bounded active session IDs. Missing sessions
are cleared; no signal for 30 seconds clears that emitter. These signals are
never logged, saved or sent off-device and do not advance content freshness.
A long quiet tool can remain live without resending its command or file details.

Mark freshness using local receipt time. After 30 seconds without an update,
show `Last update … ago`, not `Disconnected` or `Finished`: a tool can legitimately
be quiet. Known stream loss/recovery is a separate status. OpenCode subscriptions
are live-only; reconnect with bounded backoff and refresh permitted session
metadata when possible. Missing replay is labeled, never reconstructed by guess.

## 6. Upstream adapter responsibilities

### OpenCode V2

Use the plugin's authenticated context and public event subscription. Scope
events by their actual location/session: a plugin instance's directory is not
necessarily the directory of every event it receives. Avoid duplicate monitoring
when more than one location loads the plugin. No credential copying into Coucou.

Before implementation, record the supported runtime/package version and verify
fixtures for prompt admission, tool execution, session outcome, permissions, and
usage against that version. That compatibility check is a prerequisite, not a
reason to add a speculative multi-version abstraction.

- Read session identity, reported directory, model/provider, and authoritative
  totals through public session/model metadata when absent from events.
- Observe permission request/reply/cancellation state without calling a reply
  API in Phase 1. Use the actual permission ID for correlation.
- Track tool call IDs and lifecycle transitions rather than repeated progress
  updates. Recognized read/edit/write tool paths feed file activity; subtask
  intent alone does not prove a subagent started or completed.
- Never capture assistant text, including completed text or generated titles.
  Map explicit completion/failure/interruption metadata to generic outcome enums.
  Preserve failed/interrupted outcomes across idle.
- Separate retry/rate-limit state from terminal failure. Refresh current
  context after compaction and model changes where the runtime reports it.

### Hermes Agent

Extend `register(ctx)` only through documented hooks and public metadata:

| Hook family | Inspector use |
| --- | --- |
| `on_session_start`, `pre_llm_call` | Session/turn identity, turn-start status, model; no prompt or platform/terminal metadata. |
| `pre_tool_call`, `post_tool_call` | Tool/file targets, tool-call identity, duration and outcome. |
| `pre_api_request`, `post_api_request`, `api_request_error` | Reported estimates/usage, model/provider, retries and provider failures. |
| `post_llm_call` | No response capture; omit this hook unless qualified non-content metadata is needed. Never emit a duplicate completion. |
| `on_session_end` | Completed, failed, incomplete, or interrupted turn outcome. |
| `on_session_finalize`, `on_session_reset` | Lifetime cleanup and explicit old/new session identities. |
| `pre_approval_request`, `post_approval_response` | Passive pending/resolved approval observations. |
| `subagent_start`, `subagent_stop` | Parent/child identities, enumerated outcome and duration; no goals, roles or summaries. |

Use sanitized metadata where supplied; never forward request bodies,
conversation history, raw tool results, or provider credentials. Extract only
allowlisted fields. `pre_tool_call` and `pre_llm_call` can affect execution:
these callbacks return `None`, do not mutate their inputs, and contain errors
without changing the agent's policy. Worker tasks receive already sanitized
snapshots, not live Hermes objects or profile secrets.

Hermes does not guarantee a session directory or context-window limit on every
hook. Show those fields as unavailable unless an explicit public source supplies
them; do not use `os.getcwd()` or output-token allowance as substitutes. Show
compaction activity only where the supported public API reports it reliably.
Unexposed capabilities are explicitly documented, not simulated.

## 7. Privacy, compatibility, and failure behavior

- No analytics, usage tracking, third-party reporting or activity collection for
  any purpose beyond the live local display. Data goes only over the existing
  same-device relay; no cloud, remote server, telemetry SDK, crash-report upload,
  network export or remote tunnel is added. Agent-host metadata access must use
  an authenticated same-device endpoint. A remote agent server is unsupported.
- No display payload, event/activity record, aggregate usage statistic, identifier
  or preview is saved to files, preferences, database, clipboard, logs, debug
  output, crash attachments or exports. Local IPC endpoints/existing executable
  installation are not activity storage. Audit and bypass existing hook event
  logs for these adapters as well as new code; redacted logs are still logs.
- The feature never scans apps, files or directories. Agents explicitly provide
  only the allowlisted fields needed for the user-requested display. Existing
  agent-host history is outside Coucou's control; do not read or copy it merely
  to populate the inspector. These requirements concern this integration, not
  an unaudited promise about every pre-existing feature of either app.
- Allowlist identity, action/path, numeric usage, status, and bounded previews.
  Remove credential-bearing keys, authorization/cookie headers, URL userinfo,
  query strings, environment values, file contents, diffs, and raw result data.
- Prompts, responses, titles, summaries and raw errors are prohibited entirely.
  Allowed commands/paths can contain secrets without sensitive key names.
  Apply preview redaction before IPC; suppress a preview
  when known secret patterns cannot be safely isolated. Redaction is best-effort,
  not a guarantee that arbitrary user text contains no secrets. Keep live content
  previews out of logs, fixtures, analytics, and committed evidence; use invented
  examples for tests and visual demonstrations.
- Validate display data again in both receivers. Treat all display strings as
  untrusted text; file paths never authorize file reads or command execution.
- Keep both macOS relay variants and the Rust relay compatible with the optional
  fields and size limits. Preserve peer checks and existing timeout behavior.
  Do not claim App Store behavior verified without a sandboxed-build test.
- Missing relay, broken pipe, full queue, invalid JSON, or unsupported fields
  must not stop an agent. For approvals, failure means **no decision by Coucou**:
  the agent's own approval policy and UI remain authoritative, never auto-allow.
- Existing integrations without monitor metadata retain their present behavior;
  the new session inspector is not a rewrite of Claude/Codex approval handling.

## 8. Phase 2 safety gate — interactive approvals

Phase 2 needs a separate implementation plan and a verified public round trip.
It must not be implemented opportunistically while building Phase 1.

For OpenCode, the agent-side plugin remains the owner of the authenticated
permission client. A future same-user decision channel must bind each decision
to agent, emitter, session, permission ID, expiry, and the exact pending request.
Do not accept an endpoint or shell command from display data as a reply target.

Only show **Allow once** / **Deny** when the adapter reports a live, verified
decision capability. Do not offer `Always` in the first interactive release.
Revalidate that the request is still pending before sending a decision; handle
already-resolved, duplicate-click, timeout, reconnect, and terminal-resolution
races. Display acknowledged outcome, not optimistic approval success.

A truncated/redacted passive preview is insufficient for consent to an unseen
action: expose adequate safe request details or direct the person back to the
agent. No UI click may run the underlying command itself. On any failed round
trip, keep the upstream agent in charge of its existing approval flow.

Hermes remains display-only until its public API can support the same contract.
Its approval observer callbacks are not a write-back mechanism. If no supported
interface exists, report that limitation and defer this phase for Hermes.

## 9. Implementation boundaries for the next plan

These are responsibilities, not authorization to begin coding. The implementation
plan will fix the exact wire types and fixtures before dividing independent work.

| Area | Existing integration points |
| --- | --- |
| OpenCode producer | `integrations/opencode/coucou.ts`, `integrations/opencode/events.mjs` |
| Hermes producer | `integrations/hermes/coucou/__init__.py`, `integrations/hermes/coucou/plugin.yaml` |
| Relay compatibility | Python relay strings in `NotchBuddy/Sources/App/HookServer.swift`; `windows/hook/src/main.rs` and `windows/src-tauri/src/hooks.rs` |
| macOS state/dispatch | `NotchBuddy/Sources/App/IslandTypes.swift`, `AppState.swift`, `HookServer.swift` |
| macOS UI/motion | `NotchBuddy/Sources/App/IslandViewContent.swift`, `IslandRootView.swift`, layout constants in `IslandTypes.swift` |
| Windows/Linux state | `windows/src/core/state.ts`, `windows/src/island/hooks.ts` |
| Windows/Linux UI/motion | `windows/src/views/views.ts`, `windows/src/core/layout.ts`, `windows/src/island/island.ts`, `windows/src/style.css` |
| Checks and documentation | `scripts/test-agent-adapters.sh`, `tests/`, `docs/AGENTS.md`, `docs/research/opencode-hermes-features.md` |

Prefer a small pure parser/reducer per platform and a focused inspector view,
instead of adding all parsing/rendering logic to the already-large view files.
Share synthetic wire fixtures across platforms to prevent schema drift. Preserve
existing unrelated work and do not alter users' global agent configuration.

## 10. Acceptance and verification

Phase 1 is complete only when these behaviors have evidence:

1. **Real compatibility:** name tested OpenCode/Hermes versions, load their
   plugins through the real host, and verify public callbacks/events. A mock
   mapper test or TypeScript syntax check alone does not prove integration.
2. **Visible flow:** for each agent, show prompt → file read → command/tool →
   pending approval → upstream resolution → completion/error, with directory,
   file state, usage and generic outcome visible where provided; no prompt or
   response content is collected at any step.
3. **Identity:** interleave two sessions and a subagent; each retains its own
   paths, model, counters, and approvals. Switching session/agent preserves
   focus and does not dismiss someone else's approval.
4. **Lifecycle:** duplicate tool/usage updates do not create repeated activity
   or token totals; failed-then-idle remains failed; a subsequent turn recovers;
   an earlier turn's completion timer cannot remove the active turn.
5. **Usage:** test exact, estimated, missing, zero-limit, negative, non-finite,
   model-switch, cache, retry, compaction, and partial-capture cases. Unknown
   values remain unknown and context is never cumulative session usage.
6. **Passive approval safety:** request/resolution observations never call a
   reply API, write a decision, or alter hook input/return policy. Ambiguous
   Hermes identity is not attributed by current focus. Existing Claude/Codex
   approval behavior remains unchanged.
7. **Transport robustness:** exercise missing executable, immediate exit/EPIPE,
   stalled reader, Unicode paths, path spaces, command metacharacters, malformed
   payloads, oversized snapshots, backpressure and stale sequences. Assert
   bounded workers/queue, finite relay lifetime, and no shell interpretation.
8. **Privacy:** synthetic secrets in command arguments, URLs, headers, errors
   and nested objects are removed or suppressed before IPC. No actual private
   user payload is copied into fixtures or test reports. File bodies and raw
   tool output never reach the inspector. Check that no integration event names,
   IDs or payloads reach existing app/relay/debug logs, persistent stores,
   network exporters or crash attachments. Test session end/reset, pause/disable,
   unload and late callbacks: all affected producer/receiver/UI buffers clear,
   even with Details open. Abrupt producer loss expires orphaned display data;
   a long quiet but connected tool is not confused with producer loss.
9. **UI polish:** inspect overview, expanded Details, long paths/commands,
   many files/sessions, pending/resolved approvals, missing live data, and
   failure states on both native and Tauri surfaces. Capture synthetic-data
   screenshots and check transitions in a live run; screenshots alone cannot
   prove animation quality. No clipping, focus loss, scroll resets, overlapping
   Mochi, flicker, or changed sizing of unrelated views.
10. **Accessibility:** exercise keyboard focus/Back/Escape, screen-reader labels,
    reduced motion, and text indicators without relying on color alone.
11. **Regression:** run the focused adapter/parser/reducer checks, existing Swift
    focused scripts, Tauri TypeScript build and Rust tests in their proper
    directories. Report missing toolchains or platform runners as unverified,
    not passed. Native visual/build checks need an appropriate native runner.

Use test-first regressions for changed mapping, merge, lifecycle and safety
logic. Test emitted payloads and rendered behavior, not source-code regexes.
Document implemented, unavailable-upstream and unverified-platform capabilities
separately. Phase 2 is not an acceptance prerequisite for Phase 1.

## 11. Sources and review gate

First-party references for planning and runtime verification:

- [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode V2 client and live-event semantics](https://opencode.ai/v2/docs/build/client)
- [OpenCode V2 API](https://opencode.ai/v2/docs/api) and
  [published OpenAPI](https://opencode.ai/v2/openapi.json)
- [Hermes plugin guide](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [Hermes hook catalog](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [Hermes observer contract](https://hermes-agent.nousresearch.com/docs/developer-guide/observer-hooks)
- [Coucou relay/setup guide](../../AGENTS.md)
- [Previous monitoring plan](../plans/2026-10-03-opencode-hermes-monitoring.md)

This spec preserves the user-selected phased scope and UI/animation constraints.
The implementation plan and draft protocol must follow the latest minimization
amendment. Runtime/platform gates stay open until supported runners provide evidence.
