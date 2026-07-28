---
"@runfusion/fusion": patch
---

summary: Reviews stalled by an engine restart now recover in one self-healing cycle instead of ~36 minutes.
category: fix
dev: Moves `reconcile-orphaned-pending-step-results` ahead of `recover-failed-pre-merge-steps` in the periodic maintenance list (it produces the `failed` results that step consumes; it previously ran ~15 entries later, so an orphan found in cycle N was not re-dispatched until cycle N+1) and removes the now-duplicated later entry. Raises the `maxPostReviewFixes` default 3 -> 10 and routes the five inline `?? 3` fallbacks in executor.ts/self-healing.ts through the new exported `DEFAULT_MAX_POST_REVIEW_FIXES` so the declaration default and the unset-settings paths cannot drift again. Plan Review and Code Review are unaffected — they already resolve to "unbounded" when unset.
