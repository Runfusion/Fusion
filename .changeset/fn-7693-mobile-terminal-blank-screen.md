---
"@runfusion/fusion": patch
---

summary: Fix the terminal rendering blank on mobile even though the shell prompt already loaded.
category: fix
dev: The global mobile `@media (max-width: 768px) { * { max-width: 100% } }` reset in styles.css also matched xterm's hidden character-measurement subtree (`.xterm-helpers` / `.xterm-char-measure-element`). That subtree's containing block is a 0x0 box, so `max-width: 100%` resolved to 0 and hard-capped xterm's character-cell measurement at 0 — FitAddon.fit() then proposed 0 columns and `.xterm-screen` (plus the WebGL canvas) collapsed to 0x0, so the prompt painted into a zero-size box. Exempt xterm's measurement subtree from that reset (`max-width: none`). Mobile-only; desktop was unaffected. Recurrence of FN-7620/FN-7686.
