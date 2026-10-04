"""One registration-owned worker delivers detached minimized packets in FIFO order."""

import json
import os
import subprocess
import threading
import time
from collections import deque


class Relay:
    def __init__(self, command: str, agent: str):
        self._command = command
        self._agent = agent
        self._pending = deque()
        self._condition = threading.Condition()
        self._worker = None
        self._process = None
        self._closed = False
        self._generation = 0

    def enqueue(self, payload) -> bool:
        with self._condition:
            if self._closed or len(self._pending) >= 17:
                return False
        try:
            event = payload["hook_event_name"]
            if not isinstance(event, str):
                return False
            data = (json.dumps(payload) + "\n").encode("utf-8")
            if len(data) > 65536:
                return False
            with self._condition:
                if self._closed or len(self._pending) >= 17:
                    return False
                self._pending.append((event, data))
                if self._worker is None:
                    try:
                        self._worker = threading.Thread(target=self._run, daemon=True)
                        self._worker.start()
                    except Exception:
                        self._worker = None
                        self._pending.clear()
                        return False
                self._condition.notify()
            return True
        except Exception:
            return False

    @staticmethod
    def _kill(process):
        try:
            process.kill()
        except OSError:
            pass

    def _run(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or self._pending)
                if self._closed:
                    return
                event, data = self._pending.popleft()
                generation = self._generation
                deadline = time.monotonic() + 2
                try:
                    process = subprocess.Popen(
                        [self._command, "--agent", self._agent, event],
                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, bufsize=0, shell=False,
                    )
                except Exception:
                    del event, data
                    continue
                self._process = process
            try:
                # Nonblocking writes keep the deadline effective even when stdin is never read.
                os.set_blocking(process.stdin.fileno(), False)
                offset = 0
                while offset < len(data):
                    if time.monotonic() >= deadline or generation != self._generation:
                        raise TimeoutError
                    try:
                        offset += os.write(process.stdin.fileno(), data[offset:])
                    except BlockingIOError:
                        time.sleep(0.01)
                process.stdin.close()
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except Exception:
                self._kill(process)
            finally:
                process.stdin.close()
                process.wait()
                with self._condition:
                    if self._process is process:
                        self._process = None
                del process, event, data

    def close(self):
        with self._condition:
            if not self._closed:
                self._closed = True
                self._generation += 1
            self._pending.clear()
            process, worker = self._process, self._worker
            self._condition.notify_all()
        if process is not None:
            self._kill(process)
        if worker is not None:
            worker.join()
        with self._condition:
            self._worker = None
            self._process = None
