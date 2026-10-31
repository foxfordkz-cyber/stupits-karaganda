"""Conservative diagnostics. No general spell checker or measured quality score."""
import re
from .contracts import finding

RULES_VERSION = "kk-conservative-1.0"
PLACEHOLDER = re.compile(r"\{[A-Za-z_][A-Za-z_0-9]*\}")
WORD = re.compile(r"[^\W\d_]+(?:['’ʻ‘][^\W\d_]+)*", re.UNICODE)
KK_LETTERS = re.compile("[әғқңөұүһі]", re.I)
# Small generic examples authored for this module, not extracted from supplied data.
SPELLING = {"сәлеметсізбе": "сәлеметсіз бе", "кош келдіңіз": "қош келдіңіз",
            "ойыншынын": "ойыншының", "сыйлык": "сыйлық", "кауіпсіздік": "қауіпсіздік"}
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
SUFFIX = re.compile(r"(?P<slot>\{[A-Za-z_][A-Za-z_0-9]*\})(?P<join>[-‐‑–'’]?)(?P<suffix>" +
                    "|".join(sorted(SUFFIXES, key=len, reverse=True)) + r")(?!\w)", re.I)


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


def protected_text(record):
    """Mask markup, URLs, slots and explicitly declared brands/names without changing offsets."""
    text = record["target"]
    for pattern in (PLACEHOLDER, re.compile(r"https?://\S+"), re.compile(r"<[^>]*>")):
        text = pattern.sub(lambda m: " " * len(m[0]), text)
    names = metadata(record).get("language_neutral_terms", [])
    if isinstance(names, list):
        for name in names:
            if isinstance(name, str) and name:
                text = phrase_pattern(name).sub(lambda m: " " * len(m[0]), text)
    return text


def analyze_record(record, glossary):
    target = record["target"]
    masked = protected_text(record)
    meta = metadata(record)
    out = []
    if meta.get("language_neutral") is True:
        return out
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
    # Exact, contextual calque: possession of a choice. Never infer "machine generated" as a fact.
    m = re.fullmatch(r"\s*Сіз таңдауды жасадыңыз[.!]?\s*", target, re.I)
    if m and re.fullmatch(r"\s*Вы сделали выбор[.!]?\s*", record["source"], re.I):
        out.append(finding(record, "machine_translation_suspect",
            'Оборот «таңдауды жасадыңыз» буквально воспроизводит «сделали выбор»; возможна более естественная глагольная конструкция. Происхождение перевода не установлено.',
            'Сіз таңдау жасадыңыз.', 0.65, "low"))
    for m in SUFFIX.finditer(target):
        slot = m["slot"][1:-1]
        slot_meta = meta.get("placeholders", {})
        slot_meta = slot_meta.get(slot, {}) if isinstance(slot_meta, dict) else {}
        if isinstance(slot_meta, dict) and slot_meta.get("suffix_handled_by_runtime") is True:
            continue
        out.append(finding(record, "suffix_harmony",
            f'Фрагмент «{m[0]}» [{m.start()}:{m.end()}]: фиксированный аффикс «{m["suffix"]}» после динамического значения. Его применимость зависит от произношения подставленного значения; ошибка для всех значений не утверждается.',
            f'Передать выбор аффикса после {m["slot"]} морфологическому форматтеру по произношению значения; в шаблоне не закреплять «{m["suffix"]}». Альтернатива — перестроить фразу без склонения подстановки.',
            0.85))
    words = [m[0].casefold() for m in WORD.finditer(masked)]
    # Absence of Kazakh-specific letters alone is never an error.
    folded = masked.strip().casefold().rstrip(".!?")
    signals = {lang: sorted(set(words) & lexicon) for lang, lexicon in LANGUAGE_WORDS.items()}
    lang = max(signals, key=lambda x: len(signals[x]))
    exact_ui = folded in UI_TRANSLATIONS
    hints = [(w, LEXICAL_HINTS[w]) for w in signals[lang] if w in LEXICAL_HINTS]
    if exact_ui or (hints and len(signals[lang]) >= 2 and len(signals[lang]) / max(len(words), 1) >= 0.35 and not KK_LETTERS.search(masked)):
        evidence = f'В тексте для {record["locale"]} обнаружены лексические признаки {lang}: «' + '», «'.join(signals[lang]) + '». Это эвристика, а не полноценное распознавание языка.'
        suggestion = UI_TRANSLATIONS.get(folded)
        if suggestion is None:
            suggestion = 'Предлагаемые соответствия для фрагментов: ' + '; '.join(f'«{w}» → «{v}»' for w, v in hints[:3]) + '. Согласовать формы с предложением и сохранить подстановки; это не готовая замена всей строки.'
        out.append(finding(record, "wrong_language", evidence, suggestion, 0.9 if exact_ui else 0.75, "high"))
    return out


def term_contexts(records, glossary):
    """Only explicitly declared concept variants; no comparing arbitrary inflected text."""
    groups = {}
    for index, record in enumerate(records):
        for entry in glossary["entries"]:
            if entry.get("consistent") is not True or not applicable(entry, record):
                continue
            for form, variant in entry.get("variants", {}).items():
                if hits(form, protected_text(record)):
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
