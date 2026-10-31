# Advanced diagnostics: declared synthetic quality

Diagnostic rules were frozen at `fdd5bfd` before the new challenge was written and
scored. Later cache/handoff changes do not tune rules against its outputs. Cases and
labels are versioned and hash-locked in tests. This is **not an independently authored
or native-reviewed holdout**: the same AI wrote the engine and the new examples.
It is a separate, one-use post-freeze challenge with explicit author bias. An external
native-labeled holdout is still required before claiming generalization.

New dataset: 63 invented records, 28 declared issue labels, all six categories, no
private ARB-derived text. SHA-256 of canonical cases/glossary:
`b2575464d696a0d113afcfd6ad1c4862aa90d69d454919bcf3d58d7cbfa7bb96`.
Unit: (record occurrence, issue_type); duplicate predictions count once.

| Engine | TP | FP | FN | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| Historical 1.1, 445079e | 2 | 1 | 26 | 66.67% | 7.14% | 12.90% |
| Previous 1.3.1, 56e0e36 | 5 | 0 | 23 | 100% | 17.86% | 30.30% |
| Candidate 1.4 | 23 | 0 | 5 | 100% | 82.14% | 90.20% |

| Candidate category | TP / FP / FN | Precision | Recall | F1 |
|---|---|---:|---:|---:|
| glossary_violation | 1 / 0 / 0 | 100% | 100% | 100% |
| inconsistent_term | 2 / 0 / 0 | 100% | 100% | 100% |
| machine_translation_suspect | 4 / 0 / 3 | 100% | 57.14% | 72.73% |
| orthography | 4 / 0 / 1 | 100% | 80% | 88.89% |
| wrong_language | 2 / 0 / 1 | 100% | 66.67% | 80% |
| suffix_harmony | 10 / 0 / 0 | 100% | 100% | 100% |

FN analysis: h025 lost prohibition, h026 reversed permission, h027 changed quantity,
h035 non-transposition typo, h043 one untranslated UI verb. These limitations remain
visible; labels were not changed and rules were not retuned. Historical FP h059 is
an ICU-quoted literal mistaken for a dynamic suffix. Previous/candidate FP are zero
on these examples, not proof of zero real-world false positives.

On the unchanged development set (77 cases, 42 labels): historical TP26/FP8/FN16,
previous TP37/FP0/FN5, candidate TP42/FP0/FN0. Candidate development P/R/F1=100%;
the known cases informed development, so no generalization claim follows from that.
All confidence numbers remain uncalibrated. No correction quality or human agreement
was measured. Exact per-category/confusion results and source fingerprints are emitted
to private `evaluation.json` on each run.

From `modules/language`, with read-only checkouts for the two baselines:

```sh
python benchmark/run.py --dataset holdout --baseline C:/path/to/56e0e36/modules/language --historical C:/path/to/445079e/modules/language --out C:/Temp/locqa-private/holdout-001 --sizes ""
python benchmark/run.py --baseline C:/path/to/56e0e36/modules/language --historical C:/path/to/445079e/modules/language --out C:/Temp/locqa-private/dev-001 --sizes 100,1000,5600
```

The worker imports each engine in an isolated subprocess against identical records
and glossary. Output contains commit, dirty status, Python source hashes, dataset hash,
measurements and confusion cases. Do not publish runtime outputs from real data.
Performance methodology and measured initial improvement: [PERFORMANCE.md](../PERFORMANCE.md).
All measurements here are offline: zero provider calls/$0 token charges, real LLM cost
and effectiveness unmeasured. No actual user decision or human approval was generated.
