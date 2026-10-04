# Coucou — third-party agent integration

Any tool that can write to a Unix domain socket (macOS, Linux) or a named pipe (Windows) can send events to Coucou and have its own pill next to Claude Code.

## The `coucou_agent` field

Add the optional field `coucou_agent` to any hook JSON payload. Coucou will create a pill labelled with the agent name and route all events to it.

**Validation:** the name must match `^[a-z0-9-]{1,24}$` (lowercase letters, digits and hyphens, 1–24 characters). An absent or invalid name routes the event to the Claude Code pill instead.

## Hook command (macOS)

Configure your tool to call the Coucou relay with `--agent <your-name>` after the hook executable:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "/path/to/nb-hook --agent my-tool" }
    ]
  }
}
```

The shell wrapper passes `"$@"` to the Python relay, which extracts the agent name and injects it into the payload before forwarding to Coucou.

## Hook command (Windows)

Same pattern with the Windows relay:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "C:\\path\\to\\coucou-hook.exe --agent my-tool" }
    ]
  }
}
```

## Hook command (Linux)

Same pattern with the Linux relay. Coucou copies the relay to `~/.local/share/coucou/bin/coucou-hook` at startup.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "/path/to/coucou-hook --agent my-tool" }
    ]
  }
}
```

## Payload format

The relay adds `coucou_agent` to the JSON it forwards. You can also add it yourself if you talk to the socket directly:

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "my-session-1",
  "coucou_agent": "my-tool",
  "prompt": "Running task…"
}
```

Send newline-terminated JSON to the socket:
- **macOS (GitHub build):** `~/Library/Application Support/NotchBuddy/nb.sock`
- **macOS (App Store build):** `~/Library/Containers/fr.louisraille.Coucou/Data/nb.sock`
- **Windows:** `\\.\pipe\coucou-<user-SID>`
- **Linux:** `$XDG_RUNTIME_DIR/coucou.sock` (usually `/run/user/<uid>/coucou.sock`). Only your own user account can connect.

## Supported events

All standard Claude Code hook events are supported, **except `PermissionRequest`**:
approval cards are not yet implemented for third-party agents (only Claude Code gets
one). A `PermissionRequest` from an external agent is answered immediately with no
decision, so the relay writes nothing and the agent re-asks in its terminal.
Approval support for other agents will be added with Codex support.

The pill lifecycle:

| Event | Effect |
|---|---|
| `SessionStart` | Creates the pill (if absent), sets state to idle |
| `UserPromptSubmit` | State → thinking; prompt shown in ticker |
| `PreToolUse` | State → working; tool label shown in ticker |
| `PostToolUse` / `PostToolUseFailure` | State → working |
| `Notification` | Rate-limit or question state if applicable |
| `Stop` | State → finished for 5 s; active declared pills (catalog + checked in Settings) reset to idle — all others are removed |
| `StopFailure` | State → error |
| `SessionEnd` | Active declared pills (catalog + checked in Settings) reset to idle — all others are removed |
| `SubagentStart` / `SubagentStop` | Step added to ticker |

## Declared pills

A **declared pill** is a catalog entry (`PillCatalog.swift`) that has been enabled in **Settings → Active pills**. When a session ends for a declared pill, the pill stays visible and resets to idle instead of disappearing.

A catalog pill that is not checked in Settings behaves like any other agent: it gets an automatic pill when a session starts, and that pill is removed when the session ends.

The GitHub build exposes Gemini CLI (`agent_gemini`) and Antigravity (`agent_antigravity`) in Settings → Active pills. Cursor (`agent_cursor`) and Codex (`agent_codex`, GitHub build only) are there too — their pills can be declared and set as the main pill; session support is coming in a future version.

## Real-world examples

### Gemini CLI (macOS)

Coucou supports Gemini CLI out of the box via **Settings → Gemini CLI → Install hooks**.
The installer writes to `~/.gemini/settings.json` and uses `--agent gemini` so
Gemini sessions get their own pill. The relay translates Gemini event names to canonical
Coucou events automatically.

| Gemini CLI event | Canonical event |
|---|---|
| `BeforeTool` | `PreToolUse` |
| `AfterTool` | `PostToolUse` |
| `BeforeAgent` | `UserPromptSubmit` |
| `AfterAgent` | `Stop` |

`AfterModel` is not installed — it fires on every response chunk and would flood the island.

