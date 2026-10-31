import copy
from pathlib import Path
import tempfile
import unittest
from bekzat_language import analyze
from bekzat_language.proposals import text_hash
from bekzat_language.review_queue import build_review_queue


class ReviewQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.rows = [{'key': 'duplicate', 'locale': 'kk', 'source': 'Продолжить', 'target': 'Continue',
                      'source_hash': text_hash('Продолжить'), 'occurrence': n} for n in (1, 2)]
        self.result = self.run_engine(self.rows)

    def run_engine(self, records):
        return analyze(records, {'status': 'draft', 'entries': []}, cache_dir=Path(self.tmp.name))

    def test_occurrences_share_text_but_never_review_identity(self):
        queue = build_review_queue(self.rows, self.result)
        self.assertEqual(len({r['review_id'] for r in queue['rows']}), 2)
        self.assertEqual([r['occurrence'] for r in queue['rows']], [1, 2])
        for row in queue['rows']:
            self.assertFalse(row['reviewed_by_human'])
            self.assertEqual(row['status'], 'pending_human_review')
            self.assertEqual(row['source_hash'], text_hash(row['source']))
            self.assertEqual(row['target_hash'], text_hash(row['target']))

    def test_stale_text_context_and_provenance_are_rejected(self):
        for field, value in [('source', 'Изменено'), ('target', 'Changed'), ('description', 'new context')]:
            changed = copy.deepcopy(self.rows)
            changed[0][field] = value
            with self.assertRaises(ValueError):
                build_review_queue(changed, self.result)
        bad = copy.deepcopy(self.result)
        bad['finding_index'].pop()
        with self.assertRaises(ValueError):
            build_review_queue(self.rows, bad)

    def test_new_text_and_suggestion_create_new_unreviewed_identity(self):
        old = build_review_queue(self.rows, self.result)
        changed = copy.deepcopy(self.rows)
        changed[0]['target'] = 'Continue!'
        current = build_review_queue(changed, self.run_engine(changed))
        self.assertNotEqual(old['rows'][0]['review_id'], current['rows'][0]['review_id'])
        modified_result = copy.deepcopy(self.result)
        modified_result['findings'][0]['suggestion'] = 'Другая подсказка'
        modified = build_review_queue(self.rows, modified_result)
        self.assertNotEqual(old['rows'][0]['review_id'], modified['rows'][0]['review_id'])
        self.assertFalse(modified['rows'][0]['reviewed_by_human'])

    def test_queue_neither_mutates_inputs_nor_accepts_human_flag(self):
        snapshot = copy.deepcopy((self.rows, self.result))
        build_review_queue(self.rows, self.result)
        self.assertEqual(snapshot, (self.rows, self.result))
        self.result['findings'][0]['reviewed_by_human'] = True
        with self.assertRaises(ValueError):
            build_review_queue(self.rows, self.result)

    def test_actual_source_hash_required_for_handoff(self):
        self.rows[0]['source_hash'] = 'a' * 64
        with self.assertRaisesRegex(ValueError, 'source_hash_mismatch'):
            build_review_queue(self.rows, self.run_engine(self.rows))
