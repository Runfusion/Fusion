---
"@runfusion/fusion": patch
---

summary: Move mobile terminal controls into a bottom footer so they no longer crowd the header, with a scrollable shortcut bar.
category: fix
dev: On the ≤768px terminal, the `.terminal-actions` cluster now renders in a `terminal-footer-actions` bar (with `min-width:0; overflow-x:auto`) instead of the header; desktop/floating/pinned-below keep the FN-7502 header layout. Preserves the FN-7550 shortcut-panel scroll fix.