### Antigravity — `agy` (macOS)

Coucou supports Antigravity out of the box via **Settings → Antigravity → Install hooks**.
The installer writes to `~/.gemini/config/hooks.json` (timeouts in seconds) and uses
`--agent antigravity`. The relay translates `toolCall.name` / `conversationId` to the
island's `tool_name` / `session_id`.

| Antigravity event | Canonical event |
|---|---|
| `PreInvocation` | `UserPromptSubmit` |
| `PreToolUse` | `PreToolUse` |
| `PostToolUse` | `PostToolUse` |
| `PostInvocation` | `PostToolUse` |
| `Stop` | `Stop` |

### Any other tool

Follow the generic pattern: call `nb-hook --agent <your-name> <EventName>` (macOS),
`coucou-hook.exe --agent <your-name> <EventName>` (Windows)
or `~/.local/share/coucou/bin/coucou-hook --agent <your-name> <EventName>` (Linux)
and let the relay forward the event.

## OpenCode and Hermes Agent (monitoring-only)

Coucou includes experimental adapters intended for **OpenCode V2** and **Hermes Agent**.
They reuse the relay above and create dynamic `opencode` / `hermes` pills; no
new transport or Coucou setting is required.

**Rich qualification is pending.** The actual OpenCode `2.0.6` baseline plugin
and relay pass an isolated two-location scripted-model flow; installed legacy
`1.18.32` remains unchanged. Hermes passes real-host registration/dispatch with
test-supplied kwargs, not a full model turn. The Tauri inspector is wire-fixture
tested, but the adapters do not yet emit rich snapshots.
See [the verification receipt](research/agent-inspector-verification.md).

Set `COUCOU_HOOK` to the relay executable before starting the agent:

```sh
# macOS GitHub build
export COUCOU_HOOK="$HOME/Library/Application Support/NotchBuddy/nb-hook"

# Linux
export COUCOU_HOOK="$HOME/.local/share/coucou/bin/coucou-hook"
```

On Windows PowerShell, point at Coucou's installed relay:

```powershell
$env:COUCOU_HOOK = "$env:LOCALAPPDATA\Coucou\bin\coucou-hook.exe"
```

### OpenCode V2

For an isolated V2 qualification project, keep helpers inside one plugin directory:

```sh
mkdir -p .opencode/plugins/coucou
cp integrations/opencode/coucou.ts .opencode/plugins/coucou/index.ts
cp integrations/opencode/events.mjs integrations/opencode/relay.mjs .opencode/plugins/coucou/
# The verified local plugin needs its matching public host package.
npm install --prefix .opencode/plugins/coucou --save-exact --ignore-scripts \
  --no-audit --no-fund @opencode/plugin@2.0.6
```

The baseline is verified against native `2.0.6` events with `data.sessionID` and
actual location scope. It is not a rich-session or release-support claim:

| OpenCode event | Coucou event |
|---|---|
| `session.created` | `SessionStart` |
| user `session.inbox.enqueued` | `UserPromptSubmit` (without reading payload) |
| `session.tool.called` | `PreToolUse`; name from bounded `session.tool.input.started` correlation |
| `session.tool.success` | `PostToolUse` |
| `session.tool.failed` | `PostToolUseFailure` |
| `session.execution.succeeded` | `Stop` |
| `session.deleted` | `SessionEnd` |
| `session.execution.failed` | `StopFailure` |

