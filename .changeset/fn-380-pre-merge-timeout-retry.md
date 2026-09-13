---
"@runfusion/fusion": patch
---

summary: Retry a timed-out workflow review once before leaving its gate blocked.
category: fix
dev: Uses a distinct configured fallback when available, otherwise a fresh same-model session.
