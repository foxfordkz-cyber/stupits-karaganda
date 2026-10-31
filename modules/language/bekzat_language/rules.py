"""Conservative diagnostics. No general spell checker or measured quality score."""
import re
import unicodedata
from functools import lru_cache
from .contracts import finding
from .proposals import spelling_proposal
from .morphology import diagnose as morphology_diagnostics, CASE_FAMILIES, noun_forms

RULES_VERSION = "kk-contextual-1.4.1"
BRACED_SLOT = r"\{(?P<name>[A-Za-z_][A-Za-z_0-9]*)(?:\s*,\s*(?:number|date|time)(?:\s*,[^{}]*)?)?\}"
PRINTF_SLOT = r"%(?:\d+\$)?[-+#0 ]*(?:\d+|\*(?:\d+\$)?)?(?:\.(?:\d+|\*(?:\d+\$)?))?[sdif]"
DYNAMIC_SLOT = re.compile(r"%%|" + BRACED_SLOT + "|" + PRINTF_SLOT)
ICU_QUOTED = re.compile(r"(?<!')'(?:\{|\}|#)(?:[^']|'')*'(?!')")
WORD = re.compile(r"[^\W\d_]+(?:['’ʻ‘][^\W\d_]+)*", re.UNICODE)
KK_LETTERS = re.compile("[әғқңөұүһі]", re.I)
# Small generic examples authored for this module, not extracted from supplied data.
SPELLING = {"сәлеметсізбе": "сәлеметсіз бе", "кош келдіңіз": "қош келдіңіз",
            "ойыншынын": "ойыншының", "сыйлык": "сыйлық", "кауіпсіздік": "қауіпсіздік"}
KNOWN_WORDS = set('ойыншы сыйлық қауіпсіздік кіру шығу тапсырма жалғастыру таңдау сәлеметсіз келдіңіз'.split())
HOMOGLYPHS = str.maketrans('ABCEHIKMOPTXaceiopxy', 'АВСЕНІКМОРТХасеіорху')
HIDDEN_LETTERS = '\u200b\u200c\u200d'
HIDDEN_WORD = re.compile(r"[^\W\d_]+(?:[\u200b\u200c\u200d]+[^\W\d_]+)+")
LANGUAGE_WORDS = {
    "ru": set("пожалуйста нажмите чтобы невозможно недостаточно средств покупка отменить продолжить подтвердить отправить удалить выберите ошибка получено доступно выполнено необходимо сообщение ваш ваша ваши игрока завершено".split()),
    "en": set("please click purchase cancel continue confirm delete insufficient funds select choose reward received completed unable message your you the this".split()),
    "uz": set("iltimos tugmasini bosing bekor qilish davom etish tanlang xarid muvaffaqiyatli uchun sizning emas mablag yetarli".split()),
}
UI_TRANSLATIONS = {"отменить": "Болдырмау", "продолжить": "Жалғастыру", "подтвердить": "Растау",
                   "недостаточно средств": "Қаражат жеткіліксіз", "cancel": "Болдырмау",
                   "continue": "Жалғастыру", "confirm": "Растау", "insufficient funds": "Қаражат жеткіліксіз",
                   "bekor qilish": "Болдырмау"}
LEXICAL_HINTS = {"пожалуйста": "өтінеміз", "нажмите": "басыңыз", "недостаточно": "жеткіліксіз",
    "средств": "қаражат", "покупка": "сатып алу", "отменить": "болдырмау", "продолжить": "жалғастыру",
    "подтвердить": "растау", "отправить": "жіберу", "удалить": "жою", "выберите": "таңдаңыз",
    "ошибка": "қате", "получено": "алынды", "доступно": "қолжетімді", "выполнено": "орындалды",
    "необходимо": "қажет", "сообщение": "хабарлама", "игрока": "ойыншы", "завершено": "аяқталды",
    "please": "өтінеміз", "click": "басыңыз", "purchase": "сатып алу", "cancel": "болдырмау",
    "continue": "жалғастыру", "confirm": "растау", "delete": "жою", "insufficient": "жеткіліксіз",
    "funds": "қаражат", "select": "таңдаңыз", "choose": "таңдаңыз", "reward": "сыйлық",
    "received": "алынды", "completed": "аяқталды", "message": "хабарлама",
    "iltimos": "өтінеміз", "tugmasini": "батырмасын", "bosing": "басыңыз", "bekor": "болдырмау",
    "tanlang": "таңдаңыз", "xarid": "сатып алу", "muvaffaqiyatli": "сәтті", "uchun": "үшін",
    "sizning": "сіздің", "emas": "емес", "mablag": "қаражат", "yetarli": "жеткілікті"}
