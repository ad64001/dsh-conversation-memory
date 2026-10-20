# cachefix.5: three fresh Go compactions

Runtime: [5e6cb70](https://github.com/ad64001/dsh-conversation-memory/commit/5e6cb704ee42f4870f92c1e0fda77ad2a1794408) (same tree as local 4d7534599b29557910d5af2a77ea926177dc816e). Model: `opencode-go/deepseek-v4.1-flash`. Native DSH session: `session-5a88a2d9-a356-472d-9c63-bac1876edfe3`.

This run used three native automatic compaction windows in one new session, fresh synthetic facts and generated fixtures. Native thresholds, model defaults, tools and the workload generator were kept unchanged. This is an observational comparison with the preceding cachefix.4 rerun, not a controlled A/B or three independent experiments.

| Usage scope | Previous cachefix.4 rerun | cachefix.5 | Cache-read / prompt tokens | Known / observed requests |
|---|---:|---:|---:|---:|
| Normal continuations, all attempts including native retries | 82.02% | 98.95% | 1337984 / 1352246 | 6 / 6 |
| All main requests | 73.15% | 79.75% | 8790912 / 11023475 | 42 / 42 |
| All requests including auxiliaries | 66.67% | 72.50% | 8796800 / 12132976 | 55 / 55 |
| First main attempt after compaction | 1.00% | 0.65% | 3968 / 614874 | 3 / 3 |
| First main request finishing with stop after compaction (excludes tool-calls) | 34.45% | 32.76% | 202624 / 618596 | 3 / 3 |

Ratios are `sum(cacheRead) / sum(input + cacheRead + cacheWrite)`, not means of percentages. Unknown usage is excluded from the token denominator and retained as unknown. First-attempt and first-success views remain separate. The legacy firstSuccessfulMain field selects finish.kind=stop and excludes successful tool-call responses; it is not a first-non-error metric. Unknown-usage request IDs: none. Full usage: [CSV](GO_PRESSURE_CACHEFIX5_USAGE.csv); checks and source hashes: [JSON](GO_PRESSURE_CACHEFIX5_SUMMARY.json).

## Maintenance and memory

- Native compactions: 3 successful, 0 failed.
- Maintenance completed before the next window or run end: **3/3**; pending at end: **false**.
- `MEMORY_DEDUP_OUTPUT_LIMIT`: **0**.
- Strict search-then-read original-source chain: **3/3**. Strict answer checks: **3/3**.
- Exact source archive: **50/50** originals matched native events byte-for-byte.
- Normal request prefix preservation: **6/6** attempts.

All final cited references were explicitly memory_read in **2/3** cycles; all cited canonical bodies were delivered in **3/3**. Extra cited bodies supplied by search remain distinct from explicit read calls.

At run end, ordinary-turn automatic recall was incomplete under its 500 ms wait budget. That local query may remain partial; the separately tracked compaction maintenance completed all nine queries in every window and had no pending work.

Maintenance completion, correct answers, and KV hit rates are separate checks. Native summaries can also support answers; this run does not isolate the plugin's causal contribution. The temporary preset and observers were removed, and installed desktop plugin files were not changed.

## Scope of the repair

See [implementation and offline validation](CACHEFIX5_MAINTENANCE.md). The shared budget prevents admitting a required packet that cannot pass consolidation. A bounded post-compaction query window avoids reliance on extra model tool steps. Removing repeated full-store repair prevents archive work from consuming the search deadline. 367 local tests passed with native integration enabled and zero skips.

The earlier 0.83% request retained its full client message prefix, tools, route, parameters and affinity header. Its server-side cause is not established. These changes do not directly control hosted KV cache residency or guarantee future hit rates.
