"""Failure cases found in the pre-integration reliability audit; synthetic only."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from bekzat_language import analyze
from bekzat_language.cli import main, read_bounded
from bekzat_language.contracts import record_errors, strict_json, validate_glossary
from bekzat_language.provider import call_provider, validate_config
from bekzat_language.storage import Cache, write_json

EMPTY = {"status": "agreed", "entries": []}


def record(**kw):
    return {"key": "synthetic", "locale": "kk", "source": "Продолжить", "target": "Continue",
            "occurrence": 1, "source_hash": "a" * 64, **kw}


class StabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cache = self.root / "cache"
        self.config = {"command": [sys.executable, "unused.py"], "provider_id": "test",
            "model_id": "test", "revision": "test-v1", "max_output_tokens": 1000,
            "input_usd_per_million": 1.0, "output_usd_per_million": 2.0, "timeout_seconds": 5}

    def adapter(self, code):
        path = self.root / "adapter.py"
        path.write_text(code, encoding="utf-8")
        self.config["command"] = [sys.executable, str(path)]

    def break_cache(self):
        self.cache.mkdir()
        (self.cache / "cache.sqlite3").write_bytes(b"synthetic corrupt database")

    def test_bad_record_does_not_abort_valid_records(self):
        for bad in (record(target="\ud800"), record(metadata={"bad": float("nan")}),
                    record(metadata={"bad": {1, 2}})):
            with self.subTest(bad=type(bad.get("metadata"))):
                result = analyze([bad, record()], EMPTY, cache_dir=self.cache)
                self.assertEqual(result["metrics"]["valid_records"], 1)
                self.assertEqual(result["metrics"]["quarantined_records"], 1)
                self.assertIsNone(result["metrics"]["records_hash"])
                self.assertEqual(result["metrics"]["status"], "partial")
                self.assertEqual(len(result["findings"]), 1)
                json.dumps(result, allow_nan=False).encode("utf-8")

    def test_cyclic_metadata_is_quarantined(self):
        metadata = {}
        metadata["cycle"] = metadata
        result = analyze([record(metadata=metadata), record()], EMPTY, cache_dir=self.cache)
        self.assertEqual(result["metrics"]["quarantined_records"], 1)

    def test_oversized_record_is_quarantined(self):
        result = analyze([record(target="x" * 262_145), record()], EMPTY, cache_dir=self.cache)
        self.assertIn("record_too_large", result["diagnostics"][0]["codes"])
        self.assertEqual(result["metrics"]["valid_records"], 1)

    def test_input_read_is_bounded(self):
        path = self.root / "large.json"
        path.write_bytes(b"a" * 101)
        with self.assertRaisesRegex(ValueError, "size limit"):
            read_bounded(path, 100)

    def test_too_many_records_rejected_before_cache(self):
        with self.assertRaisesRegex(ValueError, "50000"):
            analyze([record()] * 50_001, EMPTY, cache_dir=self.cache)
        self.assertFalse(self.cache.exists())

    def test_nested_json_returns_controlled_error(self):
        with self.assertRaises(ValueError):
            strict_json("[" * 5000 + "0" + "]" * 5000)

    def test_corrupt_database_degrades_local_and_releases_handle(self):
        self.break_cache()
        original = (self.cache / "cache.sqlite3").read_bytes()
        result = analyze([record()], EMPTY, cache_dir=self.cache)
        self.assertEqual(len(result["findings"]), 1)
        self.assertEqual(result["metrics"]["status"], "partial")
        self.assertFalse(result["metrics"]["persistent_cache_available"])
        self.assertIn("cache_unavailable", result["diagnostics"][-1]["codes"])
        self.assertFalse((self.cache / "cache.lock").exists())
        self.assertEqual((self.cache / "cache.sqlite3").read_bytes(), original)
        # Windows denies this rename if the SQLite handle leaked during __enter__.
        (self.cache / "cache.sqlite3").rename(self.cache / "preserved-corrupt.sqlite3")

    def test_unavailable_cache_blocks_new_model_charges(self):
        self.break_cache()
        with patch("bekzat_language.engine.call_provider") as call:
            result = analyze([record()], EMPTY, cache_dir=self.cache, provider=self.config,
                             max_requests=1, max_tokens=100_000, max_cost_usd=1)
        call.assert_not_called()
        self.assertEqual(result["events"][0]["model_status"], "cache_unavailable")
        self.assertEqual(result["metrics"]["provider_requests"], 0)

    def test_failed_sqlite_write_degrades_instead_of_aborting(self):
        with Cache(self.cache) as cache:
            cache.db.execute("PRAGMA query_only=ON")
            cache.put("key", [])
            self.assertFalse(cache.available)
            self.assertIsNone(cache.get("key"))
        self.assertFalse((self.cache / "cache.lock").exists())

    def test_cli_corrupt_cache_writes_partial_report(self):
        self.break_cache()
        inp, glossary = self.root / "records.json", self.root / "glossary.json"
        inp.write_text(json.dumps([record()]), encoding="utf-8")
        glossary.write_text(json.dumps(EMPTY), encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            code = main(["--input", str(inp), "--glossary", str(glossary),
                         "--cache", str(self.cache), "--out", str(self.root / "out")])
        self.assertEqual(code, 2)
        self.assertTrue((self.root / "out/report.json").exists())

    def test_response_limit_checked_while_producer_runs(self):
        self.config["max_response_bytes"] = 512
        self.adapter("import os,time\nos.write(1,b'x'*4096)\ntime.sleep(10)\n")
        start = time.monotonic()
        with self.assertRaisesRegex(ValueError, "provider_response_too_large"):
            call_provider(self.config, {})
        self.assertLess(time.monotonic() - start, 4)
        self.assertFalse(any(t.name == "bekzat-provider-output" for t in threading.enumerate()))

    def test_stderr_is_discarded_without_deadlock(self):
        self.adapter("import os\nos.write(2,b'x'*4000000)\nos.write(1,b'{}')\n")
        self.assertEqual(call_provider(self.config, {}), {})

    def test_timeout_kills_adapter_and_releases_output_reader(self):
        self.config["timeout_seconds"] = 0.15
        self.adapter("import time\ntime.sleep(10)\n")
        start = time.monotonic()
        with self.assertRaisesRegex(ValueError, "provider_timeout"):
            call_provider(self.config, {})
        self.assertLess(time.monotonic() - start, 4)
        self.assertFalse(any(t.name == "bekzat-provider-output" for t in threading.enumerate()))

    def test_adapter_not_reading_stdin_still_times_out(self):
        self.config["timeout_seconds"] = 0.15
        self.adapter("import time\ntime.sleep(10)\n")
        with self.assertRaisesRegex(ValueError, "provider_timeout"):
            call_provider(self.config, {"large": "x" * 500_000})

    def test_oversize_request_never_launches_adapter(self):
        with patch("bekzat_language.provider.subprocess.Popen") as launch:
            with self.assertRaisesRegex(ValueError, "request_too_large"):
                call_provider(self.config, {"large": "x" * 2_000_001})
        launch.assert_not_called()

    def test_nonzero_provider_does_not_leak_stderr(self):
        self.adapter("import sys\nsys.stderr.write('synthetic-secret')\nsys.exit(3)\n")
        with self.assertRaises(ValueError) as caught:
            call_provider(self.config, {})
        self.assertNotIn("synthetic-secret", str(caught.exception))

    def test_bad_provider_numeric_config_and_glossary_types(self):
        for field, value in (("timeout_seconds", 10**400), ("max_response_bytes", True),
                             ("input_usd_per_million", float("inf")), ("parameters", [])):
            config = copy.deepcopy(self.config)
            config[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_config(config)
        with self.assertRaises(ValueError):
            validate_glossary({"status": [], "entries": []})

    def test_model_unicode_error_is_rejected_without_poisoning_cache(self):
        response = {"issues": [{"issue_type": "wrong_language", "severity": "high", "target_span": "Continue",
            "evidence": "\ud800", "suggestion": "Жалғастыру", "confidence": .9}],
            "usage": {"input_tokens": 10, "output_tokens": 10}}
        with patch("bekzat_language.engine.call_provider", return_value=response):
            result = analyze([record()], EMPTY, cache_dir=self.cache, provider=self.config,
                max_requests=1, max_tokens=100_000, max_cost_usd=1)
        self.assertEqual(result["metrics"]["provider_failures"], 1)
        self.assertEqual(len(result["findings"]), 1)  # local fallback only
        json.dumps(result, ensure_ascii=False).encode("utf-8")

    def test_failed_atomic_export_preserves_old_file_and_cleans_temp(self):
        path = self.root / "report.json"
        path.write_text("old", encoding="utf-8")
        with self.assertRaises(ValueError):
            write_json(path, {"bad": float("nan")})
        self.assertEqual(path.read_text(encoding="utf-8"), "old")
        self.assertEqual(list(self.root.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
