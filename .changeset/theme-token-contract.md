---
"@runfusion/fusion": minor
---

summary: Add stable dashboard theme tokens and plugin overlay layering with --fusion-max-z.
category: feature
dev: `--fusion-max-z` is synced from `floatingWindowStack.ts` with an 11001 floor; `#plugin-overlay-root` is a click-through fixed mount point; the contract is documented and guarded by a docs-to-CSS sync test.
