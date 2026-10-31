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

    def test_reordering_bundle_keeps_review_ids_and_priority_stable(self):
        rows = [{**r, 'bundle_index': n, 'entry_id': 'duplicate#' + str(r['occurrence'])}
                for n, r in enumerate(self.rows)]
        old = build_review_queue(rows, self.run_engine(rows))
        changed = [{**r, 'bundle_index': n} for n, r in enumerate(reversed(rows))]
        new = build_review_queue(changed, self.run_engine(changed))
        self.assertEqual([r['review_id'] for r in old['rows']], [r['review_id'] for r in new['rows']])
        self.assertEqual(new['version'], 2)

    def test_explanatory_suggestion_is_not_a_whole_text_candidate(self):
        queue = build_review_queue(self.rows, self.result)
        self.assertTrue(all(r['proposed_text'] is None for r in queue['rows']))
        self.assertTrue(all(r['proposal_status'] == 'needs_human_translation' for r in queue['rows']))

    def test_spelling_candidate_is_exported_and_conflicts_stay_separate(self):
        row = {**self.rows[0], 'source': 'Подарок и безопасность',
               'source_hash': text_hash('Подарок и безопасность'), 'target': 'Сыйлык кауіпсіздік'}
        queue = build_review_queue([row], self.run_engine([row]))
        self.assertEqual(len(queue['rows']), 2)
        self.assertTrue(all(r['proposed_text'] for r in queue['rows']))
        self.assertTrue(all(len(r['conflicting_candidate_ids']) == 2 for r in queue['rows']))
        for r in queue['rows']:
            self.assertEqual(r['candidates'][0]['text_hash'], text_hash(r['proposed_text']))
            self.assertFalse(r['candidates'][0]['reviewed_by_human'])

    def test_forged_candidate_or_occurrence_is_rejected(self):
        row = {**self.rows[0], 'target': 'Сыйлык'}
        result = self.run_engine([row])
        result['proposals'][0]['candidate_text'] = 'Подменено'
        with self.assertRaises(ValueError):
            build_review_queue([row], result)

    def test_high_severity_precedes_spelling_suggestion(self):
        rows = [dict(self.rows[0], key='a', target='Сыйлык'), dict(self.rows[1], key='z')]
        queue = build_review_queue(rows, self.run_engine(rows))
        self.assertEqual([r['severity'] for r in queue['rows']], ['high', 'low'])
