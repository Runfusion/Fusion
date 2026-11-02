---
"@runfusion/fusion": patch
---

summary: Fix Code Review wedging forever on an oversized diff caused by a stale review diff base.
category: fix
dev: The review/merge diff base now resolves to the integration fork point (descendant of the local and origin merge-bases) instead of preferring origin/main; the review-input fingerprint hashes `git diff --binary` as a stream under the same 10 MiB bound, so no diff can hit the old maxBuffer class; a `review-input-unprovable` refusal records its reason on the step row instead of `(no feedback captured)`.
