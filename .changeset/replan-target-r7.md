---
"@runfusion/fusion": patch
---

summary: A rejected plan on a custom workflow goes back to that workflow's own planning column, not one it does not have.
category: fix
dev: U7 / R7, re-landed on main after the stacked chain was closed. `resolveReplanTargetColumn` returned `triage` by fiat for any workflow declaring neither legacy id (builtin:marketing, every renamed set), moving the card into an undeclared column for `reconcileUndeclaredTaskColumns` to clean up. Legacy ids stay preferred first so both coding built-ins keep their exact target; only a workflow declaring neither reaches the trait fallback, which prefers HOLD over intake (Coding (Ideas)' intake is manual-capture with no AI, so a rejected plan sent there stops being replanned). No declared lane returns undefined and all callers park visibly. Also corrects an inverted U11 note in that function: #2515 keeps `todo` and deletes `triage`, not the reverse.
