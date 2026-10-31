"""Explainable lexical alignment. Abstain outside supported constructions."""
import re
from .contracts import finding

SUBJECTS = {'вас': 'сізде', 'тебя': 'сенде', 'нас': 'бізде', 'него': 'онда',
            'неё': 'онда', 'них': 'оларда', 'меня': 'менде'}
CONCEPTS = {'денег': 'ақша', 'деньги': 'ақша', 'средств': 'қаражат', 'средства': 'қаражат',
            'билета': 'билет', 'билет': 'билет', 'ключа': 'кілт', 'ключ': 'кілт',
            'доступа': 'рұқсат', 'доступ': 'рұқсат'}
POSSESSION = re.compile(r'\s*у (вас|тебя|нас|него|неё|них|меня) (нет|есть) ([а-яё]+)[.!]?\s*', re.I)
CHOICE_SOURCE = re.compile(r'\bсделал(?:а|и)?\s+выбор\b', re.I)
CHOICE_TARGET = re.compile(r'(?<!\w)таңдауды\s+жаса(?:дым|дыңыз|дың|дық|ды)(?!\w)', re.I)
PARTICIPATE_SOURCE = re.compile(r'\b(?:принять|принял|приняла|приняли|принимайте)\s+участие\b', re.I)
PARTICIPATE_TARGET = re.compile(r'(?<!\w)қатысуды\s+қабылда(?:у|дым|дыңыз|дың|дық|ды)(?!\w)', re.I)
# A typo suggestion needs both a unique adjacent transposition and a source concept.
SPELLING_CONCEPTS = {'продолжить': 'жалғастыру', 'безопасность': 'қауіпсіздік',
                     'подарок': 'сыйлық', 'задание': 'тапсырма', 'игрок': 'ойыншы'}


def diagnostics(record, masked):
    out = []
    match = POSSESSION.fullmatch(record['source'])
    if match and (noun := CONCEPTS.get(match[3].casefold())):
        subject = SUBJECTS[match[1].casefold()]
        target = re.fullmatch(r'\s*' + subject + r'\s+' + noun + r'\s+(бар|жоқ)[.!]?\s*', masked, re.I)
        expected = 'жоқ' if match[2].casefold() == 'нет' else 'бар'
        if target and target[1].casefold() != expected:
            out.append(finding(record, 'machine_translation_suspect',
                f'Совпадают субъект «{match[1]}»/«{subject}» и понятие «{match[3]}»/«{noun}», '
                f'но «{match[2]}» в исходнике противопоставлено «{target[1]}» '
                f'[{target.start(1)}:{target.end(1)}] в переводе. Возможна инверсия наличия/отсутствия; происхождение перевода не установлено.',
                f'Проверить отрицание: для этого утверждения использовать «{expected}» вместо «{target[1]}».',
                0.85, 'high'))
    for source_pattern, target_pattern, replacement in [
        (CHOICE_SOURCE, CHOICE_TARGET, 'таңдауды → таңдау; сохранить лицо и время глагола'),
        (PARTICIPATE_SOURCE, PARTICIPATE_TARGET,
         'использовать глагол «қатысу» в нужном лице и времени вместо сочетания с «қабылдау»'),
    ]:
        if not source_pattern.search(record['source']):
            continue
        for m in target_pattern.finditer(masked):
            out.append(finding(record, 'machine_translation_suspect',
                f'Фрагмент «{m[0]}» [{m.start()}:{m.end()}] воспроизводит русскую именную конструкцию. '
                'Возможна калька; требуется проверка естественности носителем, происхождение перевода не установлено.',
                'Проверить вариант: ' + replacement + '.', 0.65, 'low'))
    return out


def transpositions(record, masked):
    expected = {target for source, target in SPELLING_CONCEPTS.items()
                if re.search(r'(?<!\w)' + source + r'(?!\w)', record['source'], re.I)}
    for m in re.finditer(r'[^\W\d_]+', masked):
        word = m[0].casefold()
        if len(word) < 6 or word in expected:
            continue
        choices = {word[:i] + word[i + 1] + word[i] + word[i + 2:] for i in range(len(word) - 1)} & expected
        if len(choices) == 1:
            yield m, next(iter(choices))
