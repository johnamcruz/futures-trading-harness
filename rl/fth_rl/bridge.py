"""The Node env server as a Python object: one JSON line per request."""

import json
import os
import shutil
import subprocess

from . import REPO_ROOT

SERVER = REPO_ROOT / "scripts" / "rl-env-server.js"


class EnvServerError(RuntimeError):
    """The env server answered with an error, or exited."""


def node_binary():
    node = os.environ.get("FTH_NODE") or shutil.which("node")
    if not node:
        raise EnvServerError("node not found (install Node 18+ or set FTH_NODE)")
    return node


class EnvServer:
    """A running `node scripts/rl-env-server.js --config <file>`."""

    def __init__(self, config_path, hash_data=False, quiet=False):
        args = [node_binary(), str(SERVER), "--config", str(config_path)]
        if not hash_data:
            args.append("--no-hash")
        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL if quiet else None,
            text=True,
            bufsize=1,
            cwd=str(REPO_ROOT),
        )

    def request(self, obj):
        if self.proc.poll() is not None:
            raise EnvServerError(f"the env server exited (code {self.proc.returncode})")
        try:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()
        except BrokenPipeError as err:
            raise EnvServerError("the env server exited") from err
        line = self.proc.stdout.readline()
        if not line:
            code = self.proc.wait(timeout=5)
            raise EnvServerError(f"the env server exited (code {code}); see its log above")
        msg = json.loads(line)
        if "error" in msg:
            raise EnvServerError(msg["error"])
        return msg

    def info(self):
        return self.request({"cmd": "info"})

    def starts(self, window, every=1):
        return self.request({"cmd": "starts", "from": window[0], "to": window[1], "every": every})["starts"]

    def evaluate(self, starts, end, network=None):
        return self.request({"cmd": "evaluate", "starts": list(starts), "end": end, "network": network})

    def check_bundle(self, bundle):
        return self.request({"cmd": "checkBundle", "bundle": bundle})["errors"]

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write(json.dumps({"cmd": "close"}) + "\n")
                self.proc.stdin.close()
                self.proc.wait(timeout=10)
            except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
                self.proc.kill()
                self.proc.wait()
        for f in (self.proc.stdin, self.proc.stdout):
            try:
                f.close()
            except (BrokenPipeError, OSError):
                pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