The plugin is based on OpenCode's [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins)
and [client event stream](https://opencode.ai/v2/docs/build/client). It ignores
permission events: approvals stay in OpenCode.

Locationless outcomes/deletions require an already-owned session; a plugin's
directory filters events but never supplies a guessed cwd. Ownership is capped
at 16 sessions; event/inbox and call lookups each cap at 256 and fail closed on
pressure until deletion/unload. Rich-source admission/liveness remains pending.

### Hermes Agent

Copy the plugin into Hermes' user plugin directory and enable it:

```sh
mkdir -p "$HOME/.hermes/plugins/coucou"
cp integrations/hermes/coucou/plugin.yaml integrations/hermes/coucou/__init__.py \
  integrations/hermes/coucou/relay.py \
  "$HOME/.hermes/plugins/coucou/"
hermes plugins enable coucou
```

The adapter uses Hermes' documented hook API and maps:

| Hermes hook | Coucou event |
|---|---|
| `on_session_start` | `SessionStart` |
| `pre_llm_call` | `UserPromptSubmit` |
| `pre_tool_call` | `PreToolUse` |
| `post_tool_call` with `status=ok` | `PostToolUse` |
| other `post_tool_call` status | `PostToolUseFailure` |
| successful `on_session_end` | `Stop` |
| failed/interrupted/incomplete `on_session_end` | `StopFailure` |
| `subagent_start` / `subagent_stop` | `SubagentStart` / `SubagentStop` |

The plugin is based on Hermes' [plugin guide](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
and [hook reference](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks).

### Shared limitation

This is intentionally **monitoring only**. The adapters do not forward
`PermissionRequest` or answer approvals. Source builders exclude prompts,
responses, file bodies, diffs, raw arguments/results/errors and inferred cwd.
Each registration owns a bounded, shell-free sender (one child, 17 pending
packets, 2-second child deadline). No feature analytics, activity logs, storage
or uploads are added. Full lifetime/native privacy acceptance is still pending;
these limits are not an audit of unrelated upstream app features.

The new Tauri **Details** view displays only validated, temporary local snapshots:
files/directories, tools, context and passive approvals where supplied. Unknown
fields stay unavailable. There are no Allow/Deny controls. Teardown/pause clears
display data; user-approved opaque replay IDs can remain for at most 30 seconds
(64 per agent), solely to reject delayed updates. No commands, paths or usage are
retained in those markers. Arbitrary post-expiry/native delivery remains unverified.

Run `bash scripts/test-agent-monitor.sh` for the combined portable checks, or
add `--require-platform-checks` to fail when runtime/platform acceptance is incomplete.

## Upstream feature inventory

This list describes what the upstream agents provide; it is **not** a claim
that Coucou implements every feature. The sourced snapshot is maintained in
[`docs/research/opencode-hermes-features.md`](research/opencode-hermes-features.md).

### OpenCode V2

- **Surfaces:** terminal UI, desktop app, web app, non-interactive `run`,
  minimal `mini` UI, and shared or standalone background server.
- **Coding workflow:** build, plan, and general subagents; configurable agents,
  sessions/history, permissions, snapshots/undo, compaction, formatters,
  skills, slash commands, references, and worktrees.
- **Models and integrations:** multiple LLM providers, custom providers and
  models, local/remote MCP servers with OAuth, MCP tools/prompts/resources,
  and web-search providers.
- **Extension/API:** plugins can extend agents, providers/models, commands,
  integrations, MCP, skills, tools, VCS/worktrees, web search, storage, and
  session behavior; a typed HTTP client exposes the server API and live events.

### Hermes Agent

- **Core agent:** terminal/TUI chat, streaming tool output, model/provider
  switching, context compression, sessions/history, skills, persistent memory,
  project context files/references, checkpoints/rollback, personality, and
  themes.
- **Automation and scale:** cron/scheduled tasks with platform delivery,
  isolated parallel subagents, Python tool-RPC code execution, event hooks,
  and batch processing.
- **Tools and media:** web search, terminal/file work, memory and delegation,
  browser automation, vision/image paste, image generation, voice mode, wake
  word, TTS, and voice-message transcription.
- **Integrations:** Telegram, Discord, Slack, WhatsApp, Signal, and other
  gateway adapters; stdio/HTTP MCP, provider routing/fallbacks, credential
  pools, external memory providers, an OpenAI-compatible API server, and ACP
  IDE integration.
- **Extensibility:** native Python plugins for tools, commands, skills, and
  hooks; documented hooks for LLM turns, tools, sessions, streaming, and
  subagent lifecycle; portable Agent Plugins v1 packages.

## Quick test (Linux)

With Coucou running:

```sh
echo '{"hook_event_name":"UserPromptSubmit","session_id":"t1","prompt":"hello","coucou_agent":"demo"}' \
  | ~/.local/share/coucou/bin/coucou-hook --agent demo
```

A "demo" pill should appear in the island.

## Quick test (macOS)

With Coucou running:

```sh
echo '{"hook_event_name":"UserPromptSubmit","session_id":"t1","prompt":"hello","coucou_agent":"demo"}' \
  | /bin/sh ~/Library/Application\ Support/NotchBuddy/nb-hook --agent demo
```

A "demo" pill should appear in the island.
