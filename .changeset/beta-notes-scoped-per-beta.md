---
"@runfusion/fusion": patch
---

summary: Beta release notes now list only that beta's changes; stable notes roll up the whole beta cycle.
category: fix
dev: `scripts/release.mjs` scopes distillation input via `selectChannelChangesets` against pre.json's consumed-changesets ledger; stable keeps the full preserved set.
