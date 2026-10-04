"""Execute the shipped Python relays, using only private temporary Unix sockets.

These are relay tests, not native app-log/Swift/Rust qualification. Native checks
must run on their own toolchains; this test never substitutes source assertions.
"""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "NotchBuddy/Sources/App/HookServer.swift"
SOCKETS = {
    "GitHub": "~/Library/Application Support/NotchBuddy/nb.sock",
    "AppStore": "~/Library/Containers/fr.louisraille.Coucou/Data/nb.sock",
}


def snapshot(agent="opencode", **changes):
    packet = {
        "coucou_agent": agent,
        "hook_event_name": "AgentDisplayUpdate",
        "session_id": "session-é🦊",
        "coucou_monitor": {
            "version": 1, "emitter_id": "emitter-é🦊", "sequence": 7,
            "scope": "session", "status": "working", "directory_known": False,
            "tools": [{"id": "tool-é", "name": "read", "state": "running"}],
            "approvals": [{"id": "observation-1", "request_id": "nested-request",
                           "state": "pending"}],
            "usage": {"context": {"tokens": 32000, "limit": 128000,
                                  "quality": "reported", "accounting": "includes_cache"},
                      "totals": {"scope": "session", "input": 96000,
                                 "cost_usd": 0.125, "accounting": "includes_cache"}},
        },
    }
    packet.update(changes)
    return packet


def boundary_snapshot():
    packet = snapshot()
    monitor = packet["coucou_monitor"]
    monitor["files"] = [{"id": f"file-{i}", "path": "é" * 480,
                         "cwd": "/fixture/" + "a" * 951,
                         "action": "read", "state": "completed"} for i in range(20)]
    monitor["tools"] = [{"id": f"tool-{i}", "name": "read", "state": "completed",
                         "command": "x" * 990, "target": "🦊" * 240,
                         "cwd": "/fixture/" + "b" * 951} for i in range(8)]
    monitor["approvals"][0].update({"target": "/fixture/" + "c" * 491, "command": ""})
    size = len(json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode())
    padding = 65536 - size
    assert 0 <= padding <= 1000
    monitor["approvals"][0]["command"] = "x" * padding
    return packet


