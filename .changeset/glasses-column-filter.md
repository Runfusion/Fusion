---
"@runfusion/fusion": patch
---

summary: The glasses board API's `?columns=` filter now works on boards with custom lane names.
category: fix
dev: `fusion-plugin-even-realities-glasses` validated `?columns=` against a hardcoded six-id allow-list (still naming the deleted `triage`). On a renamed board every requested id was discarded and the parser's "nothing valid" result is indistinguishable from "no filter requested", so the route returned the entire board with a 200. The allow-list is deleted; ids are filtered directly, and an unknown column now yields an empty deck.
