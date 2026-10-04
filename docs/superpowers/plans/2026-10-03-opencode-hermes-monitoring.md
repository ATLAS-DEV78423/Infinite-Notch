# OpenCode and Hermes monitoring adapters

## Goal

Add monitoring-only support for OpenCode and Hermes Agent. Each agent gets its
own Coucou pill through the existing `coucou_agent` relay path. Prompts, tool
activity, session completion, and failures are shown; approval decisions remain
in the agent's own terminal/UI.

## Constraints

- Reuse the existing macOS/Linux/Windows relay; do not add a second transport.
- Use OpenCode V2's documented plugin API and event stream.
- Use Hermes' documented general plugin hooks, not core patches or private APIs.
- Keep relay calls fire-and-forget so neither agent is blocked by Coucou.
- Do not add installers, settings UI, catalog pills, or approval handling yet.
- Preserve the existing `coucou_agent` validation and canonical event names.
- No new runtime dependencies in Coucou.

## Files

- `integrations/opencode/events.mjs` — pure OpenCode-event to Coucou-event
  mapping, kept separate so it can be tested without the OpenCode runtime.
- `integrations/opencode/coucou.ts` — OpenCode V2 plugin that subscribes to the
  public event stream and forwards mapped events to the configured relay.
- `integrations/hermes/coucou/plugin.yaml` — Hermes plugin metadata and hook
  declarations.
- `integrations/hermes/coucou/__init__.py` — Hermes hook callbacks and the
  fire-and-forget relay call; exposes pure payload helpers for tests.
- `scripts/test-agent-adapters.sh` — one stdlib-only smoke test for both
  adapters and their canonical event mappings.
- `docs/AGENTS.md` — installation/configuration instructions, event coverage,
  privacy and approval limitations for both agents.

## Acceptance criteria

1. Installing the OpenCode file as a V2 plugin and setting `COUCOU_HOOK`
   forwards session start, user prompt, tool start/completion/failure, idle,
   session end, and error events with `coucou_agent: "opencode"`.
2. Installing the Hermes plugin and setting `COUCOU_HOOK` forwards session
   start, prompt, tool start/completion/failure, turn end/failure, and
   subagent lifecycle events with `coucou_agent: "hermes"`.
3. A missing/unlaunchable relay is ignored and never raises into either agent.
4. No adapter emits `PermissionRequest` or attempts to answer approvals.
5. The focused adapter smoke test passes, and the existing project test/build
   checks are run where the current platform supports them.

## Execution tasks (RED → GREEN)

### Task 1 — Add failing adapter contract tests

Create `scripts/test-agent-adapters.sh` with Node assertions for the OpenCode
mapping and Python assertions for Hermes payload construction and hook
registration. Run it before adding adapters; it must fail because the new
modules do not exist yet.

Expected: a clear import/module-not-found failure, not a shell syntax error.

### Task 2 — Implement the Hermes adapter

Add the plugin manifest and Python module. Register only documented observer
hooks. Normalize hook payloads to the existing Coucou shape, truncate only via
the existing relay, launch `COUCOU_HOOK --agent hermes <Event>` without waiting
for output, and swallow `OSError` so the agent keeps running.

Run the focused test and confirm Hermes assertions pass.

### Task 3 — Implement the OpenCode V2 adapter

Add the pure mapper and V2 `Plugin.define` plugin. Subscribe through
`ctx.event.subscribe({ signal })`, map only stable public event families, and
abort the subscription during plugin cleanup. Use Node's built-in child
process API with an argument array; never shell-interpolate relay paths.

Run the focused test and confirm all OpenCode event mapping assertions pass.

### Task 4 — Document installation and limitations

Extend `docs/AGENTS.md` with copy locations, `COUCOU_HOOK` examples for macOS,
Linux, and Windows, the supported event mapping, and the explicit monitoring-
only/terminal-approval limitation. Link to the official OpenCode V2 plugin
docs and Hermes hook/plugin docs used for the implementation.

### Task 5 — Verify the complete change

Run `scripts/test-agent-adapters.sh`, inspect the diff for unintended files,
run the existing focused shell tests, and run the Windows TypeScript/Rust
checks if dependencies/toolchains are available. Report unavailable platform
checks rather than claiming them passed.

## Review focus

- Relay invocation cannot block or inject a shell command.
- Event mapping does not flood Coucou with OpenCode text deltas.
- Hermes callback failures are isolated.
- Approval events are not accidentally surfaced as actionable Coucou cards.
- Documentation matches the actual file paths and environment variable.

## Primary sources consulted

- OpenCode V2 plugin/event docs: `https://opencode.ai/v2/docs/build/plugins`
- OpenCode V2 client/event docs: `https://opencode.ai/v2/docs/build/client`
- Hermes plugin guide: `https://hermes-agent.nousresearch.com/docs/developer-guide/plugins`
- Hermes hook reference: `https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks`
- Coucou relay contract: `docs/AGENTS.md`
