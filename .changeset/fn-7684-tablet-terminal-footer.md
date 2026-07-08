---
"@runfusion/fusion": patch
---

summary: On tablet widths, move terminal shortcuts/zoom controls into the bottom footer so they no longer overlap header icons.
category: fix
dev: Adds an isTabletTerminal flag (769–1024px, non-mobile) that renders the shared terminalActionControls fragment in the .terminal-status-bar footer (as FN-7560 did for mobile) instead of the header; true desktop (>1024px) keeps the header layout. Tablet footer keeps the desktop pin/pop-out toggles.
