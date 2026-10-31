import copy
import unittest
from benchmark.fixtures import build, records_for, PROVENANCE
from benchmark.run import repeated_records
from benchmark.scoring import score
from bekzat_language.rules import analyze_record


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.cases = [{'id': 'a', 'expected': ['orthography'], 'rationale': 'test'},
                      {'id': 'b', 'expected': [], 'rationale': 'test'}]

    def test_scoring_counts_tp_fp_fn_independently(self):
        result = score(self.cases, [{'input_index': 0, 'issue_type': 'wrong_language'},
                                    {'input_index': 1, 'issue_type': 'orthography'}])
        self.assertEqual(result['micro'], {'tp': 0, 'fp': 2, 'fn': 1, 'precision': 0, 'recall': 0, 'f1': 0})
        self.assertEqual(result['confusion_cases'][0]['missing'], ['orthography'])
        self.assertEqual(result['confusion_cases'][0]['unexpected'], ['wrong_language'])

    def test_empty_predictions_do_not_claim_perfect_precision(self):
        result = score(self.cases, [])
        self.assertIsNone(result['micro']['precision'])
        self.assertEqual(result['micro']['recall'], 0)
        self.assertEqual(result['micro']['fn'], 1)

    def test_empty_population_is_undefined(self):
        self.assertIsNone(score([], [])['micro']['f1'])
        self.assertIsNone(score([], [])['micro']['recall'])

    def test_duplicate_same_type_prediction_does_not_inflate_tp(self):
        prediction = {'input_index': 0, 'issue_type': 'orthography'}
        result = score(self.cases, [prediction, prediction])
        self.assertEqual(result['micro']['tp'], 1)
        self.assertEqual(result['duplicate_predictions'], 1)

    def test_multiple_expected_labels_are_separate_units(self):
        self.cases[0]['expected'].append('wrong_language')
        result = score(self.cases, [{'input_index': 0, 'issue_type': 'orthography'}])
        self.assertEqual(result['micro']['recall'], 0.5)
        self.assertEqual(result['micro']['precision'], 1)

    def test_unknown_type_or_index_is_rejected(self):
        for prediction in [{'input_index': True, 'issue_type': 'orthography'},
                           {'input_index': 2, 'issue_type': 'orthography'},
                           {'input_index': 0, 'issue_type': 'made_up'}]:
            with self.assertRaises(ValueError):
                score(self.cases, [prediction])

    def test_duplicate_labels_or_case_ids_are_rejected(self):
        self.cases[0]['expected'].append('orthography')
        with self.assertRaises(ValueError):
            score(self.cases, [])
        with self.assertRaises(ValueError):
            score([self.cases[1], self.cases[1]], [])

    def test_frozen_fixtures_cover_all_types_and_distinct_occurrences(self):
        cases, glossary = build()
        records = records_for(cases)
        self.assertFalse(PROVENANCE['native_speaker_validated'])
        self.assertEqual(len(cases), 77)
        self.assertEqual({t for c in cases for t in c['expected']},
                         {'orthography', 'wrong_language', 'suffix_harmony', 'glossary_violation',
                          'inconsistent_term', 'machine_translation_suspect'})
        self.assertEqual(len({(r['key'], r['occurrence']) for r in records}), len(records))
        self.assertTrue(any(not c['expected'] for c in cases))

    def test_performance_replicas_do_not_mutate_fixture_or_collapse_keys(self):
        records = records_for(build()[0])
        original = copy.deepcopy(records)
        repeated = repeated_records(records, 1000)
        self.assertEqual(len({r['key'] for r in repeated}), 1000)
        self.assertEqual(records, original)

    def test_hidden_known_word_has_exact_codepoint_evidence(self):
        record = records_for(build()[0])[0]
        record['target'] = 'Сый\u200bлық'
        findings = analyze_record(record, {'status': 'draft', 'entries': []})
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]['issue_type'], 'orthography')
        self.assertIn('U+200B', findings[0]['evidence'])
        self.assertIn('позиции 3', findings[0]['evidence'])

    def test_hidden_controls_in_emoji_unknown_names_and_brands_are_not_errors(self):
        record = records_for(build()[0])[0]
        for target in ['👨‍👩‍👧', 'Demo\u200bBrand', 'Un\u200dknown']:
            record['target'] = target
            self.assertEqual(analyze_record(record, {'status': 'draft', 'entries': []}), [])
        record.update(target='Сый\u200bлық', metadata={'language_neutral_terms': ['Сый\u200bлық']})
        self.assertEqual(analyze_record(record, {'status': 'draft', 'entries': []}), [])

    def test_hidden_word_does_not_offer_automatic_format_control_rewrite(self):
        record = records_for(build()[0])[0]
        record['target'] = 'Сый\u200cлық'
        proposals = []
        self.assertEqual(len(analyze_record(record, {'status': 'draft', 'entries': []}, proposals=proposals)), 1)
        self.assertEqual(proposals, [])
