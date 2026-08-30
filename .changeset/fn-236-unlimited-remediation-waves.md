---
"@runfusion/fusion": patch
---

summary: Keep creating review fix steps beyond three rounds while actionable evidence changes.
category: fix
dev: Removes `released-wave-exhausted` and the hard-coded wave cap; adds output-derived `evidenceDigest` and `released-verification-no-progress`, workspace unchanged-input parity, and Code Review attempt-ledger writes that enforce authored `maxRevisions`.