class GitHubRelayTests(unittest.TestCase):
    variant = "GitHub"

    def setUp(self):
        # Keep the path short enough for macOS sun_path as well as Linux.
        base = "/tmp/opencode" if Path("/tmp/opencode").is_dir() else None
        self.temp = tempfile.TemporaryDirectory(prefix="relay-", dir=base)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "fixture.sock"
        text = SOURCE.read_text()
        text = text.split(f'private let nbHookPython{self.variant} = """\n', 1)[1]
        text = text.split('\n"""', 1)[0]
        # Swift's non-raw multiline string turns doubled backslashes into one.
        text = text.replace("\\\\", "\\")
        self.assertIn(SOCKETS[self.variant], text)
        text = text.replace(SOCKETS[self.variant], str(self.path))
        self.script = self.root / "relay.py"
        self.script.write_text(text)
        self.env = {
            "PATH": os.defpath, "HOME": str(self.root), "PYTHONDONTWRITEBYTECODE": "1",
            "TERM_PROGRAM": "private-terminal", "ITERM_SESSION_ID": "private-iterm",
            "TERM_SESSION_ID": "private-terminal-session", "__CFBundleIdentifier": "private-bundle",
            "GEMINI_SESSION_ID": "private-environment-session",
        }

    def run_relay(self, payload, args=(), mode="capture", response=None):
        received = []
        errors = []
        release = threading.Event()
        listener = None
        thread = None
        if mode != "absent":
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(self.path))
            listener.listen(1)
            listener.settimeout(0.4)

            def serve():
                try:
                    try:
                        peer, _ = listener.accept()
                    except socket.timeout:
                        return
                    with peer:
                        if mode == "close":
                            return
                        peer.settimeout(2)
                        wire = b""
                        while not wire.endswith(b"\n"):
                            chunk = peer.recv(4096)
                            if not chunk:
                                break
                            wire += chunk
                        if wire:
                            received.append(wire)
                        if response is not None:
                            try:
                                peer.sendall(json.dumps(response).encode() + b"\n")
                            except (BrokenPipeError, ConnectionResetError):
                                pass
                        # Hold the connection open until the relay exits. A relay
                        # waiting for a decision, rather than EOF, fails the test.
                        release.wait(3)
                except Exception as exc:
                    errors.append(exc)

            thread = threading.Thread(target=serve)
            thread.start()
        raw = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        try:
            try:
                proc = subprocess.run(
                    [sys.executable, "-B", str(self.script), *args], input=raw,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    cwd=self.root, env=self.env, timeout=1.5,
                )
            except subprocess.TimeoutExpired:
                self.fail("relay entered decision waiting for a passive observation")
        finally:
            release.set()
            if thread:
                thread.join(3)
            if listener:
                listener.close()
                self.path.unlink(missing_ok=True)
        self.assertFalse(errors, errors)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr, b"")
        for wire in received:
            self.assertTrue(wire.endswith(b"\n"))
            self.assertEqual(wire.count(b"\n"), 1)
        return [json.loads(wire) for wire in received], proc.stdout

    def forwarded(self, payload, **kwargs):
        received, stdout = self.run_relay(payload, **kwargs)
        self.assertEqual(stdout, b"")
        self.assertEqual(len(received), 1)
        return received[0]

    def test_unknown_directory_is_never_inferred(self):
        for agent in ("opencode", "hermes"):
            for extra in ({}, {"cwd": ""}, {"workspacePaths": ["/private/fallback"]}):
                with self.subTest(agent=agent, extra=extra):
                    packet = snapshot(agent, **extra)
                    forwarded = self.forwarded(packet)
                    self.assertEqual(forwarded.get("cwd", ""), "")
                    self.assertEqual(forwarded["coucou_monitor"], packet["coucou_monitor"])

    def test_explicit_directory_and_nested_metadata_survive(self):
        packet = snapshot(cwd="/fixture/日本語 é🦊")
        packet["coucou_monitor"]["directory_known"] = True
        self.assertEqual(self.forwarded(packet), packet)

    def test_content_free_liveness_and_teardown_gain_no_context(self):
        packets = [
            {"hook_event_name": "AgentDisplayAlive", "coucou_agent": "opencode",
             "coucou_monitor": {"version": 1, "emitter_id": "emitter-é🦊",
                                "active_session_ids": ["session-é🦊"]}},
            {"hook_event_name": "AgentDisplayUpdate", "coucou_agent": "hermes",
             "coucou_monitor": {"version": 1, "emitter_id": "emitter-é🦊", "sequence": 9,
                                "scope": "agent", "status": "ended", "directory_known": False}},
            {"hook_event_name": "AgentDisplayAlive", "coucou_agent": "hermes"},
        ]
        for packet in packets:
            with self.subTest(packet=packet):
                self.assertEqual(self.forwarded(packet), packet)

    def test_exact_64k_unicode_snapshot_preserves_all_nested_fields(self):
        packet = boundary_snapshot()
        raw = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertEqual(len(raw), 65536)
        self.assertEqual(self.forwarded(raw), packet)
        self.assertEqual(self.forwarded(raw + b"\n"), packet)

    def test_private_raw_65537_bytes_cannot_be_laundered_by_filtering(self):
        packet = snapshot(body="")
        size = len(json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode())
        packet["body"] = "x" * (65536 - size)
        raw = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertEqual(len(raw), 65536)
        self.assertEqual(self.forwarded(raw), snapshot())
        for over in (raw + b" ", raw + b" \n"):
            with self.subTest(length=len(over)):
                received, stdout = self.run_relay(over)
                self.assertEqual(received, [])
                self.assertEqual(stdout, b"")

    def test_private_serialization_growth_is_bounded(self):
        packet = boundary_snapshot()
        del packet["coucou_agent"]
        packet["coucou_monitor"]["approvals"][0]["command"] += "x" * 26
        raw = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertLessEqual(len(raw), 65536)
        received, stdout = self.run_relay(raw, args=("--agent", "opencode"))
        self.assertEqual(received, [])
        self.assertEqual(stdout, b"")

    def test_invalid_utf8_is_silent_even_when_json_decoder_accepts_other_encodings(self):
        for raw in (b'{"coucou_agent":"opencode","body":"\xff"}',
                    json.dumps(snapshot()).encode("utf-16")):
            with self.subTest(encoding=raw[:4]):
                received, stdout = self.run_relay(raw)
                self.assertEqual(received, [])
                self.assertEqual(stdout, b"")

    def test_former_preview_fields_never_reach_ipc(self):
        expected = snapshot()
        expected["coucou_monitor"].update({"status": "finished", "outcome": "completed",
            "subagents": [{"id": "child", "state": "finished"}],
            "activity": [{"id": "retry", "kind": "retry"}]})
        packet = json.loads(json.dumps(expected))
        prohibited = {key: "RAW_BODY" for key in (
            "title", "final_summary", "error", "role", "summary", "goal", "text",
            "prompt", "assistant_response", "response", "body", "diff", "environment", "terminal")}
        packet.update(prohibited)
        monitor = packet["coucou_monitor"]
        monitor.update(prohibited)
        for group in ("tools", "approvals", "subagents", "activity"):
            monitor[group][0].update(prohibited)
        self.assertEqual(self.forwarded(packet), expected)

    def test_reason_outcome_and_activity_are_enum_only(self):
        for invalid in ("RAW_BODY", "message", {}, ["RAW_BODY"], 1, None):
            with self.subTest(invalid=invalid):
                packet = snapshot()
                packet["coucou_monitor"]["outcome"] = invalid
                packet["coucou_monitor"]["approvals"][0]["reason"] = invalid
                packet["coucou_monitor"]["activity"] = [{"id": "row", "kind": invalid}]
                expected = snapshot()
                expected["coucou_monitor"]["activity"] = [{"id": "row"}]
                self.assertEqual(self.forwarded(packet), expected)
        for status, outcome in (("finished", "completed"), ("failed", "failed"),
                                ("failed", "incomplete"), ("interrupted", "interrupted")):
            packet = snapshot()
            packet["coucou_monitor"].update({"status": status, "outcome": outcome,
                "activity": [{"id": str(i), "kind": kind} for i, kind in enumerate(
                    ("retry", "rate_limit", "compaction", "error", "session_reset"))],
                "approvals": [{"id": str(i), "state": "pending", "reason": reason}
                              for i, reason in enumerate(("permission_required", "policy", "unknown"))]})
            self.assertEqual(self.forwarded(packet), packet)
        packet = snapshot()
        packet["coucou_monitor"]["outcome"] = "completed"
        self.assertEqual(self.forwarded(packet), snapshot())

    def test_legacy_large_valid_envelope_remains_supported(self):
        packet = {"hook_event_name": "SessionStart", "session_id": "legacy", "body": "x" * 65537}
        self.assertEqual(self.forwarded(packet)["body"], packet["body"])

    def test_private_raw_fields_are_removed_even_when_nested(self):
        packet = snapshot(prompt="RAW_PROMPT", response="RAW_RESPONSE", body="RAW_BODY",
                          diff="RAW_DIFF", tool_input={"content": "RAW_CONTENT"},
                          tool_response="RAW_TOOL_RESPONSE", transcript_path="/private/transcript",
                          request_id="must-not-be-an-approval", term_program="private-terminal")
        packet["coucou_monitor"]["body"] = "NESTED_BODY"
        packet["coucou_monitor"]["tools"][0]["response"] = "NESTED_RESPONSE"
        self.assertEqual(self.forwarded(packet), snapshot())

    def test_private_legacy_event_has_no_environment_or_body_enrichment(self):
        packet = {"coucou_agent": "hermes", "hook_event_name": "SessionStart",
                  "prompt": "private prompt", "toolCall": {"name": "private tool"}}
        self.assertEqual(self.forwarded(packet), {
            "coucou_agent": "hermes", "hook_event_name": "SessionStart",
        })

    def test_private_canonical_tool_labels_survive_without_raw_content(self):
        for agent in ("opencode", "hermes", None):
            for event in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
                for label in ("bash", "mcp__server.tool:read-file", "日本語_é9.:-Ⅻ²",
                              "a" * 256, "é" * 128):
                    with self.subTest(agent=agent, event=event, label=label):
                        expected = snapshot(agent, hook_event_name=event, tool_name=label)
                        if agent is None:
                            del expected["coucou_agent"]
                        packet = json.loads(json.dumps(expected))
                        packet.update({key: "PRIVATE_FIXTURE" for key in (
                            "tool_input", "tool_output", "tool_response", "error", "body", "diff",
                            "prompt", "response", "credentials", "request_id", "coucou_kind")})
                        packet["coucou_monitor"]["tools"][0]["error"] = "PRIVATE_FIXTURE"
                        self.assertEqual(self.forwarded(packet), expected)

    def test_private_tool_labels_reject_malformed_or_content_bearing_values(self):
        invalid = (None, False, 7, {}, [], "", "a" * 257, "é" * 129,
                   "bash --token=PRIVATE_FIXTURE", "read file", "--token=PRIVATE_FIXTURE",
                   "read/file", "read\nfile", "read\tfile", "read\x00file", "read\x7f",
                   "read\u0085", "🦊", "e\u0301", "\u0345", "Ⓐ", "\ud800", "\udfff")
        for event in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
            for label in invalid:
                with self.subTest(event=event, label=repr(label)):
                    expected = snapshot("hermes", hook_event_name=event)
                    packet = dict(expected, tool_name=label)
                    # JSON escapes let malformed surrogate labels reach the real decoder.
                    self.assertEqual(self.forwarded(json.dumps(packet).encode()), expected)

    def test_private_tool_labels_are_omitted_for_noncanonical_events(self):
        for event in ("AgentDisplayUpdate", "AgentDisplayAlive", "SessionStart", "Stop",
                      "BeforeTool", "PostToolUseOther", "", None, {}, [], 7):
            with self.subTest(event=event):
                expected = snapshot("opencode", hook_event_name=event)
                # Existing argv fallback behavior for falsey event names is unchanged.
                if not event:
                    expected["hook_event_name"] = ""
                self.assertEqual(self.forwarded(snapshot("opencode", hook_event_name=event,
                                                        tool_name="read")), expected)

    def test_private_canonical_labels_never_enter_legacy_decision_modes(self):
        for args in ((), ("--ask",), ("--statusline",)):
            with self.subTest(args=args):
                expected = snapshot("hermes", hook_event_name="PreToolUse", tool_name="AskUserQuestion")
                packet = dict(expected, tool_input={"questions": []}, coucou_kind="ask_user_question")
                self.assertEqual(self.forwarded(packet, args=args,
                                               response={"permissionDecision": "allow"}), expected)

    def test_legacy_tool_labels_and_inputs_are_not_subject_to_private_filter(self):
        for agent in (None, "codex"):
            packet = {"hook_event_name": "PreToolUse", "tool_name": "bash --token=PRIVATE_FIXTURE",
                      "tool_input": {"command": "fixture command"}}
            if agent:
                packet["coucou_agent"] = agent
            forwarded = self.forwarded(packet)
            self.assertEqual(forwarded["tool_name"], packet["tool_name"])
            self.assertEqual(forwarded["tool_input"], packet["tool_input"])

    def test_cli_agent_and_event_are_classified_before_enrichment(self):
        self.assertEqual(self.forwarded({}, args=("--agent", "opencode", "AgentDisplayAlive")), {
            "coucou_agent": "opencode", "hook_event_name": "AgentDisplayAlive",
        })

    def test_cli_private_identity_cannot_be_overridden_by_legacy_payload(self):
        self.assertEqual(self.forwarded({"coucou_agent": "codex", "hook_event_name": "SessionStart"},
                                        args=("--agent", "hermes")), {
            "coucou_agent": "hermes", "hook_event_name": "SessionStart",
        })

    def test_malformed_monitor_cannot_lose_its_only_private_marker(self):
        received, stdout = self.run_relay({"coucou_monitor": "RAW", "hook_event_name": "private-event-text"})
        self.assertEqual(received, [])
        self.assertEqual(stdout, b"")

    def test_display_event_without_an_agent_still_gets_privacy_filtering(self):
        for event in ("AgentDisplayUpdate", "AgentDisplayAlive"):
            with self.subTest(event=event):
                self.assertEqual(self.forwarded({"hook_event_name": event, "prompt": "RAW",
                                                "request_id": "RAW"}), {"hook_event_name": event})

    def test_unknown_fields_and_objects_in_scalar_slots_are_not_forwarded(self):
        packet = snapshot()
        packet["coucou_monitor"].update({"unknown": "RAW", "model": {"content": "RAW"},
                                         "capabilities": {"files": "reported", "unknown": "RAW"},
                                         "overflow": {"tools": 2, "unknown": "RAW"}})
        packet["coucou_monitor"]["tools"][0]["name"] = {"response": "RAW"}
        packet["coucou_monitor"]["usage"]["totals"]["unknown"] = "RAW"
        expected = snapshot()
        del expected["coucou_monitor"]["tools"][0]["name"]
        expected["coucou_monitor"].update({"capabilities": {"files": "reported"}, "overflow": {"tools": 2}})
        self.assertEqual(self.forwarded(packet), expected)

    def test_private_controls_ignore_ask_and_statusline_modes(self):
        for arg in ("--ask", "--statusline"):
            packet = snapshot(tool_name="AskUserQuestion", tool_input={"questions": []})
            with self.subTest(arg=arg):
                self.assertEqual(self.forwarded(packet, args=(arg,)), snapshot())

    def test_passive_permission_observations_never_wait_or_print_decisions(self):
        for agent in ("opencode", "hermes"):
            with self.subTest(agent=agent):
                received, stdout = self.run_relay(snapshot(agent, hook_event_name="PermissionRequest"))
                self.assertEqual(received, [])
                self.assertEqual(stdout, b"")

    def test_controls_ignore_an_unsolicited_decision(self):
        packet = snapshot()
        self.assertEqual(self.forwarded(packet, response={"permissionDecision": "allow"}), packet)

    def test_private_malformed_packets_are_silent(self):
        for raw in (b'{"coucou_agent":"hermes",', b"null", b"[]"):
            with self.subTest(raw=raw):
                received, stdout = self.run_relay(raw, mode="absent")
                self.assertEqual(received, [])
                self.assertEqual(stdout, b"")
        packet = {"coucou_agent": "opencode", "hook_event_name": "AgentDisplayUpdate",
                  "coucou_monitor": "RAW_MALFORMED_PAYLOAD", "prompt": "RAW_PROMPT"}
        self.assertEqual(self.forwarded(packet), {
            "coucou_agent": "opencode", "hook_event_name": "AgentDisplayUpdate",
        })

    def test_malformed_private_statusline_never_delegates_the_raw_input(self):
        (self.root / "statusline-previous.json").write_text(json.dumps({"command": "cat"}))
        received, stdout = self.run_relay(b'{"coucou_agent":"opencode","prompt":"RAW",',
                                         args=("--statusline",), mode="absent")
        self.assertEqual(received, [])
        self.assertEqual(stdout, b"")

    def test_absent_or_immediate_close_server_is_silent(self):
        for mode in ("absent", "close"):
            with self.subTest(mode=mode):
                received, stdout = self.run_relay(snapshot(), mode=mode)
                self.assertEqual(received, [])
                self.assertEqual(stdout, b"")

    def test_legacy_claude_and_codex_keep_cwd_and_terminal_fallback(self):
        for agent in (None, "codex"):
            for extra, expected in (({}, str(self.root)), ({"cwd": ""}, str(self.root)),
                                    ({"workspacePaths": ["/explicit/root"]}, "/explicit/root"),
                                    ({"cwd": "/explicit/cwd"}, "/explicit/cwd")):
                with self.subTest(agent=agent, extra=extra):
                    packet = {"hook_event_name": "SessionStart", "session_id": "legacy", **extra}
                    if agent:
                        packet["coucou_agent"] = agent
                    forwarded = self.forwarded(packet)
                    self.assertEqual(forwarded["cwd"], expected)
                    self.assertEqual(forwarded["session_id"], "legacy")
                    self.assertEqual(forwarded["term_program"], "private-terminal")

    def test_legacy_permissions_still_translate_claude_and_codex(self):
        for agent, permissions in ((None, {"updatedPermissions": [{"type": "allow"}]}), ("codex", {})):
            args = () if agent is None else ("--agent", agent)
            _, stdout = self.run_relay({"hook_event_name": "PermissionRequest",
                                       "permission_suggestions": [{"type": "allow"}]}, args=args,
                                      response={"permissionDecision": "always"})
            self.assertEqual(json.loads(stdout), {"hookSpecificOutput": {
                "hookEventName": "PermissionRequest", "decision": {"behavior": "allow", **permissions},
            }})

    def test_legacy_gemini_normalization_and_reply_survive(self):
        received, stdout = self.run_relay({"toolCall": {"name": "Read", "args": {"Path": "file.py"}},
                                          "conversationId": "legacy-id"},
                                         args=("--agent", "gemini", "BeforeTool"))
        self.assertEqual(stdout, b"{}\n")
        self.assertEqual(received[0]["hook_event_name"], "PreToolUse")
        self.assertEqual(received[0]["tool_input"]["path"], "file.py")
        self.assertEqual(received[0]["session_id"], "legacy-id")

    def test_legacy_ask_mode_keeps_its_answer_and_agent_handling(self):
        questions = [{"question": "Fixture?", "options": [{"label": "Yes"}]}]
        received, stdout = self.run_relay({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion",
                                          "tool_input": {"questions": questions}},
                                         args=("--ask", "--agent", "codex"),
                                         response={"permissionDecision": "answer", "answers": {"Fixture?": "Yes"}})
        self.assertNotIn("coucou_agent", received[0])
        self.assertEqual(received[0]["coucou_kind"], "ask_user_question")
        self.assertEqual(json.loads(stdout), {"hookSpecificOutput": {"hookEventName": "PreToolUse",
            "permissionDecision": "allow", "updatedInput": {"questions": questions, "answers": {"Fixture?": "Yes"}}}})

    def test_legacy_statusline_still_relays_and_delegates(self):
        (self.root / "statusline-previous.json").write_text(json.dumps({"command": "printf fixture-status"}))
        received, stdout = self.run_relay({"session_id": "legacy", "rate_limits": {"five_hour": 0.25}},
                                         args=("--statusline",))
        self.assertEqual(received, [{"coucou_kind": "statusline", "session_id": "legacy",
                                     "rate_limits": {"five_hour": 0.25}}])
        self.assertEqual(stdout, b"fixture-status")


class AppStoreRelayTests(GitHubRelayTests):
    variant = "AppStore"


if __name__ == "__main__":
    unittest.main()
