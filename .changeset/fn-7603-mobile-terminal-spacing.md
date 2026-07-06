---
"@runfusion/fusion": patch
---

summary: Fix persistent mobile terminal inter-character spacing (5th recurrence root cause).
category: fix
dev: xterm's CharSizeService picks a Canvas-based (OffscreenCanvas) or DOM-based character-measurement strategy at terminal.open() time; DomRenderer's letter-spacing bake always measures via a separate DOM-based WidthCache, so a Canvas-vs-DOM measurement mismatch survived FN-7561/FN-7567's remeasure-ordering fixes. `withDomBasedTerminalCharacterMeasurement` in terminalPreferences.ts forces CharSizeService onto the same DOM strategy for both TerminalModal and SessionTerminal.
