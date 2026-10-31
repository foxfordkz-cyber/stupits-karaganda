import copy
import unittest
from bekzat_language.contracts import validate_glossary
from bekzat_language.rules import analyze_record, term_contexts


def record(key, target, category='garage', source='Транспорт'):
    return {'key': key, 'locale': 'kk', 'source': source, 'target': target,
            'category': category, 'occurrence': 1, 'source_hash': 'a' * 64}


class TerminologyTests(unittest.TestCase):
    def setUp(self):
        self.glossary = {'status': 'draft', 'entries': [{
            'id': 'vehicle', 'source_forms': ['транспорт', 'транспорту'],
            'allowed_forms': ['көлік', 'машина'], 'preferred': 'көлік',
            'consistent': True, 'inflect_native': True,
            'variants': {'көлік': 'standard', 'машина': 'alternative'},
        }]}

    def test_inflected_terms_link_to_lemma_and_witness(self):
        records = [record('a', 'Көліктердің тізімі'), record('b', 'Машина')]
        contexts, findings = term_contexts(records, self.glossary)
        self.assertEqual([len(fs) for fs in findings], [1, 1])
        self.assertIn('көліктердің', findings[0][0]['evidence'])
        self.assertEqual(contexts[0][0]['witnesses'][0]['key'], 'b')
        self.assertTrue(all(not fs[0]['reviewed_by_human'] for fs in findings))

    def test_same_lemma_forms_and_explicit_synonyms_are_consistent(self):
        records = [record('a', 'Көлікке'), record('b', 'Көліктерден')]
        self.assertEqual(term_contexts(records, self.glossary)[1], [[], []])
        self.glossary['entries'][0]['variants']['машина'] = 'standard'
        self.assertEqual(term_contexts([records[0], record('c', 'Машина')], self.glossary)[1], [[], []])

    def test_opt_in_required_and_no_arbitrary_stemming(self):
        self.glossary['entries'][0]['inflect_native'] = False
        self.assertEqual(term_contexts([record('a', 'Көлікке'), record('b', 'Машина')], self.glossary)[1], [[], []])
        self.glossary['entries'][0]['inflect_native'] = True
        self.assertEqual(term_contexts([record('a', 'Көліксіз'), record('b', 'Машина')], self.glossary)[1], [[], []])

    def test_category_source_and_locale_prevent_false_conflicts(self):
        for other in [record('b', 'Машина', 'business'), record('b', 'Машина', source='Здание'),
                      {**record('b', 'Машина'), 'locale': 'kk-Latn'}]:
            self.assertEqual(term_contexts([record('a', 'Көлікке'), other], self.glossary)[1], [[], []])

    def test_longest_phrase_wins(self):
        e = self.glossary['entries'][0]
        e['variants'] = {'қызметтік көлік': 'service', 'көлік': 'generic'}
        rows = [record('a', 'Қызметтік көлікке'), record('b', 'Қызметтік көліктерден')]
        self.assertEqual(term_contexts(rows, self.glossary)[1], [[], []])

    def test_approved_slang_and_currency_do_not_hide_surrounding_language(self):
        for term in ['Grand Coins', 'ГК', 'варн', 'мут', 'фура']:
            glossary = {'status': 'draft', 'entries': [{'id': 'slang', 'source_forms': [term],
                'allowed_forms': [term], 'preferred': term, 'inflect_native': True}]}
            self.assertEqual(analyze_record(record('x', term, source=term), glossary), [])
            findings = analyze_record(record('x', 'Пожалуйста нажмите ' + term, source=term), glossary)
            self.assertEqual([f['issue_type'] for f in findings], ['wrong_language'])

    def test_no_mutation_and_invalid_option_rejected(self):
        before = copy.deepcopy(self.glossary)
        term_contexts([record('a', 'Көлікке'), record('b', 'Машина')], self.glossary)
        self.assertEqual(before, self.glossary)
        self.glossary['entries'][0]['inflect_native'] = 'true'
        with self.assertRaises(ValueError):
            validate_glossary(self.glossary)
