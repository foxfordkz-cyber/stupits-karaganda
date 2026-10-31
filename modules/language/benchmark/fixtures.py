"""Hand-authored synthetic expectations, not native-reviewed linguistic ground truth.

No supplied ARB text is used. Expected labels are declared independently of the engine.
Known hard cases intentionally remain in the denominator when the detector misses them.
"""
import copy
import hashlib

ISSUES = ('glossary_violation', 'inconsistent_term', 'machine_translation_suspect',
          'orthography', 'wrong_language', 'suffix_harmony')
PROVENANCE = {
    'origin': 'invented_by_ai_for_controlled_regression',
    'native_speaker_validated': False,
    'hidden_test': False,
    'scope': 'agreement with declared synthetic expectations; not real-world translation accuracy',
}
GLOSSARY = {'status': 'draft', 'entries': [
    {'id': 'player', 'source_forms': ['игрок', 'игрока', 'игроки'],
     'allowed_forms': ['ойыншы', 'ойыншының', 'ойыншылар'], 'preferred': 'ойыншы',
     'forbidden_forms': {'ойнаушы': 'ойыншы'}, 'consistent': True,
     'variants': {'ойыншы': 'standard', 'ойыншының': 'standard', 'ойыншылар': 'standard', 'ойнаушы': 'alternative'}},
    {'id': 'quest', 'source_forms': ['задание'], 'allowed_forms': ['тапсырма'],
     'preferred': 'тапсырма', 'forbidden_forms': {'міндет': 'тапсырма'}, 'categories': ['quests']},
    {'id': 'daily', 'source_forms': ['ежедневное задание'], 'allowed_forms': ['күнделікті тапсырма'],
     'preferred': 'күнделікті тапсырма', 'consistent': True,
     'variants': {'күнделікті тапсырма': 'daily', 'тапсырма': 'generic'}},
    {'id': 'brand', 'source_forms': ['Continue'], 'allowed_forms': ['Continue'], 'preferred': 'Continue'},
    {'id': 'rank', 'source_forms': ['ранг'], 'allowed_forms': ['дәреже', 'ранг'], 'preferred': 'дәреже',
     'consistent': True, 'consistency_scope': 'global', 'variants': {'дәреже': 'new', 'ранг': 'old'}},
]}


