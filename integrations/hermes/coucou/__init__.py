"""Monitoring-only Hermes Agent adapter for Coucou."""

from __future__ import annotations

import os
import re
import unicodedata
from collections.abc import Mapping
from typing import Any

from .relay import Relay

AGENT = "hermes"


def _bounded(value: Any, limit: int) -> bool:
    if not isinstance(value, str) or not value or len(value) > limit:
        return False
    try:
        return len(value.encode("utf-8")) <= limit and not any(
            unicodedata.category(char) in {"Cc", "Cs"} for char in value
        )
    except UnicodeEncodeError:
        return False


def _opaque(value: Any) -> str | None:
    return value if _bounded(value, 256) else None


def build_payload(
    event: str, metadata: Mapping[str, Any] | None = None, **kwargs: Any
) -> dict[str, Any] | None:
    """Select minimal metadata without enumerating or copying upstream content."""
    metadata = kwargs if metadata is None else metadata
    session_id = None
    for key in ("session_id", "child_session_id", "parent_session_id"):
        session_id = metadata.get(key)
        if session_id is not None:
            break
    session_id = _opaque(session_id)
    if session_id is None:
        return None
    payload: dict[str, Any] = {
        "hook_event_name": event,
        "coucou_agent": AGENT,
        "session_id": session_id,
    }
    # No cwd. No Hermes hook payload carries a trustworthy session directory: the
    # plugin context exposes one only through a prompt-mutating API, and the
    # shell-hook envelope that does carry cwd is a different hook system. A host
    # supplied path is agent-authored, so forwarding it would let an agent point
    # the displayed directory anywhere. Unavailable is the honest answer.
    tool_name = metadata.get("tool_name")
    if _bounded(tool_name, 256) and re.fullmatch(r"[\w.:-]+", tool_name):
        payload["tool_name"] = tool_name
    return payload


def _forward(sender: Relay, event: str, metadata: Mapping[str, Any] | None = None, **kwargs: Any) -> None:
    """Minimize synchronously before handing detached data to the owned sender."""
    try:
        metadata = kwargs if metadata is None else metadata
        if event == "on_session_end":
            failed = metadata.get("failed") or metadata.get("interrupted") or metadata.get("completed") is False
            event = "StopFailure" if failed else "Stop"
        elif event == "post_tool_call":
            event = "PostToolUse" if metadata.get("status", "ok") == "ok" else "PostToolUseFailure"
        payload = build_payload(event, metadata=metadata, **kwargs)
        if payload is None:
            return
        sender.enqueue(payload)
    except Exception:
        return


def register(ctx: Any) -> None:
    """Register only read-only lifecycle observers with Hermes."""
    sender = Relay(os.environ.get("COUCOU_HOOK", "coucou-hook"), AGENT)

    for name, callback in {
        "on_session_start": lambda **kw: _forward(sender, "SessionStart", metadata=kw),
        "on_session_end": lambda **kw: _forward(sender, "on_session_end", metadata=kw),
        "pre_llm_call": lambda **kw: _forward(sender, "UserPromptSubmit", metadata=kw),
        "pre_tool_call": lambda **kw: _forward(sender, "PreToolUse", metadata=kw),
        "post_tool_call": lambda **kw: _forward(sender, "post_tool_call", metadata=kw),
        "subagent_start": lambda **kw: _forward(sender, "SubagentStart", metadata=kw),
        "subagent_stop": lambda **kw: _forward(sender, "SubagentStop", metadata=kw),
    }.items():
        ctx.register_hook(name, callback)
    on_unload = getattr(ctx, "on_unload", None)
    if callable(on_unload):
        on_unload(sender.close)
