---
"@runfusion/fusion": patch
---

summary: Fix a chat crash in Firefox when opening conversations that contain long slash-heavy file path lists.
category: fix
dev: Rewrote `FILE_PATH_REGEX` in `packages/dashboard/app/utils/filePathLinkify.tsx` to be backtracking-linear. The old main branch `(?:[A-Za-z0-9_./@-]+\/)+` let each segment contain `/`, so slash-heavy near-misses (e.g. `STAS-001/002/.../057` without a trailing extension) had exponentially many partitions; SpiderMonkey's recursive backtracker threw `InternalError: too much recursion` while linkifying ~80KB assistant messages, tearing the chat view down through the ErrorBoundary. The new form makes each iteration consume exactly one `/` and widens the start lookbehind to `[\w@/.-]` so URL tails cannot begin links. Matching output is unchanged on real content (verified identical ranges/captures). Regression tests guard the exact crash line plus an adversarial 500-slash canary.
