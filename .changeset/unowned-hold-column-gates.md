---
"@runfusion/fusion": patch
---

summary: Gridlock detection and mission-autopilot retries now work on boards whose columns are renamed.
category: fix
dev: U7 / R3, R7 — unowned drift-review sites. `gridlock-detector` filtered schedulable cards by `column !== "todo"` AND active cards by `in-progress`/`in-review` literals; on a renamed workflow both sets were empty and each empty set is an early return, so the detector reported "no gridlock" on exactly the boards where every card was stuck. `mission-autopilot`'s retry compared and moved to the literal `todo`, relocating the card into a column the workflow may not declare on every retry; it now resolves the hold role and leaves the card in place when none is declared. Measured on main: `column === / !== "todo" | "triage"` 103 -> 101.
