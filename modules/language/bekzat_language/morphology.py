"""Bounded native noun paradigms, not an unrestricted Kazakh stemmer.

Rules: https://emle.kz/kz/rule?id=126 (case harmony, final consonants).
Only the declared native stems below are analyzed. Loanword/name pronunciation,
possessives, derivation and vowel alternations require a separate lexicon.
"""
import re
from .contracts import finding

BACK = frozenset('аоұы')
FRONT = frozenset('әеөүі')
VOWELS = BACK | FRONT
VOICELESS = frozenset('пфкқтсшщхцчбвгд')
NASAL = frozenset('мнң')
# Invented module vocabulary, not extracted from private ARB or human-approved.
NOUNS = frozenset('ойыншы тапсырма көлік кілт сыйлық қала үй ақша мектеп'.split())
CASE_FAMILIES = {
    'dative': ('ға', 'ге', 'қа', 'ке'),
    'genitive': ('ның', 'нің', 'дың', 'дің', 'тың', 'тің'),
    'accusative': ('ны', 'ні', 'ды', 'ді', 'ты', 'ті'),
    'locative': ('да', 'де', 'та', 'те'),
    'ablative': ('нан', 'нен', 'дан', 'ден', 'тан', 'тен'),
}


def suffixes(stem):
    """Unpossessed forms only. Caller must establish a supported native stem."""
    vowel = next((c for c in reversed(stem) if c in VOWELS), None)
    if vowel is None:
        return {}
    front, final = vowel in FRONT, stem[-1]
    choose = lambda back, soft: soft if front else back
    dental = 'т' if final in VOICELESS else 'д'
    gen = 'н' if final in VOWELS | NASAL else dental
    acc = 'н' if final in VOWELS else dental
    abl = 'н' if final in NASAL else dental
    plural = 'т' if final in VOICELESS else 'л' if final in VOWELS | {'р', 'й', 'у'} else 'д'
    return {
        'dative': choose('қа', 'ке') if final in VOICELESS else choose('ға', 'ге'),
        'genitive': gen + choose('ың', 'ің'),
        'accusative': acc + choose('ы', 'і'),
        'locative': dental + choose('а', 'е'),
        'ablative': abl + choose('ан', 'ен'),
        'plural': plural + choose('ар', 'ер'),
    }


def noun_forms(lemma):
    """Map surface form to grammatical function; no guess for unknown lemmas."""
    if lemma.casefold() not in NOUNS:
        return {lemma: 'base'}
    endings = suffixes(lemma.casefold())
    out = {lemma: 'base', **{lemma + suffix: case for case, suffix in endings.items()}}
    plural = lemma + endings['plural']
    out.update({plural + suffix: 'plural+' + case for case, suffix in suffixes(plural.casefold()).items()
                if case != 'plural'})
    return out


def diagnose(record, masked):
    out = []
    for word in re.finditer(r'[^\W\d_]+', masked):
        token = word[0].casefold()
        # Longest stem first avoids a shorter lexical prefix stealing an analysis.
        for stem in sorted(NOUNS, key=lambda value: (-len(value), value)):
            if not token.startswith(stem):
                continue
            tail = token[len(stem):]
            family = next((name for name, variants in CASE_FAMILIES.items() if tail in variants), None)
            if family is None:
                continue
            expected = suffixes(stem)[family]
            if tail != expected:
                vowel = next(c for c in reversed(stem) if c in VOWELS)
                out.append(finding(record, 'suffix_harmony',
                    f'«{word[0]}» [{word.start()}:{word.end()}]: известная основа «{stem}», '
                    f'последняя гласная «{vowel}», конечный звук «{stem[-1]}»; '
                    f'для {family} без притяжательного суффикса ожидается «-{expected}», найдено «-{tail}».',
                    f'Проверить форму «{stem + expected}» в этом контексте. Правило относится только к обычному склонению указанной основы.',
                    0.85))
            break
    return out
