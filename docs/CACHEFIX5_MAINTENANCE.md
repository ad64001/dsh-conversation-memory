# cachefix.5 maintenance repair

The cachefix.4 rerun exposed an admission/dedup budget mismatch, unfinished
post-compaction maintenance, and searches timing out before their first query.

## Changes

- Refresh and consolidation now use one packet budget. Policy, transport
  heading, coverage notice, separators and bounded status are priced before
  original evidence is admitted. Required source units remain exact and atomic;
  units that cannot fit remain available through their source references.
- A native compaction receives one bounded local search window before the next
  main request. The default maximum is 6 seconds (2 seconds × 3), capped at
  10 seconds. The existing 9-query plan can finish without requiring extra
  model tool steps. Explicit search retains its 500 ms default wait budget.
  Source/surface changes still invalidate stale plans; cancellation and route
  checks remain in force. Model dedup retains its separate existing limits.
- Full-store background repair runs at store startup and at the one-time
  provenance migration, rather than at every empty archive flush. Startup also
  reuses the repair result already computed by the library.
- Telemetry counts actual recall attempts, attributes maintenance to a native
  replacement generation, and distinguishes an old approved packet from current
  pending maintenance.

The original design remains: immutable conversation-local originals, SQLite
multiquery retrieval, references and explicit source read-back, and current-route
model approval before retiring/replacing historical memory. Ordinary model
requests keep their existing message prefix. No subordinate agent, ES service,
manual compaction, threshold change or direct server KV manipulation is added.

## Offline validation

367 tests passed, including embedded native Session integration, with no skips.
The new regressions cover production prompt budgeting with Unicode originals,
one-time migration, a slow nine-query plan finishing in one admission, and a
claimed user entering the native log only after that maintenance completes.

The same copied database from the failed real run was profiled before and after
the repair. Original files were not changed. Before: empty archive flush
899.55 ms; full search 995.01 ms. After: empty flush 6.88 ms; full search
117.49 ms. The repeated repair scan alone took about 900 ms. These are single
offline observations, not latency percentiles or a service guarantee.

## KV investigation

The prior low-hit continuation reported 1,920 cache-read tokens out of 231,843
prompt tokens (0.83%). Its complete prior message prefix, tools, endpoint,
model, max tokens, thinking configuration and session-affinity header matched.
The captured evidence does not identify the server-side cause. The following
continuation recovered a high hit rate. This repair cannot promise control over
provider cache residency or routing; new live measurements must be reported
separately from these offline results.
