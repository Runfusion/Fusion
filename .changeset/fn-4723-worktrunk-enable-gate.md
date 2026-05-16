---
"@runfusion/fusion": patch
---

Gate `worktrunk.enabled` behind verified binary availability. The dashboard settings API, Settings modal, and CLI now reject or prevent enabling worktrunk until the pinned/selected binary resolves and probe-verifies, while still allowing unconditional disable for recovery.
