---
"@runfusion/fusion": minor
---

summary: Price each part of a remote agent session at the rates in effect when that work happened.
category: fix
dev: Operator decision F1=3. Migration 0091 records the usage delta each revision adds with the rates applicable then, so a model or rate change mid-session no longer reprices earlier work. Backwards counters are dropped as unknown rather than recorded as negative usage.
