# Batch persistence and failure handling

Profiling 100 invented records on Windows/Python 3.13 showed 1.487 of 2.405 seconds
inside 100 SQLite commits. Local results now commit in groups of 64, with a final
flush before reporting status. Model responses still commit immediately. One glossary
digest is reused across local cache keys; the `local-v2` cache namespace intentionally
invalidates old local entries once, without dropping or migrating databases.

A controlled exception flushes completed local work and releases the lock. An abrupt
process exit may lose at most 63 cheap local results since the last checkpoint. An
OS-crash regression verifies 64 of 70 results survive and the stale lock is not stolen.
After an actual crash, confirm the recorded process has stopped before manually
recovering the lock; do not delete a live process's lock. No new model requests are
allowed when cache persistence is unavailable. A failed final flush marks the run partial.

Oversized model payloads are rejected before request/token/cost counters are reserved;
the adapter is not invoked. Failure diagnostics expose only whitelisted reason codes,
including timeout and oversized responses; arbitrary exception text and stderr never
enter logs. Unknown post-launch usage remains unknown, rather than being reported free.
Network/service failures are adapter failures, with no automatic retries or hidden charges.

The same 100/1000/5600 synthetic records were processed cold and warm before/after
against pre-optimization `fdd5bfd`. Findings, occurrence indices and proposals were
byte-identical in all twelve outputs. Initial measured cold seconds: 2.649/28.461/138.944
before, 0.612/5.749/35.901 after. At 5600, the observed cold speedup was 3.87x.
Warm 5600: 24.762 to 23.818 seconds; no robust warm-cache speedup is claimed.
One run per phase on a loaded desktop with tracemalloc is not a p95 or service SLA.
Peak Python allocations were about 12.15 MiB, excluding native memory, RSS and input
loading. All warm runs hit 100% of records. Model requests and token charges were zero;
LLM cost per 1000 remains unmeasured. See benchmark/ADVANCED_RESULTS.md for final evidence.

Reproduce from `modules/language`, always outside Git with a new output directory:

```sh
python benchmark/run.py --out C:/Temp/locqa-private/perf-001 --sizes 100,1000,5600
python benchmark/sequential.py --out C:/Temp/locqa-private/files-001
```

Sequential processing uses one cache for three files, with expected hits 0/100, 50/100,
100/100 and identical first/replay output. Consistency is recomputed within each call;
to compare terms across files, supply their prepared records together, respecting the
50000-record/64-MiB limits. The engine remains deterministic and single-writer.
