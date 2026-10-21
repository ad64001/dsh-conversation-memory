DSH conversation memory 0.4.2-cachefix.5

Conversation memory for DeepSeek Harness.
Store original context locally, search through multiple query paths, and read
exact sources through citations after context compaction. Each conversation
uses an independent SQLite library; local retrieval requires no subagent or ES.

Windows desktop integration for DSH 0.2.1-rc.2.
Use README.md and docs/INSTALL.zh-CN.md at the repository root.
Install/check/rollback: node scripts/install.cjs --help

The active conversation provider/model decides semantic deduplication and
candidate order. The host validates exact originals, provenance and budgets.
User correction originals take priority. The complete conversation index stays
in the local library and is read on demand with [n] references.

Tool trigger >8192 code points; output <=5159; memory provider <=6000.
Dedup helper: 180 seconds/call and 300 seconds/plan, unchanged 16384-token cap.
Failed recall retries are bounded; partial worker evidence can survive a parent wait timeout.
Critical evidence omissions reject semantic replacements; native Basic fallback is retained.
Tool arguments are assistant-origin evidence with call/result links and additive legacy backfill.

Validated with opencode-go/deepseek-v4.1-flash: 367 local tests and three fresh
native compactions. Maintenance, key original-source read-back and answer
checks completed in all three windows. See docs/GO_PRESSURE_CACHEFIX5.md for
usage measurements and scope, and docs/VALIDATION.md for historical results.

Do not install the preset snapshot directly over a customized profile.
The installer uses the native parser to preserve current preset configuration.

cachefix.5: Shared evidence budgets, bounded post-compaction maintenance, and
one-time background repair. See docs/CACHEFIX5_MAINTENANCE.md.
