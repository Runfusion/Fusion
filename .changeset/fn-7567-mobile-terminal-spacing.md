---
"@runfusion/fusion": patch
---

summary: Fix mobile terminal excess character spacing that survived earlier font-remeasure fixes.
category: fix
dev: `TerminalModal`/`SessionTerminal` re-bake xterm's `DomRenderer` letter-spacing compensation AFTER `fitAddon.fit()` settles the post-fit column count (not just before it), since `handleResize()` never re-bakes spacing itself. See `docs/solutions/ui-bugs/xterm-options-noop-remeasure-after-font-settle.md` recurrence #4.
