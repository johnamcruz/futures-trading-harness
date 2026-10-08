"""Training logs: everything a run does, in files next to its outputs.

    <out>/logs/<stage>.log      every line, timestamped and leveled (also printed)
    <out>/logs/<stage>.jsonl    one JSON record per event: progress, attempts,
                                evaluations, trials, errors
    <out>/logs/run.json         the run manifest: config snapshot, git commit,
                                library versions, start, end, status, error

`start(out_dir, stage)` opens a run; `log()` and `event()` write to the open
run (and only print when none is open, e.g. in tests); `finish()` closes it.
Logging never stops training: a write that fails is reported once on stderr.
"""

import contextlib
import contextvars
import datetime as dt
import json
import os
import platform
import subprocess
import sys
import time
import traceback
from pathlib import Path

from . import REPO_ROOT

_run = None
_warned = False
# Tags for the current thread's work (e.g. a sweep trial): added to every line
# and event, and `file` gets a copy of every line (the trial's own log).
_scope = contextvars.ContextVar("fth_runlog_scope", default={})


def _now():
    return dt.datetime.now(dt.timezone.utc)


def _iso(t):
    return t.isoformat(timespec="seconds").replace("+00:00", "Z")


def _clean(v):
    """JSON-safe: paths as strings, NaN/inf as null, numpy scalars as numbers."""
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items() if not str(k).startswith("_") or k in ("_windows",)}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, Path):
        return str(v)
    if hasattr(v, "item") and callable(v.item):
        try:
            v = v.item()
        except (TypeError, ValueError):
            return str(v)
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return str(v)


def _append(path, text):
    global _warned
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(text)
    except OSError as err:
        if not _warned:
            _warned = True
            print(f"[runlog] could not write {path}: {err} (logging continues on stdout only)", file=sys.stderr)


def _write_json(path, obj):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, indent=2))
        os.replace(tmp, path)
    except OSError as err:
        print(f"[runlog] could not write {path}: {err}", file=sys.stderr)


def git_commit():
    try:
        out = subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5)
        sha = out.stdout.strip()
        dirty = subprocess.run(["git", "-C", str(REPO_ROOT), "status", "--porcelain"], capture_output=True, text=True, timeout=5).stdout.strip()
        return f"{sha}{'+dirty' if dirty else ''}" if sha else None
    except (OSError, subprocess.SubprocessError):
        return None


def versions():
    out = {"python": platform.python_version()}
    for mod in ("numpy", "torch", "gymnasium", "stable_baselines3", "sb3_contrib", "optuna"):
        try:
            out[mod] = __import__(mod).__version__
        except Exception:  # noqa: BLE001 - optional, absent, or broken: just not listed
            pass
    return out


class Run:
    def __init__(self, out_dir, stage, config=None, extra=None):
        self.dir = Path(out_dir) / "logs"
        self.stage = stage
        self.text = self.dir / f"{stage}.log"
        self.events = self.dir / f"{stage}.jsonl"
        self.manifest_path = self.dir / ("run.json" if stage in ("train", "pipeline") else f"{stage}.run.json")
        self.started = _now()
        self.t0 = time.time()
        self.manifest = {
            "stage": stage,
            "status": "running",
            "started": _iso(self.started),
            "ended": None,
            "minutes": None,
            "argv": sys.argv,
            "host": platform.node(),
            "pid": os.getpid(),
            "git": git_commit(),
            "versions": versions(),
            "config": _clean(config) if config is not None else None,
            **(_clean(extra) if extra else {}),
        }
        _write_json(self.manifest_path, self.manifest)

    def finish(self, status="done", error=None, **summary):
        self.manifest.update(
            status=status,
            ended=_iso(_now()),
            minutes=round((time.time() - self.t0) / 60, 2),
            **({"error": error} if error else {}),
            **({"summary": _clean(summary)} if summary else {}),
        )
        _write_json(self.manifest_path, self.manifest)


def start(out_dir, stage, config=None, **extra):
    """Open a run: its logs go to <out_dir>/logs/. Returns the Run."""
    global _run
    _run = Run(out_dir, stage, config, extra)
    log(f"run started: logs in {_run.dir} (git {_run.manifest['git'] or 'unknown'})")
    return _run


def current():
    return _run


@contextlib.contextmanager
def scope(file=None, **tags):
    """Within it, lines and events carry `tags` (e.g. trial=3), and lines are
    also written to `file` (e.g. the trial's own log)."""
    token = _scope.set({**_scope.get(), **tags, **({"file": Path(file)} if file else {})})
    try:
        yield
    finally:
        _scope.reset(token)


def log(msg, level="INFO", stage=None):
    """A line on stdout (stderr for errors), in the open run's text log, and in the scope's file."""
    tag = stage or (_run.stage if _run else "train-policy")
    sc = _scope.get()
    tags = "".join(f" {k}={v}" for k, v in sc.items() if k != "file")
    line = f"[{tag}] {_iso(_now())} {level}{tags} {msg}"
    print(line, file=sys.stderr if level == "ERROR" else sys.stdout, flush=True)
    if _run:
        _append(_run.text, line + "\n")
    if sc.get("file"):
        _append(sc["file"], line + "\n")


def event(kind, **data):
    """A structured record in the open run's event log (nothing without a run), with the scope's tags."""
    if _run:
        tags = {k: v for k, v in _scope.get().items() if k != "file"}
        _append(_run.events, json.dumps({"at": _iso(_now()), "kind": kind, **_clean(tags), **_clean(data)}) + "\n")


def failed(err):
    """Log an exception with its traceback and mark the run failed."""
    tb = "".join(traceback.format_exception(type(err), err, err.__traceback__))
    log(f"{type(err).__name__}: {err}", "ERROR")
    if _run:
        _append(_run.text, tb)
        event("error", error=f"{type(err).__name__}: {err}", traceback=tb)
        _run.finish("failed", error=f"{type(err).__name__}: {err}")


def finish(status="done", **summary):
    global _run
    if _run:
        log(f"run {status} in {(time.time() - _run.t0) / 60:.1f} min")
        _run.finish(status, **summary)
    _run = None


def fmt_duration(seconds):
    if seconds is None or seconds != seconds or seconds < 0:
        return "?"
    seconds = int(seconds)
    if seconds < 90:
        return f"{seconds}s"
    if seconds < 5400:
        return f"{seconds / 60:.1f}m"
    return f"{seconds / 3600:.1f}h"