def build():
    cases = []

    def add(identifier, source, target, labels, rationale, **options):
        cases.append({'id': identifier, 'source': source, 'target': target,
                      'expected': labels.split() if labels else [],
                      'rationale': rationale, **options})

    # Glossary decisions are explicit fixture policy, never inferred from a dictionary.
    add('g_player_bad', 'Игрок', 'Ойнаушы', 'glossary_violation', 'Explicit forbidden form for this source concept.')
    add('g_player_good', 'Игрок', 'Ойыншы', '', 'Allowed term.')
    add('g_player_inflected', 'Игрока', 'Ойыншының', '', 'Declared inflection, same lemma.')
    add('g_unknown_inflection', 'Игрок', 'ойыншыларына', '', 'Unknown inflection is insufficient evidence.')
    add('g_no_source_match', 'Участник', 'ойнаушы', '', 'Policy does not cover this source concept.')
    add('g_word_boundary', 'Игрок', 'ойнаушылар', '', 'Do not strip arbitrary suffixes to force a forbidden match.')
    add('g_scoped_bad', 'Задание', 'Міндет', 'glossary_violation', 'Forbidden in quests only.', category='quests')
    add('g_scoped_allowed', 'Задание', 'Міндет', '', 'Different category, policy does not apply.', category='duties')
    add('g_quest_good', 'Задание', 'Тапсырма', '', 'Preferred term.', category='quests')
    add('g_brand', 'Continue', 'Continue', '', 'Explicit permitted fictional brand.')
    add('g_brand_prose', 'Нажмите Continue', 'Пожалуйста нажмите Continue', 'wrong_language', 'Brand does not protect surrounding Russian.')
    add('g_slang', 'Аккаунт', 'Аккаунт', '', 'Common borrowed UI term; no prohibition.')

    add('c_standard', 'Игрок', 'Ойыншы', 'inconsistent_term', 'Different declared variant in same category.', category='players')
    add('c_alternative', 'Игрок', 'Ойнаушы', 'glossary_violation inconsistent_term', 'Forbidden and inconsistent variant.', category='players')
    add('c_inflected_a', 'Игрок', 'ойыншы', '', 'Same lemma across grammatical forms.', category='inflections')
    add('c_inflected_b', 'Игрока', 'ойыншының', '', 'Same lemma across grammatical forms.', category='inflections')
    add('c_separate_a', 'Игрок', 'ойыншы', '', 'Separate category is not a consistency witness.', category='separate_a')
    add('c_separate_b', 'Игрок', 'ойнаушы', 'glossary_violation', 'Separate category; only forbidden form applies.', category='separate_b')
    add('c_long_a', 'Ежедневное задание', 'Күнделікті тапсырма', '', 'Nested generic word must not count as second variant.', category='daily')
    add('c_long_b', 'Ежедневное задание', 'күнделікті тапсырма', '', 'Same long phrase, case difference only.', category='daily')
    add('c_global_a', 'Ранг', 'Дәреже', 'inconsistent_term', 'Explicit global concept policy.', category='profile')
    add('c_global_b', 'Ранг', 'Ранг', 'inconsistent_term', 'Explicit global policy crosses sections.', category='leaderboard')

    add('m_choice', 'Вы сделали выбор.', 'Сіз таңдауды жасадыңыз.', 'machine_translation_suspect', 'Literal object construction; request native review.')
    add('m_choice_case', 'ВЫ СДЕЛАЛИ ВЫБОР!', 'СІЗ ТАҢДАУДЫ ЖАСАДЫҢЫЗ!', 'machine_translation_suspect', 'Same narrow construction with case/punctuation.')
    add('m_choice_good', 'Вы сделали выбор.', 'Сіз таңдау жасадыңыз.', '', 'Expected idiomatic alternative; native validation still needed.')
    add('m_creation', 'Вы изготовили предмет.', 'Сіз затты жасадыңыз.', '', 'Making an object is not the choice calque.')
    add('m_plural_hard', 'Мы сделали выбор.', 'Біз таңдауды жасадық.', 'machine_translation_suspect', 'Hard case: inflected plural calque; not the exact implemented template.')
    add('m_participation_hard', 'Принять участие', 'Қатысуды қабылдау', 'machine_translation_suspect', 'Hard case: literal acceptance construction; unvalidated author label.')
    add('m_negation_hard', 'У вас нет денег.', 'Сізде ақша бар.', 'machine_translation_suspect', 'Hard case: lost negation; label is semantic suspicion, not proof of MT origin.')
    add('m_negation_good', 'У вас нет денег.', 'Сізде ақша жоқ.', '', 'Expected preserved negation.')

    add('o_gift', 'Подарок', 'Сыйлык', 'orthography', 'Missing қ in a known word.')
    add('o_greeting', 'Здравствуйте', 'сәлеметсізбе', 'orthography', 'Known separated question particle.')
    add('o_welcome', 'Добро пожаловать', 'Кош келдіңіз', 'orthography', 'Known қ spelling.')
    add('o_security', 'Безопасность', 'Кауіпсіздік', 'orthography', 'Known қ spelling.')
    add('o_genitive', 'Профиль игрока', 'ойыншынын профилі', 'orthography', 'Known ң spelling.')
    add('o_homoglyph', 'Подарок', 'Cыйлық', 'orthography', 'Latin C in a known Cyrillic word.')
    add('o_homoglyph_lower', 'Войти', 'Кiру', 'orthography', 'Latin i in a known Cyrillic word.')
    add('o_good', 'Подарок', 'Сыйлық', '', 'Known correct spelling.')
    add('o_unknown_name', 'Название', 'GrandҚала', '', 'Mixed script name alone is not proof.')
    add('o_email', 'Контакт', 'сыйлык@example.test', '', 'Email is not a spelling candidate.')
    add('o_markup', 'Название', '<b title="x > сыйлык">Сыйлық</b>', '', 'Attribute is not visible spelling.')
    add('o_emoji', 'Подарок {name}', '🎁 Сыйлык {name}', 'orthography', 'Emoji must not corrupt Unicode offsets.')
    add('o_hidden_zwsp', 'Подарок', 'Сый\u200bлық', 'orthography', 'Invisible format character splits a known Kazakh word.')
    add('o_hidden_zwj', 'Войти', 'Кі\u200dру', 'orthography', 'Invisible joiner inside a known word.')
    add('o_emoji_joiner', 'Семья', '👨‍👩‍👧', '', 'Emoji joiners are intentional and must remain untouched.')
    add('o_typo_hard', 'Продолжить', 'Жалғастрыу', 'orthography', 'Hard case: transposition outside the narrow dictionary.')

    add('w_ru', 'Подтвердите действие', 'Пожалуйста нажмите подтвердить', 'wrong_language', 'Multiple Russian UI markers.')
    add('w_en', 'Выберите награду', 'Please select your reward', 'wrong_language', 'Multiple English UI markers.')
    add('w_uz', 'Нажмите кнопку', 'Iltimos tugmasini bosing', 'wrong_language', 'Multiple Uzbek UI markers.')
    add('w_mixed_en', 'Добро пожаловать. Продолжите.', 'Қош келдіңіз! Please click continue.', 'wrong_language', 'Kazakh sentence must not hide English sentence.')
    add('w_mixed_ru', 'Здравствуйте. Выберите игрока.', 'Сәлем! Пожалуйста выберите игрока.', 'wrong_language', 'Separate Russian clause after Kazakh.')
    add('w_ui', 'Продолжить', 'Continue', 'wrong_language', 'Untranslated UI verb; source is not the brand.')
    add('w_reference', 'Выберите аватар', 'Choose avatar', 'wrong_language', 'One marker corroborated by exact additional reference.', context={'references': {'en': 'Choose avatar'}})
    add('w_correct', 'Продолжить', 'Жалғастыру', '', 'Kazakh UI verb.')
    add('w_shared_word', 'Телефон', 'Телефон', '', 'Shared borrowed word is acceptable.')
    add('w_abbreviation', 'Название', 'VIP / XP / HP', '', 'Game abbreviations are language neutral.')
    add('w_numbers', 'Номер', '2026 / 42', '', 'Numbers do not identify a language.')
    add('w_brand_metadata', 'Название', 'Continue', '', 'Explicit neutral metadata.', metadata={'language_neutral_terms': ['Continue']})
    add('w_mixed_single', 'Приветствие', 'Сәлем! Grand Mobile.', '', 'Foreign-looking name without language evidence.')
    add('w_inline_hard', 'Продолжите, пожалуйста', 'Жалғастыру үшін please click continue', 'wrong_language', 'Hard case: foreign phrase within a Kazakh clause without punctuation.')
    add('w_duplicate_a', 'Продолжить', 'Continue', 'wrong_language', 'One occurrence must retain its own label.', key='duplicate_button', occurrence=1)
    add('w_duplicate_b', 'Продолжить', 'Жалғастыру', '', 'Second occurrence must not inherit first finding.', key='duplicate_button', occurrence=2)

    add('s_name', 'Для {name}', '{name}-ға', 'suffix_harmony', 'Unknown dynamic pronunciation; risk only.')
    add('s_front', 'Для {name}', '{name}-ге', 'suffix_harmony', 'Front-vowel choice is not universally safe either.')
    add('s_voiceless', 'Для {name}', '{name}-қа', 'suffix_harmony', 'Unknown consonant as well as vowel.')
    add('s_possessive', 'Профиль {name}', '{name}ның профилі', 'suffix_harmony', 'Affix without joining hyphen.')
    add('s_printf', 'Для %s', '%s-ға', 'suffix_harmony', 'Printf value is dynamic.')
    add('s_printf_position', 'Для %1$s', '%1$s-ке', 'suffix_harmony', 'Positioned printf value is dynamic.')
    add('s_number', 'К числу {count}', '{count, number}-ге', 'suffix_harmony', 'Rendered number has unknown pronunciation.')
    add('s_date', 'К дате {when}', '{when, date, short}-ге', 'suffix_harmony', 'Rendered formatted value is unknown.')
    add('s_no_suffix', 'Имя {name}', 'Аты: {name}', '', 'Label construction avoids affix.')
    add('s_runtime', 'Для {name}', '{name}-ға', '', 'Integrator explicitly handles morphology.', metadata={'placeholders': {'name': {'suffix_handled_by_runtime': True}}})
    add('s_literal_percent', 'Шаблон', '%%s-ға', '', 'Escaped percent is not a dynamic value.')
    add('s_icu_literal', 'Шаблон', "'{name}-ға'", '', 'Quoted ICU literal is not a dynamic value.')
    add('s_attribute', 'Подсказка', '<b title="{name}-ға">Бонус</b>', '', 'Attribute is outside visible-text diagnostic scope.')
    add('s_url', 'Ссылка', 'https://example.test/{name}-ға', '', 'URL token is not inflected UI prose.')
    add('s_separate_particle', 'Имя тоже', '{name} да келді', '', 'Separate word is not a fixed attached suffix.')
    return copy.deepcopy(cases), copy.deepcopy(GLOSSARY)


def records_for(cases):
    records = []
    for case in cases:
        record = {'key': case.get('key', case['id']), 'locale': 'kk',
                  'source': case['source'], 'target': case['target'],
                  'source_hash': hashlib.sha256(case['source'].encode('utf-8')).hexdigest(),
                  'occurrence': case.get('occurrence', 1), 'category': case.get('category', 'case:' + case['id'])}
        for field in ('context', 'metadata', 'description'):
            if field in case:
                record[field] = copy.deepcopy(case[field])
        records.append(record)
    return records
