---
"@runfusion/fusion": minor
---

summary: Add `fn pr mergeability`, a deterministic PR conflict classifier for humans and scheduled steps.
category: feature
dev: GitHub `mergeable == "CONFLICTING"` is the only conflict authority; `mergeStateStatus` (`BLOCKED`/`BEHIND`/`UNKNOWN`) is evidence only. Optional `--merge-tree` corroborates offline and prints `DISAGREE:` instead of choosing a winner. Core seam: `packages/core/src/merge/pr-mergeability.ts`.
