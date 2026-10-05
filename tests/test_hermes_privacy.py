"""Privacy checks at Hermes' passive hook and actual process-stdin boundaries."""

import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time
import unittest
from collections.abc import Mapping
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("coucou_hermes", ROOT / "integrations/hermes/coucou/__init__.py")
adapter = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = adapter
spec.loader.exec_module(adapter)


class Metadata(Mapping):
    """Only allowed keys may be accessed; iteration would copy forbidden data."""

    def __init__(self, **values):
        self.values = values
        self.accesses = []

    def __getitem__(self, key):
        self.accesses.append(key)
        if key not in {"session_id", "child_session_id", "parent_session_id", "cwd", "tool_name"}:
            raise AssertionError(f"Forbidden lookup: {key}")
        return self.values[key]

    def __iter__(self):
        raise AssertionError("Metadata must not be copied")

    def __len__(self):
        raise AssertionError("Metadata must not be enumerated")


class ForbiddenValue(dict):
    def get(self, *args):
        raise AssertionError("Forbidden content access")

    def __bool__(self):
        raise AssertionError("Forbidden content truthiness")

    def items(self):
        raise AssertionError("Forbidden content serialization")


class PrivacyTests(unittest.TestCase):
    def test_builder_reads_only_allowlisted_mapping_keys_without_copying(self):
        metadata = Metadata(session_id="ses1", cwd="/repo", tool_name="bash")
        self.assertEqual(adapter.build_payload("PreToolUse", metadata=metadata), {
            "hook_event_name": "PreToolUse", "coucou_agent": "hermes", "session_id": "ses1", "tool_name": "bash",
        })
        self.assertEqual(metadata.accesses, ["session_id", "tool_name"])

    def test_missing_or_invalid_identity_is_dropped_without_truncation(self):
        for identity in (None, "", {}, 8, "bad\nidentity", "\u007f", "\u0085", "\ud800", "\udfff", "é" * 129, "🐾" * 65):
            with self.subTest(identity=identity):
                self.assertIsNone(adapter.build_payload("SessionStart", metadata={"session_id": identity}))
        self.assertIsNone(adapter.build_payload("SessionStart", metadata={"task_id": "task1", "session_key": "key1"}))
        self.assertEqual(adapter.build_payload("SubagentStart", metadata={"parent_session_id": "parent", "child_session_id": "child"})["session_id"], "child")

    def test_opaque_ids_preserve_spaces_punctuation_and_unicode_without_normalization(self):
        for identity in (" ", " session / #?= ", "../private", "👩‍💻", "e\u0301", "é" * 128, "🐾" * 64):
            with self.subTest(identity=identity):
                self.assertEqual(adapter.build_payload("SessionStart", metadata={"session_id": identity}), {
                    "hook_event_name": "SessionStart", "coucou_agent": "hermes", "session_id": identity,
                })

    def test_cwd_is_never_forwarded_and_never_inferred_from_process(self):
        # No Hermes hook payload carries a trustworthy session directory, and a host
        # supplied one is agent-authored, so cwd is never emitted. Unavailable is the
        # honest answer, and it is never inferred from the process either.
        with patch.object(adapter.os, "getcwd", side_effect=AssertionError("Process cwd is forbidden")):
            cases = (None, "", {}, "relative", "/bad\npath", "/\ud800",
                     "/repo", "C:\\repo", "/repo/inner", " " * 40)
            for cwd in cases:
                with self.subTest(cwd=repr(cwd)):
                    self.assertNotIn("cwd", adapter.build_payload("SessionStart", metadata={"session_id": "ses1", "cwd": cwd}))
            self.assertNotIn("cwd", adapter.build_payload("SessionStart", metadata={"session_id": "ses1"}))

    def test_tool_labels_are_bounded_generic_metadata_not_command_previews(self):
        for name in (None, "", {}, "bash --token=PRIVATE", "é" * 129):
            self.assertNotIn("tool_name", adapter.build_payload("PreToolUse", metadata={"session_id": "ses1", "tool_name": name}))
        self.assertEqual(adapter.build_payload("PreToolUse", metadata={"session_id": "ses1", "tool_name": "é" * 128}).get("tool_name"), "é" * 128)

    def test_compatible_keyword_builder_ignores_forbidden_content(self):
        forbidden = ForbiddenValue(private="PRIVATE_CONTENT")
        self.assertEqual(adapter.build_payload("PreToolUse", session_id="ses1", tool_name="bash",
            user_message=forbidden, assistant_response=forbidden, args=forbidden, error_message=forbidden), {
                "hook_event_name": "PreToolUse", "coucou_agent": "hermes", "session_id": "ses1", "tool_name": "bash",
            })

    def test_callbacks_are_passive_and_only_minimal_packets_reach_real_stdin(self):
        class Context:
            def __init__(self):
                self.hooks = {}

            def register_hook(self, name, callback):
                self.hooks[name] = callback

            def on_unload(self, callback):
                self.close = callback

        ctx = Context()
        with tempfile.TemporaryDirectory(prefix="coucou-hermes-privacy-", dir="/tmp/opencode") as directory:
            path = Path(directory)
            executable = path / "capture"
            executable.write_text(f"#!{sys.executable} -B\n" + """import json, os, signal, sys
from pathlib import Path
signal.alarm(6)
data = {"args": sys.argv[1:], "input": sys.stdin.read()}
Path(os.environ["COUCOU_CAPTURE"], str(os.getpid()) + ".json").write_text(json.dumps(data))
""")
            executable.chmod(0o700)
            forbidden = ForbiddenValue(private="PRIVATE_CONTENT")
            inputs = {
                "session_id": "ses1", "cwd": "/repo", "tool_name": "bash",
                "user_message": [forbidden], "assistant_response": forbidden,
                "args": forbidden, "tool_input": forbidden, "tool_result": forbidden,
                "error_message": forbidden, "content": forbidden, "diff": forbidden,
            }
            cases = [
                ("on_session_start", {}, "SessionStart"),
                ("pre_llm_call", {}, "UserPromptSubmit"),
                ("pre_tool_call", {}, "PreToolUse"),
                ("post_tool_call", {"status": "ok"}, "PostToolUse"),
                ("post_tool_call", {"status": "error"}, "PostToolUseFailure"),
                ("on_session_end", {"completed": False}, "StopFailure"),
                ("on_session_end", {"failed": True}, "StopFailure"),
                ("on_session_end", {"interrupted": True}, "StopFailure"),
                ("on_session_end", {"completed": True}, "Stop"),
                ("subagent_start", {}, "SubagentStart"),
                ("subagent_stop", {}, "SubagentStop"),
            ]
            threads = []
            processes = []
            thread = threading.Thread
            popen = subprocess.Popen

            def capture_process(*args, **kwargs):
                process = popen(*args, **kwargs)
                processes.append(process)
                return process

            def capture_thread(*args, **kwargs):
                worker = thread(*args, **kwargs)
                threads.append(worker)
                return worker

            # Real callbacks, real worker, real executable; the spy only counts owned workers.
            with patch.dict(os.environ, {"COUCOU_HOOK": str(executable), "COUCOU_CAPTURE": directory}), \
                    patch.object(threading, "Thread", side_effect=capture_thread), \
                    patch.object(subprocess, "Popen", side_effect=capture_process):
                self.assertIsNone(adapter.register(ctx))
                self.assertEqual(set(ctx.hooks), {
                    "on_session_start", "on_session_end", "pre_llm_call", "pre_tool_call",
                    "post_tool_call", "subagent_start", "subagent_stop",
                })
                try:
                    for callback, extra, _ in cases:
                        self.assertIsNone(ctx.hooks[callback](**inputs, **extra))
                    # A missing identity must not enqueue a fabricated session.
                    for callback, extra, _ in cases:
                        self.assertIsNone(ctx.hooks[callback](user_message=forbidden, **extra))
                    deadline = time.monotonic() + 4
                    while time.monotonic() < deadline and len(list(path.glob("*.json"))) < len(cases):
                        time.sleep(0.01)
                    captures = [json.loads(file.read_text()) for file in path.glob("*.json")]
                    self.assertEqual(len(captures), len(cases), "one packet per valid callback")
                    self.assertEqual(len(threads), 1, "one owned worker, not per-event threads")
                finally:
                    close = getattr(ctx, "close", None)
                    if close is not None:
                        close()
                    for worker in threads:
                        worker.join(timeout=2)
                        self.assertFalse(worker.is_alive())
                    for process in processes:
                        if process.poll() is None:
                            process.kill()
                        process.wait(timeout=2)
                        if process.stdin is not None and not process.stdin.closed:
                            process.stdin.close()
            captures.sort(key=lambda item: item["args"][-1])
            expected = []
            for _, _, event in sorted(cases, key=lambda item: item[2]):
                packet = {"hook_event_name": event, "coucou_agent": "hermes", "session_id": "ses1", "tool_name": "bash"}
                expected.append({"args": ["--agent", "hermes", event], "input": json.dumps(packet) + "\n"})
            self.assertEqual(captures, expected)
            self.assertIs(inputs["args"], forbidden)
            self.assertEqual(inputs["user_message"], [forbidden])
            self.assertEqual(dict.items(forbidden).__iter__().__next__(), ("private", "PRIVATE_CONTENT"))

    def test_invalid_identity_never_enters_a_transport_queue(self):
        queued = []

        class Sender:
            def enqueue(self, value):
                queued.append(value)
                raise AssertionError("Invalid metadata was queued")

        metadata = Metadata()
        self.assertIsNone(adapter._forward(Sender(), "SessionStart", metadata=metadata))
        self.assertEqual(queued, [])
        self.assertEqual(metadata.accesses, ["session_id", "child_session_id", "parent_session_id"])

    def test_registered_callbacks_contain_malformed_metadata_and_dispatch_without_policy_or_logs(self):
        class BadString(str):
            def encode(self, *_args, **_kwargs):
                raise ValueError("PRIVATE_NORMALIZATION_ERROR")

        class BadBool:
            def __bool__(self):
                raise ValueError("PRIVATE_FLAG_ERROR")

        class BadEquality:
            def __eq__(self, _other):
                raise ValueError("PRIVATE_STATUS_ERROR")

        class BadEqualityResult:
            def __eq__(self, _other):
                return BadBool()

        class Context:
            def __init__(self):
                self.hooks = {}

            def register_hook(self, name, callback):
                self.hooks[name] = callback

            def on_unload(self, callback):
                self.close = callback

        with tempfile.TemporaryDirectory(prefix="coucou-hermes-containment-", dir="/tmp/opencode") as directory:
            path = Path(directory)
            executable = path / "capture"
            executable.write_text(f"#!{sys.executable} -B\n" + f"""import json, os, signal, sys
from pathlib import Path
signal.alarm(6)
Path({directory!r}, str(os.getpid()) + '.json').write_text(sys.stdin.read())
""")
            executable.chmod(0o700)
            ctx = Context()
            excluded = ForbiddenValue(private="PRIVATE_CONTENT")
            inputs = {"session_id": "ses1", "cwd": "/repo", "tool_name": "bash",
                "user_message": excluded, "assistant_response": excluded, "args": excluded,
                "tool_result": excluded, "error_message": excluded}
            output = io.StringIO()
            with patch.dict(os.environ, {"COUCOU_HOOK": str(executable)}), \
                    redirect_stdout(output), redirect_stderr(output), \
                    patch.object(logging.Logger, "_log") as log, patch("builtins.print") as printing:
                self.assertIsNone(adapter.register(ctx))
                try:
                    cases = [(hook, {key: BadString(value)}) for hook in ctx.hooks
                        for key, value in (("session_id", "ses1"), ("cwd", "/repo"), ("tool_name", "bash"))]
                    cases.extend([
                        ("on_session_end", {"failed": BadBool()}),
                        ("on_session_end", {"interrupted": BadBool()}),
                        ("post_tool_call", {"status": BadEquality()}),
                        ("post_tool_call", {"status": BadEqualityResult()}),
                    ])
                    for hook, extra in cases:
                        with self.subTest(hook=hook, field=next(iter(extra))):
                            values = {**inputs, **extra}
                            original = dict(values)
                            try:
                                result = ctx.hooks[hook](**values)
                            except Exception as error:
                                self.fail(f"Passive observer leaked {type(error).__name__}")
                            self.assertIsNone(result)
                            self.assertEqual(set(values), set(original))
                            for key, value in original.items():
                                self.assertIs(values[key], value)
                    with patch.object(adapter.Relay, "enqueue", side_effect=ValueError("PRIVATE_DISPATCH_ERROR")):
                        for hook in ctx.hooks:
                            with self.subTest(dispatch=hook):
                                try:
                                    result = ctx.hooks[hook](**inputs)
                                except Exception as error:
                                    self.fail(f"Passive dispatch leaked {type(error).__name__}")
                                self.assertIsNone(result)
                    self.assertEqual(list(path.glob("*.json")), [])
                    # Later valid callbacks still emit the unchanged minimal baseline.
                    self.assertIsNone(ctx.hooks["on_session_start"](**inputs))
                    self.assertIsNone(ctx.hooks["on_session_end"](**inputs, completed=BadBool()))
                    deadline = time.monotonic() + 4
                    while time.monotonic() < deadline and len(list(path.glob("*.json"))) < 2:
                        time.sleep(0.01)
                    captures = [json.loads(file.read_text()) for file in path.glob("*.json")]
                    captures.sort(key=lambda value: value["hook_event_name"])
                    self.assertEqual(captures, [
                        {"hook_event_name": event, "coucou_agent": "hermes", "session_id": "ses1", "tool_name": "bash"}
                        for event in ("SessionStart", "Stop")
                    ])
                    log.assert_not_called()
                    printing.assert_not_called()
                    self.assertEqual(output.getvalue(), "")
                    self.assertEqual(dict.items(excluded).__iter__().__next__(), ("private", "PRIVATE_CONTENT"))
                finally:
                    ctx.close()

    def test_unload_terminates_owned_worker_and_old_callbacks_stay_silent(self):
        class Context:
            def __init__(self):
                self.hooks = {}

            def register_hook(self, name, callback):
                self.hooks[name] = callback

            def on_unload(self, callback):
                self.close = callback

        with tempfile.TemporaryDirectory(prefix="coucou-hermes-unload-", dir="/tmp/opencode") as directory:
            path = Path(directory)
            executable = path / "held relay"
            executable.write_text(f"""#!{sys.executable} -B
import os, time
with open({str(path / 'starts')!r}, 'a') as file: file.write(str(os.getpid()) + '\\n')
time.sleep(4)
""")
            executable.chmod(0o700)
            ctx = Context()
            logs = io.StringIO()
            pid = None
            processes = []
            popen = subprocess.Popen

            def capture_process(*args, **kwargs):
                process = popen(*args, **kwargs)
                processes.append(process)
                return process

            with patch.dict(os.environ, {"COUCOU_HOOK": str(executable)}), redirect_stdout(logs), redirect_stderr(logs), \
                    patch.object(subprocess, "Popen", side_effect=capture_process):
                adapter.register(ctx)
                try:
                    began = time.monotonic()
                    self.assertIsNone(ctx.hooks["on_session_start"](session_id="ses1"))
                    self.assertLess(time.monotonic() - began, 0.1)
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline and not (path / "starts").exists():
                        time.sleep(0.01)
                    pid = int((path / "starts").read_text().strip())
                    ctx.hooks["pre_tool_call"](session_id="ses1", args=ForbiddenValue(private="PRIVATE_CONTENT"))
                    ctx.close()
                    ctx.close()
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
                    ctx.hooks["on_session_start"](session_id="late-session")
                    time.sleep(0.05)
                    self.assertEqual((path / "starts").read_text().strip(), str(pid))
                finally:
                    close = getattr(ctx, "close", None)
                    if close is not None:
                        close()
                    if pid is not None:
                        try:
                            os.kill(pid, 9)
                        except ProcessLookupError:
                            pass
                    for process in processes:
                        if process.poll() is None:
                            process.kill()
                        process.wait(timeout=2)
                        if process.stdin is not None and not process.stdin.closed:
                            process.stdin.close()
            self.assertEqual(logs.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
