---
"@runfusion/fusion": patch
---

summary: The Reliability panel's in-review duration metric now works on a board with renamed lanes.
category: fix
dev: `getInReviewDurationEvents` had `in-review` and `done` baked into a raw `sql` predicate — invisible to both the lifecycle census and the unwired-lane-parameter guard — so it stayed blind after #2861 fixed the panel's other two inputs. The lanes are now resolved once per call via `resolveProjectColumnsForRoles` and passed in as parameterised equality fragments, defaulting to the legacy ids.
