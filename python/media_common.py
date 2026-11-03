"""Shared helpers for the audio Python scripts (Reels Engine, audio module).

- Machine output (one JSON object) goes to stdout; logs go to stderr as JSON lines.
- Model files are downloaded once into models/ (gitignored) with a lock, bounded
  retries, per-request timeouts, a .part file + atomic rename, and an optional sha256 pin.
- No secrets are read or needed here.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.environ.get("MODELS_DIR", PROJECT_ROOT / "models"))

MAX_ATTEMPTS = 3
CONNECT_TIMEOUT_S = 30
DOWNLOAD_DEADLINE_S = 15 * 60


def log(level: str, msg: str, **fields: Any) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "msg": msg,
        "stage": "media.py",
        **fields,
    }
    sys.stderr.write(json.dumps(entry, default=str) + "\n")
    sys.stderr.flush()


def emit(result: dict[str, Any]) -> None:
    """Write the single machine-readable result to stdout."""
    sys.stdout.write(json.dumps(result, default=str) + "\n")
    sys.stdout.flush()


def fail(msg: str, code: int = 1, **fields: Any) -> None:
    log("error", msg, **fields)
    emit({"ok": False, "error": msg, **fields})
    sys.exit(code)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@contextlib.contextmanager
def file_lock(lock_path: Path, timeout_s: float = DOWNLOAD_DEADLINE_S) -> Iterator[None]:
    """Cross-process exclusive lock (bounded wait)."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as fh:
        start = time.monotonic()
        while True:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() - start > timeout_s:
                    raise TimeoutError(f"timed out waiting for lock {lock_path.name}")
                time.sleep(0.5)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _download_once(url: str, dest: Path, deadline: float) -> None:
    part = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "reels-engine-media/1"})
    with urllib.request.urlopen(req, timeout=CONNECT_TIMEOUT_S) as resp, part.open("wb") as out:
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError("download deadline exceeded")
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    os.replace(part, dest)


def ensure_file(url: str, dest: Path, sha256: str | None = None) -> Path:
    """Download `url` to `dest` once (cached). Bounded retries with backoff; verifies sha256 if pinned."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    with file_lock(dest.with_name(dest.name + ".lock")):
        if dest.exists() and dest.stat().st_size > 0:
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + DOWNLOAD_DEADLINE_S
        last: Exception | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                log("info", "downloading model file", file=dest.name, attempt=attempt)
                _download_once(url, dest, deadline)
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as err:
                last = err
                code = getattr(err, "code", None)
                if isinstance(code, int) and 400 <= code < 500 and code != 429:
                    break  # permanent
                if attempt < MAX_ATTEMPTS and time.monotonic() < deadline:
                    time.sleep(min(8.0, 1.0 * 2 ** (attempt - 1)))
        if not dest.exists():
            raise RuntimeError(f"download failed for {dest.name}: {last}")
        if sha256:
            got = sha256_file(dest)
            if got != sha256:
                bad = dest.with_name(dest.name + ".bad")
                os.replace(dest, bad)
                raise RuntimeError(f"sha256 mismatch for {dest.name}")
        return dest
