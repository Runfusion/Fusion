---
"@runfusion/fusion": patch
---

summary: Fix the Quick Add model dropdown filter box so typing narrows the model list.
category: fix
dev: The quick-entry model menu's blanket onMouseDown preventDefault crossed the React portal boundary and suppressed focus on CustomModelDropdown's search input.
