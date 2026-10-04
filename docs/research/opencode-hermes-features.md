# OpenCode V2 and Hermes Agent feature sets

Snapshot: 2026-10-03. “Upstream” below means documented by the project; “Coucou” means implemented in this repository.

## OpenCode

### Upstream capabilities

- **Surfaces:** open-source coding agent available as a terminal UI, desktop app, and web app; the CLI also supports non-interactive `run`, a minimal `mini` UI, and a shared or standalone background server.
- **Agent and coding workflow:** built-in `build` (full access), `plan` (read-only by default), and `general` subagent; configurable agents, sessions, permissions, snapshots/undo, compaction, formatters, skills, slash commands, references, and worktrees.
- **Models and integrations:** multiple LLM providers plus custom provider/model configuration; local or remote MCP servers, OAuth for remote MCP, and MCP tools/prompts/resources; web-search providers.
- **Extension/API surface:** V2 plugins can add or transform agents, providers/models, commands, integrations, MCP servers, skills, tools, VCS/worktree strategies, web search, storage, and session behavior. Plugins can subscribe to the public event stream and register lifecycle/request hooks. A typed HTTP client exposes the server API and live async event stream.

### Coucou integration support

- The intended V2 entrypoint plus `events.mjs` and `relay.mjs` belongs in one plugin directory; installation is described in `docs/AGENTS.md`.
- Baseline synthetic event mapping and minimal source data are tested, not real V2 compatibility. The installed CLI is `1.18.32`; qualification of native V2 events remains blocked.
- This is **monitoring-only**: permission events are ignored and approvals remain in OpenCode. Delivery is bounded, shell-free and silent; prompt/response/raw tool/error data is excluded. No new transport or setting is added.

## Hermes Agent

### Upstream capabilities

- **Core agent:** terminal/TUI chat with streaming tool output, model/provider switching, context compression, sessions/history, skills, persistent memory, project context files/references, checkpoints/rollback, customizable personality, and themes.
- **Automation and scale:** scheduled tasks/cron with platform delivery, isolated parallel subagents, Python tool-RPC code execution, event hooks, and batch processing for large prompt/trajectory workloads.
- **Tools and media:** toolsets for web search, terminal/file work, memory and delegation; browser automation, vision/image paste, image generation, voice mode, wake word, TTS, and voice-message transcription.
- **Integrations and reach:** messaging gateway support for Telegram, Discord, Slack, WhatsApp, Signal, and other documented adapters; stdio/HTTP MCP, provider routing/fallbacks/credential pools, external memory providers, OpenAI-compatible API server, and ACP IDE integration.
- **Extensibility:** native Python plugins can register tools, commands, skills, and hooks; documented hooks cover LLM turns, tool calls, sessions, streaming, and subagent lifecycle. Portable Agent Plugins v1 packages are also supported as a compatibility subset.

### Coucou integration support

- Installation must include `plugin.yaml`, `__init__.py` and `relay.py`; see `docs/AGENTS.md`. No user installation/configuration was changed by this work.
- The adapter registers documented observer hooks for session start/end, LLM-turn start, tool start/completion/failure, and subagent start/stop, mapping them to Coucou events with `coucou_agent: "hermes"`.
- This is **monitoring-only**: it does not register approval or permission handling. Minimal builders and bounded delivery have synthetic checks; real rich-hook qualification is pending (isolated doctor timed out). Prompts/responses/raw arguments/results are not forwarded.

The Tauri session inspector currently consumes synthetic local wire snapshots;
the rich producers and SwiftUI lane are pending. Consult the actual
[verification receipt](agent-inspector-verification.md) rather than this upstream
inventory for implementation/runtime/platform status.

## Sources

### OpenCode (official)

- https://opencode.ai/v2/docs/
- https://opencode.ai/v2/docs/cli
- https://opencode.ai/v2/docs/config
- https://opencode.ai/v2/docs/mcp-servers
- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/build/client
- https://github.com/anomalyco/opencode

### Hermes Agent (official)

- https://hermes-agent.nousresearch.com/docs/user-guide/features/overview
- https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
- https://hermes-agent.nousresearch.com/docs/developer-guide/plugins
- https://github.com/NousResearch/hermes-agent

### Coucou implementation checked

- `docs/AGENTS.md`
- `integrations/opencode/coucou.ts`
- `integrations/opencode/events.mjs`
- `integrations/hermes/coucou/plugin.yaml`
- `integrations/hermes/coucou/__init__.py`
