---
"@runfusion/fusion": patch
---

summary: Keep the workflow selector in the top bar, left of search, instead of dropping below the header.
category: fix
dev: Extracts the shared `useHeaderWorkflowSlot` hook (synchronous resolve, bounded retry, MutationObserver for a late-mounted or replaced slot, detached-node guard) and wires Board, ListView, GraphWorkflowSwitcherSlot, and HeaderWorkflowSwitcherSlot to it. The inline fallback is retained for a genuinely absent slot.
