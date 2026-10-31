import copy
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from bekzat_language import analyze
from bekzat_language.contracts import canonical
from bekzat_language.storage import Cache

EMPTY = {'status': 'draft', 'entries': []}


def record(n=0):
    return {'key': f'file.{n}', 'locale': 'kk', 'source': 'Продолжить', 'target': 'Continue',
            'occurrence': 1, 'source_hash': 'a' * 64}


class BatchReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.config = {'command': [sys.executable, 'unused.py'], 'provider_id': 'test',
            'model_id': 'test', 'revision': 'test', 'max_output_tokens': 100,
            'input_usd_per_million': 1, 'output_usd_per_million': 1, 'timeout_seconds': 1}

    def test_local_commits_are_bounded_and_final_remainder_is_durable(self):
        with Cache(self.path) as cache:
            for i in range(65):
                cache.put(str(i), {'n': i}, durable=False)
            with closing(sqlite3.connect(self.path / 'cache.sqlite3')) as observer:
                self.assertEqual(observer.execute('SELECT COUNT(*) FROM results').fetchone()[0], 64)
            self.assertEqual(cache.get('64'), {'n': 64})
        with Cache(self.path) as reopened:
            self.assertEqual(reopened.get('64'), {'n': 64})

    def test_paid_response_default_is_durable_before_context_exit(self):
        with Cache(self.path) as cache:
            cache.put('model', {'usage': 1})
            with closing(sqlite3.connect(self.path / 'cache.sqlite3')) as observer:
                self.assertIsNotNone(observer.execute('SELECT value FROM results WHERE key=?', ('model',)).fetchone())

    def test_controlled_interrupt_flushes_local_work_and_releases_lock(self):
        with self.assertRaises(KeyboardInterrupt):
            with Cache(self.path) as cache:
                cache.put('local', [], durable=False)
                raise KeyboardInterrupt
        with Cache(self.path) as recovered:
            self.assertEqual(recovered.get('local'), [])

    def test_crash_preserves_checkpoint_and_requires_explicit_lock_recovery(self):
        script = self.path / 'crash.py'
        module = str(Path(__file__).resolve().parents[1])
        script.write_text('import sys,os\nsys.path.insert(0,' + repr(module) + ')\n'
            'from bekzat_language.storage import Cache\n'
            'with Cache(sys.argv[1]) as c:\n'
            ' for i in range(70): c.put(str(i),[],durable=False)\n'
            ' os._exit(9)\n', encoding='utf-8')
        cache_path = self.path / 'crash-cache'
        process = subprocess.run([sys.executable, str(script), str(cache_path)], timeout=20, capture_output=True)
        self.assertEqual(process.returncode, 9)
        with closing(sqlite3.connect(cache_path / 'cache.sqlite3')) as observer:
            self.assertEqual(observer.execute('SELECT COUNT(*) FROM results').fetchone()[0], 64)
        with self.assertRaisesRegex(ValueError, 'cache locked'):
            with Cache(cache_path):
                self.fail('stale lock must not be stolen')

    def test_final_commit_failure_returns_partial_status(self):
        original = Cache.flush
        def fail(cache):
            if cache.pending:
                cache._unavailable()
            else:
                original(cache)
        with patch.object(Cache, 'flush', fail):
            result = analyze([record()], EMPTY, cache_dir=self.path)
        self.assertEqual(result['metrics']['status'], 'partial')
        self.assertIn('cache_unavailable', result['diagnostics'][-1]['codes'])
        self.assertEqual(len(result['findings']), 1)

    def test_sequential_files_reuse_cache_and_keep_occurrences_distinct(self):
        rows = [record(i) for i in range(100)]
        first = analyze(rows, EMPTY, cache_dir=self.path)
        second = analyze(rows[50:] + [record(100)], EMPTY, cache_dir=self.path)
        third = analyze(rows, EMPTY, cache_dir=self.path)
        self.assertEqual(second['metrics']['local_cache_hits'], 50)
        self.assertEqual(third['metrics']['local_cache_hits'], 100)
        for key in ('findings', 'finding_index', 'proposals'):
            self.assertEqual(first[key], third[key])
        other = {**rows[0], 'occurrence': 2}
        self.assertEqual(analyze([other], EMPTY, cache_dir=self.path)['metrics']['local_cache_misses'], 1)

    def test_glossary_hash_change_invalidates_local_cache(self):
        analyze([record()], EMPTY, cache_dir=self.path)
        changed = copy.deepcopy(EMPTY)
        changed['status'] = 'agreed'
        self.assertEqual(analyze([record()], changed, cache_dir=self.path)['metrics']['local_cache_hits'], 0)

    def test_provider_reason_is_whitelisted_and_source_is_not_logged(self):
        for error, reason in [(ValueError('provider_timeout'), 'provider_timeout'),
            (ConnectionError('PRIVATE_PAYLOAD'), 'provider_execution_or_protocol_error')]:
            with patch('bekzat_language.engine.call_provider', side_effect=error):
                result = analyze([record()], EMPTY, cache_dir=self.path, provider=self.config,
                                 max_requests=1, max_tokens=100_000, max_cost_usd=1)
            self.assertEqual(result['diagnostics'][0]['reason'], reason)
            self.assertEqual(result['metrics']['status'], 'partial')
            self.assertNotIn('PRIVATE_PAYLOAD', canonical(result['diagnostics'] + result['events']))

    def test_oversize_preflight_does_not_count_or_charge_provider(self):
        from bekzat_language.provider import build_request
        request = build_request(record(), EMPTY, [], self.config)
        request['padding'] = 'x' * 2_000_001
        with patch('bekzat_language.engine.build_request', return_value=request), patch('bekzat_language.engine.call_provider') as call:
            result = analyze([record()], EMPTY, cache_dir=self.path, provider=self.config,
                             max_requests=1, max_tokens=10_000_000, max_cost_usd=10)
        call.assert_not_called()
        self.assertEqual(result['metrics']['provider_requests'], 0)
        self.assertEqual(result['metrics']['cost_usd_total'], 0)
        self.assertEqual(result['metrics']['reserved_tokens'], 0)
        self.assertEqual(result['diagnostics'][0]['codes'], ['provider_request_too_large'])
