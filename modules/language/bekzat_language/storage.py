"""Private cache, atomic JSON output and single-writer protection."""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from .contracts import canonical, strict_json


def private_path(path):
    path = Path(path).resolve()
    if any((parent / ".git").exists() for parent in (path, *path.parents)):
        raise ValueError("runtime data/cache/output must be outside every Git checkout")
    return path


def write_json(path, value):
    path = Path(path)
    # Unique temp avoids collisions; failed serialization cannot truncate old output.
    fd, filename = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temp = Path(filename)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(value, f, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


class Cache:
    def __init__(self, directory):
        self.directory = private_path(directory)
        self.db = None
        self.error_code = None

    @property
    def available(self):
        return self.db is not None

    def _unavailable(self):
        if self.db is not None:
            self.db.close()
        self.db = None
        self.error_code = "cache_unavailable"

    def __enter__(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = self.directory / "cache.lock"
        try:
            fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise ValueError("cache locked: another run active, or stale cache.lock after crash") from None
        try:
            with os.fdopen(fd, "w", encoding="ascii") as f:
                f.write(str(os.getpid()))
            self.db = sqlite3.connect(self.directory / "cache.sqlite3")
            self.db.execute("CREATE TABLE IF NOT EXISTS results (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        except sqlite3.Error:
            # Keep the corrupt database untouched for inspection; local work can continue.
            self._unavailable()
        except Exception:
            if self.db is not None:
                self.db.close()
            self.lock.unlink()
            raise
        return self

    def get(self, key):
        if not self.available:
            return None
        try:
            row = self.db.execute("SELECT value FROM results WHERE key = ?", (key,)).fetchone()
        except sqlite3.Error:
            self._unavailable()
            return None
        if row is None:
            return None
        try:
            return strict_json(row[0])
        except (ValueError, TypeError, UnicodeError):
            self.delete(key)
            return None

    def put(self, key, value):
        if self.available:
            try:
                self.db.execute("INSERT OR REPLACE INTO results VALUES (?, ?)", (key, canonical(value)))
                self.db.commit()
            except sqlite3.Error:
                self._unavailable()

    def delete(self, key):
        if self.available:
            try:
                self.db.execute("DELETE FROM results WHERE key = ?", (key,))
                self.db.commit()
            except sqlite3.Error:
                self._unavailable()

    def __exit__(self, *args):
        try:
            if self.db is not None:
                self.db.close()
        finally:
            self.lock.unlink(missing_ok=True)
