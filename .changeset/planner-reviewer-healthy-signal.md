---
"@runfusion/fusion": patch
---

summary: Stop the planner overseer from posting a steering comment on every tick to a task whose review is simply open.
category: fix
dev: `decidePlannerRecovery` injected guidance at the reviewer stage for any signal, including `progressing`. A healthy signal also clears `PlannerRecoveryController`'s attempt registry (FN-7577), so the three-attempt budget never filled and one task received a steering comment every ~45 s tick for twelve days (22,499 copies in `comments` and `steering_comments`; each append rewrote both arrays and the `search_vector` GIN entries). The reviewer stage now steers only on a problem signal (`stuck`, `blocked` or `failed`); `failed` keeps steering rather than reaching the executor's targeted-fix branch.
