DSH conversation memory 0.4.2-cachefix.4

Experimental Windows desktop integration for DSH 0.2.1-rc.2.
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

Tested with opencode-go/deepseek-v4.1-flash. See docs/VALIDATION.md for the
one preserved native semantic-pass cancellation and other honest boundaries.
The plugin does not guarantee lossless recall or universal model compatibility.

Do not install the preset snapshot directly over a customized profile.
The installer uses the native parser to preserve current preset configuration.

cachefix.4: 原生事件排序、旧背景修复、结构化关键组、查询续跑及取消保护；固定模型提示词与运行时状态使用英文。详见 docs/CACHEFIX4_RECHECK.md。
