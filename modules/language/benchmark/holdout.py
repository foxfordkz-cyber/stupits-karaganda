"""New post-freeze synthetic challenge. Labels are never derived from predictions.

Authored after diagnostic freeze fdd5bfd; do not tune that candidate against this set.
Same AI author as the implementation: this is NOT independent human validation or a
blind external holdout. It supports an honest, separate post-freeze comparison only.
"""
import copy

PROVENANCE = {
    'origin': 'new_invented_ai_cases_after_diagnostic_freeze_fdd5bfd',
    'diagnostic_freeze': 'fdd5bfd', 'native_speaker_validated': False,
    'independent_author': False, 'hidden_test': False, 'used_for_rule_tuning': False,
    'scope': 'post-freeze synthetic challenge; same-author bias; human review required',
}
GLOSSARY = {'status': 'draft', 'entries': [
    {'id': 'transport', 'source_forms': ['транспорт'], 'allowed_forms': ['көлік', 'авто'],
     'preferred': 'көлік', 'inflect_native': True, 'consistent': True,
     'variants': {'көлік': 'native', 'авто': 'borrowed'}, 'categories': ['fleet']},
    {'id': 'cash', 'source_forms': ['валюта'], 'allowed_forms': ['Grand Coins', 'ГК'],
     'preferred': 'Grand Coins', 'consistent': True,
     'variants': {'Grand Coins': 'same', 'ГК': 'same'}},
    {'id': 'warning', 'source_forms': ['предупреждение'], 'allowed_forms': ['варн'],
     'preferred': 'варн', 'forbidden_forms': {'жаза': 'варн'}, 'categories': ['moderation']},
]}


def build():
    cases = []
    def add(source, target, labels='', rationale='Declared synthetic expectation; requires native review.', **kw):
        cases.append({'id': f'h{len(cases):03}', 'source': source, 'target': target,
                      'expected': labels.split(), 'rationale': rationale, **kw})

    # Static grammatical allomorphs; neither names nor technical ICU checks.
    for bad, good in [('Мектепға', 'Мектепке'), ('Ақшадің', 'Ақшаның'),
                      ('Тапсырматы', 'Тапсырманы'), ('Көлікден', 'Көліктен'),
                      ('Қалата', 'Қалада'), ('Үйның', 'Үйдің')]:
        add('Метка раздела', bad, 'suffix_harmony', 'Native stem with a mismatching plain-case allomorph.')
        add('Метка раздела', good, '', 'Correct plain-case form.')
    for value in ['Андрейге хат', 'Сергейдің көлігі', 'Әлияға хабарлама', 'Отбасының мүшесі',
                  'Grand Coins-ке', 'ГК-ның бағасы', 'варн алды', 'мут берілді', 'фура келді']:
        add('Игровая подпись', value, '', 'Names, loanwords or valid slang are not blanket errors.')

    add('У них нет доступа.', 'Оларда рұқсат бар.', 'machine_translation_suspect', 'Aligned absence became presence.')
    add('У тебя есть ключ.', 'Сенде кілт жоқ.', 'machine_translation_suspect', 'Aligned presence became absence.')
    add('У неё нет средств.', 'Онда қаражат жоқ.', '', 'Negation preserved.')
    add('У него есть деньги.', 'Онда ақша бар.', '', 'Affirmation preserved.')
    add('Не удаляйте семью.', 'Отбасын жойыңыз.', 'machine_translation_suspect', 'Prohibition lost; broad semantic hard case.')
    add('Можно войти.', 'Кіруге болмайды.', 'machine_translation_suspect', 'Permission reversed; broad modal hard case.')
    add('Куплено два билета.', 'Үш билет сатып алынды.', 'machine_translation_suspect', 'Quantity changed; semantic hard case.')
    add('Не только награда.', 'Тек сыйлық емес.', '', 'Nontrivial negation preserved.')
    add('Я не сделал выбор.', 'Мен таңдау жасамадым.', '', 'Negative verb preserved.')
    add('Она сделала выбор.', 'Ол таңдауды жасады.', 'machine_translation_suspect', 'Declared unnatural choice collocation.')
    add('Мы приняли участие.', 'Біз қатысуды қабылдадық.', 'machine_translation_suspect', 'Declared literal participation collocation.')
    add('Вы приняли заказ.', 'Сіз тапсырысты қабылдадыңыз.', '', 'Literal acceptance is appropriate.')

    add('Задание готово', 'Тапсрыма дайын', 'orthography', 'Source-supported adjacent transposition.')
    add('Безопасность игрока', 'Қауіпсізідк', 'orthography', 'Source-supported adjacent transposition.')
    add('Подарок', 'Сыылық', 'orthography', 'Misspelling beyond a simple adjacent transposition.')
    add('Название', 'Кі\u200cру', 'orthography', 'Hidden format control inside a known word.')
    add('Профиль', 'Қауiпсіздік', 'orthography', 'Known word has a Latin i.')
    add('Значок семьи', '👩‍👩‍👧‍👦', '', 'Emoji joiners are intentional.')
    add('Название клуба', 'ҚалаX', '', 'Mixed-script name is not automatically a typo.')
    add('Подарок', '<span title="Сыылық">Сыйлық</span>', '', 'Do not inspect markup attributes as prose.')

    add('Удалить профиль', 'Профиль үшін please confirm delete', 'wrong_language', 'Embedded foreign UI phrase.')
    add('Выберите награду', 'Сыйлықты выберите пожалуйста', 'wrong_language', 'Embedded Russian lexical pair.')
    add('Подтвердить', 'Сіз confirm басыңыз', 'wrong_language', 'Single untranslated UI verb; conservative hard case.')
    add('Текст справки', '«delete profile» деген жазу', '', 'Quoted foreign phrase is a mention.')
    add('Игровое имя', 'Please Confirm үшін сыйлық', '', 'Ambiguous label with postposition; abstain.')
    add('Валюта', 'Grand Coins', '', 'Explicit allowed brand.')
    add('Валюта', 'ГК', '', 'Declared abbreviation synonym.')
    add('Предупреждение', 'Жаза', 'glossary_violation', 'Explicit scoped prohibition.', category='moderation')
    add('Предупреждение', 'Жаза', '', 'Different policy category.', category='legal')
    add('Предупреждение', 'Варн', '', 'Explicit allowed slang.', category='moderation')
    add('Транспорт', 'Көліктерге', 'inconsistent_term', 'Inflected native variant conflicts with declared borrowed variant.', category='fleet')
    add('Транспорт', 'Авто', 'inconsistent_term', 'Witness for same concept/category.', category='fleet')
    add('Транспорт', 'Көліктерге', '', 'Different category cannot create a conflict.', category='taxi')

    for value in ['{driver}-дің көлігі', '{count, number}-ке', '%2$s-тардың тізімі', '{group}-ларға']:
        add('Динамическая подпись', value, 'suffix_harmony', 'Unknown dynamic pronunciation; request runtime or rewrite.')
    add('Владелец', 'Иесі: {driver}', '', 'No inflection of dynamic value.')
    add('Ссылка', 'https://example.test/{driver}-ге', '', 'Technical URL is protected.')
    add('Шаблон', "'{group}-ларға'", '', 'ICU quoted literal is not dynamic.')
    add('Подсказка', '{driver}-ге', '', 'Explicit runtime formatter responsibility.',
        metadata={'placeholders': {'driver': {'suffix_handled_by_runtime': True}}})
    add('Пустой перевод обрабатывает ядро', 'Бонус', '', 'Ordinary borrowed noun is permitted.')
    return copy.deepcopy(cases), copy.deepcopy(GLOSSARY)
