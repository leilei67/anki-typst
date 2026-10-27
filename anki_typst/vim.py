"""A headless Neovim session, using the user's real mappings and native Anki UI."""

import json
import queue
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .msgpack import Unpacker, packb


def find_neovim(configured=""):
    for name in ([configured] if configured else ["nvim", "/opt/homebrew/bin/nvim", "/usr/local/bin/nvim"]):
        executable = shutil.which(name)
        if executable:
            return executable
    raise RuntimeError("Neovim was not found. Set nvim_path in the add-on configuration, or disable vim_enabled.")


def cursor_offset(source, position):
    """Convert Neovim's UTF-8 byte column to a browser UTF-16 text offset."""
    row, column = position
    lines = source.split("\n")
    row = max(1, min(row, len(lines)))
    prefix = "\n".join(lines[:row - 1])
    if row > 1:
        prefix += "\n"
    prefix += lines[row - 1].encode("utf-8")[:column].decode("utf-8", errors="ignore")
    return len(prefix.encode("utf-16-le")) // 2


class Neovim:
    def __init__(self, config, on_update, streaming=False):
        executable = find_neovim(config.get("nvim_path", ""))
        command = [executable, "--embed", "--headless", "-n", "-i", "NONE"]
        vimrc = config.get("vimrc_path", "")
        if vimrc:
            path = Path(vimrc).expanduser()
            if not path.is_file():
                raise RuntimeError(f"Vim config was not found: {path}")
            command.extend(["-u", str(path)])
        script = Path(__file__).with_suffix(".lua")
        command.extend(["-c", "lua dofile(" + json.dumps(str(script)) + ")"])
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.responses = queue.Queue()
        self.close_lock = threading.Lock()
        self.closing = threading.Event()
        self.on_update = on_update
        self.streaming = streaming
        self.serial = 0
        self.write_lock = threading.Lock()
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            unpacker = Unpacker(raw=False)
            while chunk := self.process.stdout.read1(65536):
                unpacker.feed(chunk)
                for message in unpacker:
                    if len(message) != 3 or message[:2] != [2, "anki-typst-state"]:
                        continue
                    result = message[2][0]
                    if "error" in result:
                        if self.streaming:
                            self.on_update(result)
                        else:
                            self.responses.put(result)
                        continue
                    result["offset"] = cursor_offset(result["source"], result["cursor"])
                    result["anchor"] = cursor_offset(result["source"], result["visual"])
                    if result["id"] == 0 or self.streaming:
                        self.on_update(result)
                    else:
                        self.responses.put(result)
        finally:
            error = {"error": "Neovim stopped. Reopen the formula to start a new session."}
            if self.streaming and not self.closing.is_set():
                self.on_update(error)
            self.responses.put(error)

    def write(self, **payload):
        with self.write_lock:
            self.serial += 1
            payload["id"] = self.serial
            # nvim_input is a fast RPC: it must reach Neovim even while it waits
            # for another key in a mapping. Slow Lua/stdio callbacks cannot do that.
            keys = payload.pop("keys", "")
            if keys:
                self.process.stdin.write(packb([2, "nvim_input", [keys]], use_bin_type=True))
            self.process.stdin.write(packb(
                [2, "nvim_exec_lua", ["anki_typst_request(...)", [payload]]], use_bin_type=True,
            ))
            self.process.stdin.flush()
            return self.serial

    def send(self, **payload):
        try:
            serial = self.write(**payload)
            while True:
                result = self.responses.get(timeout=5)
                if "error" in result:
                    raise RuntimeError(result["error"])
                if result["id"] == serial:
                    return result
        except (BrokenPipeError, OSError, queue.Empty) as error:
            raise RuntimeError("Neovim did not respond. Reopen the formula to retry.") from error

    def close(self):
        self.closing.set()
        with self.close_lock:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            self.thread.join(timeout=1)
            for stream in (self.process.stdin, self.process.stdout):
                stream.close()


class VimBridge:
    def __init__(self):
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="anki-typst-vim")
        self.engine = None
        self.session = None
        self.closed = threading.Event()

    def dispatch(self, request, config, deliver):
        def task():
            if self.closed.is_set():
                return None
            session = request["session"]
            if request["action"] == "start":
                if self.engine:
                    self.engine.close()
                self.session = session
                self.engine = Neovim(config, lambda state: deliver(session, state), streaming=True)
                if self.closed.is_set():
                    self.engine.close()
                    return None
                self.engine.write(source=request["source"], cursor=request["cursor"])
                return None
            if session != self.session or self.engine is None:
                return {"error": "Vim session expired. Reopen the formula."}
            if request["action"] == "stop":
                self.engine.close()
                self.engine = None
                return None
            self.engine.write(keys=request.get("keys", ""), **(
                {key: request[key] for key in ("cursor", "paste") if key in request}
            ))
            return None

        def done(future):
            if future.cancelled():
                return
            try:
                result = future.result()
            except Exception as error:
                result = {"error": str(error)}
            if result is not None:
                deliver(request["session"], result)

        self.executor.submit(task).add_done_callback(done)

    def close(self):
        self.closed.set()
        self.executor.shutdown(wait=False, cancel_futures=True)
        if self.engine:
            self.engine.close()
