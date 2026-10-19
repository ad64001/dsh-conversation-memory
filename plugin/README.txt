DSH conversation memory 0.4.2

Experimental Windows desktop integration for DSH 0.2.1-rc.2.
Use README.md and docs/INSTALL.zh-CN.md at the repository root.
Install/check/rollback: node scripts/install.cjs --help

The active conversation provider/model decides semantic deduplication and
candidate order. The host validates exact originals, provenance and budgets.
User correction originals take priority. The complete conversation index stays
in the local library and is read on demand with [n] references.

Tool trigger >8192 code points; output <=5159; memory provider <=6000.
Dedup helper: 180 seconds/call and 300 seconds/plan, unchanged 16384-token cap.
Existing semantic selection/indexing and native Basic flow are unchanged.

Tested with opencode-go/deepseek-v4.1-flash. See docs/VALIDATION.md for the
one preserved native semantic-pass cancellation and other honest boundaries.
The plugin does not guarantee lossless recall or universal model compatibility.

Do not install the preset snapshot directly over a customized profile.
The installer uses the native parser to preserve current preset configuration.
