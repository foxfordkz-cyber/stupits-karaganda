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

## Terminology opt-in

A local JSON glossary entry may set `inflect_native: true`. This expands the last word
of each allowed form and consistency variant only when it belongs to the bounded native
lexicon. For example, `көлікке` and `көліктердің` share the declared `көлік` variant.
The default is false, preserving existing explicit-form policy. CSV imports do not enable it.
Source forms remain explicit (including Russian inflections); category and target locale
still isolate contexts. Only `consistency_scope: global` intentionally crosses categories.

Allowed synonyms should map to the same value in `variants`; different declared values
produce occurrence-specific witnesses across at least two input records. Longest matching
phrases take precedence. Unknown words, derivation and possessives are not stemmed.
Grand Coins, ГК, варн, мут and фура require no blanket prohibition: explicit allowed terms
are protected, while foreign prose around them remains eligible for language detection.
No terminology approval or rule is inferred from free-text descriptions/comments.
The nine-field shared finding and bundle schemas are unchanged.
