"""Bounded sender checks use only test-owned executables and capture files."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
Relay = None
try:
    spec = importlib.util.spec_from_file_location("hermes_relay", ROOT / "integrations/hermes/coucou/relay.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    Relay = module.Relay
except FileNotFoundError:
    pass


def packet(event, identity="session / #?= ; $() 👩‍💻"):
    return {"hook_event_name": event, "coucou_agent": "hermes", "session_id": identity}


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Relay, "bounded sender is not implemented")
        self.temporary = tempfile.TemporaryDirectory(prefix="coucou-python-relay-", dir="/tmp/opencode")
        self.path = Path(self.temporary.name)
        self.executable = self.path / "relay with spaces ; $(not-a-command)"
        self.executable.write_text(f"""#!{sys.executable} -B
import json, os, signal, sys, time
from pathlib import Path
signal.alarm(6)
path = Path({str(self.path)!r})
event = sys.argv[-1]
try:
    (path / 'lock').mkdir()
except FileExistsError:
    with (path / 'overlap').open('a') as file: file.write('overlap\\n')
with (path / 'starts').open('a') as file:
    file.write(json.dumps({{'pid': os.getpid(), 'args': sys.argv[1:]}}) + '\\n')
if event in ('stalled', 'close-active'):
    import signal
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(30)
elif event == 'broken-pipe':
    os.close(0)
else:
    data = {{'args': sys.argv[1:], 'input': sys.stdin.read()}}
    if event == 'held':
        while not (path / 'release').exists(): time.sleep(0.01)
    with (path / 'packets').open('a') as file: file.write(json.dumps(data) + '\\n')
try: (path / 'lock').rmdir()
except FileNotFoundError: pass
""")
        self.executable.chmod(0o700)
        self.sender = Relay(str(self.executable), "hermes")

    def tearDown(self):
        try:
            self.sender.close()
            for start in self.lines("starts"):
                with self.assertRaises(ProcessLookupError, msg="fixture child must be reaped"):
                    os.kill(start["pid"], 0)
        finally:
            self.temporary.cleanup()

    def lines(self, name):
        try:
            return [json.loads(line) for line in (self.path / name).read_text().splitlines()]
        except FileNotFoundError:
            return []

    def until(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("timed out waiting for test-owned relay")

    def test_one_child_and_17_pending_fifo_packets_bound_bursts(self):
        self.assertTrue(self.sender.enqueue(packet("held")))
        self.until(lambda: len(self.lines("starts")) == 1)
        expected = [packet("held")]
        events = ["SessionStart", "PreToolUse", "PostToolUseFailure", "StopFailure", "SessionEnd"]
        for index in range(17):
            value = packet(events[index % len(events)], f"session {index}")
            expected.append(dict(value))
            self.assertTrue(self.sender.enqueue(value))
            value["session_id"] = "MUTATED_AFTER_ENQUEUE"
        for index in range(100):
            self.assertFalse(self.sender.enqueue(packet("Stop", f"overflow {index}")))
        time.sleep(0.05)
        self.assertEqual(len(self.lines("starts")), 1)
        (self.path / "release").touch()
        self.until(lambda: len(self.lines("packets")) == 18)
        captures = self.lines("packets")
        self.assertEqual([json.loads(value["input"]) for value in captures], expected)
        self.assertEqual(captures[0]["args"], ["--agent", "hermes", "held"])
        self.assertFalse((self.path / "overlap").exists())

    def test_non_reading_stdin_deadline_reaps_before_next_child(self):
        began = time.monotonic()
        self.assertTrue(self.sender.enqueue({**packet("stalled"), "padding": "x" * 60000}))
        self.until(lambda: len(self.lines("starts")) == 1)
        self.assertTrue(self.sender.enqueue(packet("SessionEnd")))
        self.until(lambda: len(self.lines("packets")) == 1, timeout=3.5)
        starts = self.lines("starts")
        self.assertEqual(len(starts), 2)
        with self.assertRaises(ProcessLookupError):
            os.kill(starts[0]["pid"], 0)
        self.assertGreaterEqual(time.monotonic() - began, 1.8)
        self.assertLess(time.monotonic() - began, 3.5)

    def test_close_reaps_clears_queue_and_rejects_future_events(self):
        self.sender.enqueue({**packet("close-active"), "padding": "x" * 60000})
        self.until(lambda: len(self.lines("starts")) == 1)
        self.sender.enqueue(packet("SessionEnd"))
        self.sender.close()
        self.sender.close()
        self.assertFalse(self.sender.enqueue(packet("SessionStart")))
        time.sleep(0.05)
        starts = self.lines("starts")
        self.assertEqual(len(starts), 1)
        with self.assertRaises(ProcessLookupError):
            os.kill(starts[0]["pid"], 0)
        self.assertEqual(self.lines("packets"), [])

    def test_closed_sender_rejects_without_touching_future_payloads(self):
        reads = []

        class Payload(dict):
            def __getitem__(self, key):
                reads.append(key)
                return super().__getitem__(key)

        self.sender.close()
        self.assertFalse(self.sender.enqueue(Payload(packet("SessionStart"))))
        self.assertEqual(reads, [])

    def test_worker_start_failure_is_silent_and_does_not_wedge_future_delivery(self):
        with patch.object(module.threading.Thread, "start", side_effect=RuntimeError("PRIVATE_THREAD_ERROR")):
            self.assertFalse(self.sender.enqueue(packet("SessionStart")))
        self.assertTrue(self.sender.enqueue(packet("SessionEnd")))
        self.until(lambda: len(self.lines("packets")) == 1)
        self.assertEqual(json.loads(self.lines("packets")[0]["input"]), packet("SessionEnd"))

    def test_stdin_64kib_limit_and_metacharacters_are_literal(self):
        value = {**packet("event ; $(not-a-command)"), "padding": ""}
        value["padding"] = "x" * (65536 - len((json.dumps(value) + "\n").encode()))
        self.assertTrue(self.sender.enqueue(value))
        self.assertFalse(self.sender.enqueue({**value, "padding": value["padding"] + "x"}))
        self.until(lambda: len(self.lines("packets")) == 1)
        capture = self.lines("packets")[0]
        self.assertEqual(len(capture["input"].encode()), 65536)
        self.assertEqual(capture["args"], ["--agent", "hermes", "event ; $(not-a-command)"])
        self.assertEqual(json.loads(capture["input"])["session_id"], value["session_id"])

    def test_epipe_and_enoent_do_not_wedge_delivery(self):
        self.sender.enqueue({**packet("broken-pipe"), "padding": "x" * 60000})
        self.sender.enqueue(packet("SessionEnd"))
        self.until(lambda: len(self.lines("packets")) == 1)
        missing = Relay(str(self.path / "missing relay"), "hermes")
        try:
            missing.enqueue(packet("SessionStart"))
            time.sleep(0.05)
            executable = self.path / "missing relay"
            executable.write_bytes(self.executable.read_bytes())
            executable.chmod(0o700)
            missing.enqueue(packet("Stop"))
            self.until(lambda: len(self.lines("packets")) == 2)
        finally:
            missing.close()


if __name__ == "__main__":
    unittest.main()
