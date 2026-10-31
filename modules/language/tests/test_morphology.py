import unittest
from bekzat_language.morphology import noun_forms, suffixes
from bekzat_language.rules import analyze_record

GLOSSARY = {'status': 'draft', 'entries': []}


def record(target, **options):
    return {'key': 'synthetic', 'locale': 'kk', 'occurrence': 1, 'source': 'Текст',
            'target': target, 'source_hash': 'a' * 64, **options}


class MorphologyTests(unittest.TestCase):
    def test_native_case_paradigms(self):
        expected = {'қала': ('ға', 'ның'), 'үй': ('ге', 'дің'), 'кілт': ('ке', 'тің'),
                    'сыйлық': ('қа', 'тың'), 'ойыншы': ('ға', 'ның'), 'көлік': ('ке', 'тің')}
        for stem, (dative, genitive) in expected.items():
            with self.subTest(stem=stem):
                self.assertEqual(suffixes(stem)['dative'], dative)
                self.assertEqual(suffixes(stem)['genitive'], genitive)
                for form in noun_forms(stem):
                    self.assertEqual(analyze_record(record(form), GLOSSARY), [])

    def test_wrong_harmony_and_consonant_are_explained(self):
        for bad, good in [('қалаге', 'қалаға'), ('үйға', 'үйге'), ('кілтге', 'кілтке'),
                          ('сыйлықдың', 'сыйлықтың'), ('ойыншыдың', 'ойыншының'),
                          ('көліктың', 'көліктің')]:
            with self.subTest(bad=bad):
                findings = analyze_record(record('🎁 ' + bad), GLOSSARY)
                self.assertEqual([f['issue_type'] for f in findings], ['suffix_harmony'])
                self.assertIn(good, findings[0]['suggestion'])
                self.assertIn('[2:', findings[0]['evidence'])

    def test_names_loanwords_possessives_and_unknown_roots_abstain(self):
        for text in ['Алексейге', 'Игорьға', 'Әселге', 'Grand Coins-ке', 'ГК-ға',
                     'варн мут фура', 'үйіне', 'ойыншысына', 'кілттіңіз', 'Қаланық']:
            self.assertEqual(analyze_record(record(text), GLOSSARY), [], text)

    def test_neutral_words_and_nonvisible_text_abstain(self):
        for text in ['<b title="үйға">Үй</b>', 'https://example.test/үйға', 'үйға@example.test']:
            self.assertEqual(analyze_record(record(text), GLOSSARY), [])
        self.assertEqual(analyze_record(record('Үйға', metadata={'language_neutral_terms': ['Үйға']}), GLOSSARY), [])

    def test_dynamic_plural_case_and_pronunciation_unknown(self):
        for text in ['{name}-ларға', '{name}-лердің', '%s-ке', '{name}-ға қатысты']:
            findings = analyze_record(record(text), GLOSSARY)
            self.assertEqual([f['issue_type'] for f in findings], ['suffix_harmony'])
            self.assertIn('произношению', findings[0]['suggestion'])
            self.assertFalse(findings[0]['reviewed_by_human'])

    def test_runtime_permission_is_slot_specific(self):
        r = record('{name}-лардың {other}-ге', metadata={'placeholders': {'name': {'suffix_handled_by_runtime': True}}})
        found = analyze_record(r, GLOSSARY)
        self.assertEqual(len(found), 1)
        self.assertIn('{other}', found[0]['evidence'])

    def test_unknown_lemma_is_not_stemmed(self):
        self.assertEqual(noun_forms('гараж'), {'гараж': 'base'})
