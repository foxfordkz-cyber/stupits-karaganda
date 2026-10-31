# Bounded morphology diagnostics

Version 1.4 adds native noun case diagnostics to the existing dynamic-slot risk rule.
Only nine explicitly listed stems are supported. Last-vowel harmony and the final
consonant determine the dative, genitive, accusative, locative and ablative variants.
Plural paradigms are generated for terminology matching; possessives and arbitrary
word segmentation are deliberately outside this analyzer.

The grammatical basis is [Emle / Til-Qazyna, case category](https://emle.kz/kz/rule?id=126),
S. Isayev's description: last-syllable harmony, consonant assimilation and distinct
possessive declension. The implementation is our bounded interpretation, not code or
a validated analyzer from that source. No source text or private dictionary is copied.

Examples: `кілтге` suggests checking `кілтке`; `ойыншыдың` suggests `ойыншының`.
These are `suffix_harmony` findings with exact Unicode codepoint spans and no automatic
rewrite. Correct noun paradigms, proper names, unknown loanwords, possessives, URLs,
markup attributes and explicitly neutral text are regression negatives.

Unknown names (Kazakh or Russian), abbreviations, slang and borrowed game terms cannot
be declined from spelling alone. They are left undecided. `{name}-ға`, `%s-ке` and
`{name}-лардың` instead request runtime morphology based on the rendered pronunciation,
or a label-style rewrite without inflecting the value. No replacement suffix is guessed.
Runtime suppression remains explicit and specific to the named placeholder.

Run from `modules/language`: `python -m unittest discover -s tests -p test_morphology.py`.
Seven tests exercise positive errors, complete generated negative paradigms, names,
protected text, plural-case placeholders and slot-specific suppression. Linguistic
acceptance still requires Aidana/native review; confidence is uncalibrated.
