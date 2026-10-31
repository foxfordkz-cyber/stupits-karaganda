import unittest
from bekzat_language.rules import analyze_record

GLOSSARY = {'status': 'draft', 'entries': []}


def check(source, target, **options):
    return analyze_record({'key': 'arbitrary_unseen_key', 'locale': 'kk', 'source': source,
        'target': target, 'source_hash': 'a' * 64, 'occurrence': 1, **options}, GLOSSARY)


class SemanticTests(unittest.TestCase):
    def test_negation_alignment_across_subjects_and_objects(self):
        for source, target, expected in [('У меня нет ключа.', 'Менде кілт бар.', 'жоқ'),
            ('У нас есть билет!', 'Бізде билет жоқ!', 'бар'),
            ('У вас нет денег.', 'Сізде ақша бар.', 'жоқ')]:
            found = check(source, target)
            self.assertEqual([f['issue_type'] for f in found], ['machine_translation_suspect'])
            self.assertIn(expected, found[0]['suggestion'])
            self.assertIn('не установлено', found[0]['evidence'])

    def test_preserved_polarity_is_not_a_problem(self):
        for source, target in [('У меня нет ключа.', 'Менде кілт жоқ.'),
                               ('У нас есть билет!', 'Бізде билет бар!')]:
            self.assertEqual(check(source, target), [])

    def test_no_negation_guess_for_questions_quotes_compounds_or_unaligned_nouns(self):
        pairs = [('У вас нет денег?', 'Сізде ақша бар ма?'),
                 ('У вас нет денег.', 'Онда ақша бар.'),
                 ('У вас нет денег.', 'Сізде кілт бар.'),
                 ('У вас нет денег, но есть билет.', 'Сізде ақша жоқ, билет бар.'),
                 ('Не только деньги', 'Тек ақша емес'),
                 ('У вас нет денег.', '«Сізде ақша бар» деген жазу')]
        for source, target in pairs:
            self.assertEqual(check(source, target), [], target)

    def test_calque_family_covers_inflected_verbs_without_using_keys(self):
        for source, target in [('Я сделал выбор', 'Мен таңдауды жасадым'),
            ('Мы сделали выбор', 'Біз таңдауды жасадық'),
            ('Они приняли участие', 'Олар қатысуды қабылдады')]:
            found = check(source, target)
            self.assertEqual([f['issue_type'] for f in found], ['machine_translation_suspect'])

    def test_creation_acceptance_and_natural_choice_are_not_calques(self):
        for source, target in [('Мы сделали выбор', 'Біз таңдау жасадық'),
            ('Вы изготовили предмет', 'Сіз затты жасадыңыз'),
            ('Принять подарок', 'Сыйлықты қабылдау'),
            ('Принять участие', 'Қатысу')]:
            self.assertEqual(check(source, target), [])

    def test_contextual_transposition_has_unique_source_supported_suggestion(self):
        for source, target, fixed in [('Продолжить', 'Жалғастрыу', 'жалғастыру'),
                                      ('Задание', 'Тапсрыма', 'тапсырма')]:
            found = check(source, target)
            self.assertEqual([f['issue_type'] for f in found], ['orthography'])
            self.assertIn(fixed, found[0]['suggestion'])

    def test_transpositions_do_not_guess_names_or_unrelated_concepts(self):
        self.assertEqual(check('Название команды', 'Жалғастрыу'), [])
        self.assertEqual(check('Продолжить', 'Жалғастыру'), [])
        self.assertEqual(check('Продолжить', 'Жалғастрыу', metadata={'language_neutral': True}), [])

    def test_mixed_inline_lexical_runs_have_exact_spans(self):
        for text, fragment in [('Сізде недостаточно средств бар', 'недостаточно средств'),
                               ('🎁 Сыйлық үшін please click жалғастыру', 'please click')]:
            found = check('Текст', text)
            self.assertEqual([f['issue_type'] for f in found], ['wrong_language'])
            start = text.index(fragment)
            self.assertIn(f'[{start}:{start + len(fragment)}]', found[0]['evidence'])

    def test_single_foreign_word_repetition_quote_and_neutral_terms_abstain(self):
        for target in ['Жалғастыру үшін click басыңыз', 'Қазақша click click',
                       '«please click» деген сөз', 'Grand Coins үшін сыйлық']:
            self.assertEqual(check('Текст', target), [])
        self.assertEqual(check('Текст', 'Please Click үшін сыйлық',
                         metadata={'language_neutral_terms': ['Please Click']}), [])
