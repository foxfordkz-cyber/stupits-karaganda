# Lexical semantic diagnostics

Local rules now align a small RU possession construction with its KK subject and object
before checking `бар` versus `жоқ`. Questions, compound sentences, quoted claims,
unmatched subjects/objects and unknown concepts are outside that rule. This is a
bounded polarity check, not general semantic equivalence or an automatic translation.

Two source-supported calque families cover verb inflections of making a choice and
accepting participation. Findings request native review and do not assert MT provenance.
Source-supported unique adjacent-letter transpositions produce spelling suggestions.
Mixed sentences require at least two distinct neighboring foreign lexical markers;
single loanwords, repetition, explicitly neutral terms and quoted fragments abstain.

No fixture ID participates in any rule. Negative tests cover correct polarity, natural
alternatives, literal creation/acceptance, unrelated concepts, names and protected text.
The unchanged 77-case development set improves from TP37/FP0/FN5 (56e0e36) to
TP42/FP0/FN0. This set informed development; its perfect score is not a generalization
or Grand Mobile accuracy claim. A separate post-freeze synthetic evaluation is required.

General negation scope, modal verbs, changed quantities, idioms and arbitrary grammatical
errors remain beyond offline rules. Existing optional subprocess protocol `bekzat-mqm-1.2`
now explicitly asks for aligned semantic evidence, negation scope and abstention. The
provider, actual usage, budget, bounded output and consent requirements remain unchanged.
No new vendor dependency, model call or paid evaluation is included. Model instructions
are tested structurally; their linguistic effectiveness is not measured here.