SUFFIXES = "лары лері дары дері тары тері ның нің дың дің тың тің нан нен дан ден тан тен ға ге қа ке да де та те ны ні ды ді ты ті лар лер дар дер тар тер мен бен пен ым ім ың ің ы і".split()
SUFFIXES += [plural + case for plural in ('лар', 'лер', 'дар', 'дер', 'тар', 'тер')
             for variants in CASE_FAMILIES.values() for case in variants]
SUFFIX_AFTER = re.compile(r"(?P<join>[-‐‑–'’]?)(?P<suffix>" +
                    "|".join(sorted(SUFFIXES, key=len, reverse=True)) + r")(?!\w)", re.I)


@lru_cache(maxsize=2048)
def phrase_pattern(phrase):
    return re.compile(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", re.I)


def hits(phrase, text):
    return list(phrase_pattern(phrase).finditer(text))


def metadata(record):
    result = dict(record.get("@metadata", {}))
    result.update(record.get("metadata", {}))
    return result


def applicable(entry, record):
    return (not entry.get("categories") or record.get("category", "") in entry["categories"]) and any(
        hits(form, record["source"]) for form in entry["source_forms"])


def term_forms(entry, form):
    """Opt-in, bounded inflection of the last word; no arbitrary suffix stripping."""
    if entry.get('inflect_native') is not True:
        return [form]
    prefix, _, last = form.rpartition(' ')
    return [(prefix + ' ' if prefix else '') + value for value in noun_forms(last)]


def protected_text(record, glossary=None, *, mask_slots=True):
    """Mask markup, URLs, slots and explicitly declared brands/names without changing offsets."""
    text = record["target"]
    for pattern in (ICU_QUOTED, re.compile(r"https?://\S+"), re.compile(r"""<(?:[^"'<>]|"[^"]*"|'[^']*')*>"""),
                    re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")):
        text = pattern.sub(lambda m: " " * len(m[0]), text)
    if mask_slots:
        text = DYNAMIC_SLOT.sub(lambda m: " " * len(m[0]), text)
    names = metadata(record).get("language_neutral_terms", [])
    if isinstance(names, list):
        for name in names:
            if isinstance(name, str) and name:
                text = phrase_pattern(name).sub(lambda m: " " * len(m[0]), text)
    if glossary:
        # An explicitly allowed term is not a language/orthography error. Protect
        # just that term: Russian/English prose around a brand remains detectable.
        allowed = {surface for entry in glossary['entries'] if applicable(entry, record)
                   for form in entry['allowed_forms'] for surface in term_forms(entry, form)}
        for form in sorted(allowed, key=len, reverse=True):
            text = phrase_pattern(form).sub(lambda m: ' ' * len(m[0]), text)
    return text


def language_hints(signals, lang):
    return [(word, LEXICAL_HINTS[word]) for word in signals[lang] if word in LEXICAL_HINTS]


def fragment_suggestion(hints):
    return ('Предлагаемые соответствия для фрагментов: ' +
        '; '.join(f'«{word}» → «{replacement}»' for word, replacement in hints[:3]) +
        '. Согласовать формы с предложением и сохранить подстановки; это не готовая замена всей строки.')


def foreign_fragments(record, masked):
    """Sentence-level evidence; a Kazakh sentence must not hide another language."""
    out = []
    for segment in re.finditer(r'[^.!?;:\n]+', masked):
        text = segment[0].strip()
        if not text or KK_LETTERS.search(text):
            continue
        words = [word[0].casefold() for word in WORD.finditer(text)]
        signals = {lang: sorted(set(words) & lexicon) for lang, lexicon in LANGUAGE_WORDS.items()}
        lang = max(signals, key=lambda value: len(signals[value]))
        hints = language_hints(signals, lang)
        if not hints or len(signals[lang]) < 2 or len(signals[lang]) / max(len(words), 1) < 0.5:
            continue
        start = segment.start() + len(segment[0]) - len(segment[0].lstrip())
        end = segment.end() - (len(segment[0]) - len(segment[0].rstrip()))
        out.append(finding(record, 'wrong_language',
            f'Фрагмент «{record["target"][start:end]}» [{start}:{end}] содержит лексические признаки {lang}: ' +
            '«' + '», «'.join(signals[lang]) + '». Проверен отдельный фрагмент; язык всей строки не утверждается.',
            fragment_suggestion(hints), 0.75, 'high'))
    return out


def analyze_record(record, glossary, *, proposals=None):
    target = record["target"]
    masked = protected_text(record, glossary)
    meta = metadata(record)
    out = []
    if meta.get("language_neutral") is True:
        return out
    out.extend(morphology_diagnostics(record, masked))
    draft = glossary["status"] == "draft"
    for entry in glossary["entries"]:
        if not applicable(entry, record):
            continue
        for bad, good in entry.get("forbidden_forms", {}).items():
            for m in hits(bad, masked):
                note = "Черновой глоссарий, требуется согласование" if draft else "Согласованный глоссарий"
                out.append(finding(record, "glossary_violation",
                    f'{note}: понятие «{entry["id"]}», в переводе «{m[0]}» [{m.start()}:{m.end()}], задано «{good}».',
                    f'Заменить термин «{m[0]}» на «{good}» с сохранением нужной грамматической формы.',
                    0.65 if draft else 0.9))
    for bad, good in SPELLING.items():
        for m in hits(bad, masked):
            out.append(finding(record, "orthography",
                f'Подозрительное написание «{m[0]}» [{m.start()}:{m.end()}]; словарная подсказка модуля: «{good}».',
                f'Вместо «{m[0]}» использовать «{good}», сохранив регистр начала предложения.', 0.85, "low"))
            if proposals is not None:
                candidate = spelling_proposal(record, len(out) - 1, m.start(), m.end(), good)
                if candidate:
                    proposals.append(candidate)
    for m in WORD.finditer(masked):
        word = m[0]
        if not re.search('[A-Za-z]', word) or not re.search('[А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]', word):
            continue
        corrected = word.translate(HOMOGLYPHS)
        # No generic "mixed script is wrong" rule: require an exact known word.
        if corrected.casefold() not in KNOWN_WORDS or corrected == word:
            continue
        proof = '; '.join(f'«{a}» U+{ord(a):04X} → «{b}» U+{ord(b):04X}'
                          for a, b in zip(word, corrected) if a != b)
        out.append(finding(record, 'orthography',
            f'В слове «{word}» [{m.start()}:{m.end()}] смешаны латиница и кириллица: {proof}. После замены получается известное написание «{corrected}».',
            f'Использовать «{corrected}» вместо «{word}».', 0.9, 'low'))
        if proposals is not None:
            candidate = spelling_proposal(record, len(out) - 1, m.start(), m.end(), corrected)
            if candidate:
                proposals.append(candidate)
    for m in HIDDEN_WORD.finditer(masked):
        corrected = m[0].translate({ord(char): None for char in HIDDEN_LETTERS})
        if corrected.casefold() not in KNOWN_WORDS:
            continue
        proof = ', '.join(f'U+{ord(char):04X} в позиции {m.start() + index}'
                          for index, char in enumerate(m[0]) if char in HIDDEN_LETTERS)
        out.append(finding(record, 'orthography',
            f'Внутри фрагмента «{m[0]}» [{m.start()}:{m.end()}] присутствуют невидимые форматирующие символы: {proof}. После их удаления получается известное написание «{corrected}».',
            f'Проверить назначение невидимых символов внутри слова и использовать «{corrected}», если они не предусмотрены интерфейсом.',
            0.85, 'low'))
        # No whole-string candidate: format controls require deliberate human review.
    # Exact, contextual calque: possession of a choice. Never infer "machine generated" as a fact.
    m = re.fullmatch(r"\s*Сіз таңдауды жасадыңыз[.!]?\s*", target, re.I)
    if m and re.fullmatch(r"\s*Вы сделали выбор[.!]?\s*", record["source"], re.I):
        out.append(finding(record, "machine_translation_suspect",
            'Оборот «таңдауды жасадыңыз» буквально воспроизводит «сделали выбор»; возможна более естественная глагольная конструкция. Происхождение перевода не установлено.',
            'Сіз таңдау жасадыңыз.', 0.65, "low"))
    visible = protected_text(record, mask_slots=False)
    for token in DYNAMIC_SLOT.finditer(visible):
        if token[0] == '%%':
            continue
        m = SUFFIX_AFTER.match(visible, token.end())
        if not m:
            continue
        slot = token['name'] or token[0]
        slot_meta = meta.get("placeholders", {})
        slot_meta = slot_meta.get(slot, {}) if isinstance(slot_meta, dict) else {}
        if isinstance(slot_meta, dict) and slot_meta.get("suffix_handled_by_runtime") is True:
            continue
        out.append(finding(record, "suffix_harmony",
            f'Фрагмент «{target[token.start():m.end()]}» [{token.start()}:{m.end()}]: фиксированный аффикс «{m["suffix"]}» после динамического значения. Его применимость зависит от произношения подставленного значения; ошибка для всех значений не утверждается.',
            f'Передать выбор аффикса после {token[0]} морфологическому форматтеру по произношению значения; в шаблоне не закреплять «{m["suffix"]}». Альтернатива — перестроить фразу без склонения подстановки.',
            0.85))
    words = [m[0].casefold() for m in WORD.finditer(masked)]
    # Absence of Kazakh-specific letters alone is never an error.
    folded = masked.strip().casefold().rstrip(".!?")
    signals = {lang: sorted(set(words) & lexicon) for lang, lexicon in LANGUAGE_WORDS.items()}
    context = record.get('context', {})
    references = context.get('references', {}) if isinstance(context, dict) else {}
    if not isinstance(references, dict):
        references = {}
    normalize = lambda s: unicodedata.normalize('NFC', s).strip().casefold()
    reference_match = next(((language, locale) for locale, reference in sorted(references.items(), key=lambda item: str(item[0]))
        if isinstance(locale, str) and isinstance(reference, str)
        and (language := locale.lower().replace('_', '-').split('-')[0]) in {'en', 'uz'}
        and normalize(target) == normalize(reference) and normalize(target) != normalize(record['source'])
        and len(words) >= 2 and sum(map(len, words)) >= 8 and signals[language]
        and not KK_LETTERS.search(masked)), None)
    lang = max(signals, key=lambda x: len(signals[x]))
    exact_ui = folded in UI_TRANSLATIONS
    hints = language_hints(signals, lang)
    if reference_match:
        lang = reference_match[0]
        hints = language_hints(signals, lang)
    if exact_ui or (reference_match and hints) or (hints and len(signals[lang]) >= 2 and len(signals[lang]) / max(len(words), 1) >= 0.35 and not KK_LETTERS.search(masked)):
        evidence = f'В тексте для {record["locale"]} обнаружены лексические признаки {lang}: «' + '», «'.join(signals[lang]) + '». Это эвристика, а не полноценное распознавание языка.'
        if reference_match:
            evidence += f' Весь target после NFC/trim/casefold совпадает с дополнительным переводом references.{reference_match[1]}: «{target}»; с RU-исходником он не совпадает.'
        suggestion = UI_TRANSLATIONS.get(folded)
        if suggestion is None:
            suggestion = fragment_suggestion(hints)
        out.append(finding(record, "wrong_language", evidence, suggestion, 0.9 if exact_ui else 0.75, "high"))
    else:
        out.extend(foreign_fragments(record, masked))
    return out


def term_contexts(records, glossary):
    """Only explicitly declared concept variants; no comparing arbitrary inflected text."""
    groups = {}
    for index, record in enumerate(records):
        if metadata(record).get('language_neutral') is True:
            continue
        masked = protected_text(record)
        for entry in glossary["entries"]:
            if entry.get("consistent") is not True or not applicable(entry, record):
                continue
            matched = sorted(((m.start(), m.end(), form, variant)
                for lemma, variant in entry.get('variants', {}).items()
                for form in term_forms(entry, lemma) for m in hits(form, masked)),
                key=lambda x: (-(x[1] - x[0]), x[0], x[2]))
            occupied = []
            for start, end, form, variant in matched:
                if not any(start < b and end > a for a, b in occupied):
                    occupied.append((start, end))
                    scope = "все разделы" if entry.get("consistency_scope") == "global" else record.get("category", "")
                    group = (entry["id"], record["locale"].replace("_", "-").lower(), scope)
                    groups.setdefault(group, []).append({"record_index": index, "key": record["key"],
                        "occurrence": record["occurrence"], "form": form, "variant": variant})
    contexts = [[] for _ in records]
    findings = [[] for _ in records]
    by_id = {e["id"]: e for e in glossary["entries"]}
    for (concept, _, category), matches in sorted(groups.items()):
        ordered = sorted(matches, key=lambda x: (x["key"], x["occurrence"], x["form"], x["record_index"]))
        variants = sorted({x["variant"] for x in ordered})
        if len(variants) < 2 or len({x["record_index"] for x in ordered}) < 2:
            continue
        witnesses = [next(x for x in ordered if x["variant"] == v) for v in variants]
        public_witnesses = [{k: v for k, v in x.items() if k != "record_index"} for x in witnesses]
        for index in sorted({x["record_index"] for x in ordered}):
            contexts[index].append({"concept": concept, "category": category, "witnesses": public_witnesses})
            proof = "; ".join(f'{x["key"]}#{x["occurrence"]}: «{x["form"]}»' for x in witnesses)
            note = " (черновой глоссарий)" if glossary["status"] == "draft" else ""
            findings[index].append(finding(records[index], "inconsistent_term",
                f'Для понятия «{concept}» в разделе «{category}» заданы разные терминологические варианты{note}: {proof}. Формы одной леммы объединены по variant.',
                f'Унифицировать понятие «{concept}» по варианту «{by_id[concept]["preferred"]}» с необходимыми окончаниями; подтвердить термин у команды.',
                0.6 if glossary["status"] == "draft" else 0.8))
    return contexts, findings
