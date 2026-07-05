---
"@runfusion/fusion": patch
---

summary: Fix mobile terminal text still rendering with excess inter-character gaps after font-load settle.
category: fix
dev: Root cause: xterm's OptionsService setter is a no-op when reassigning an already-current fontFamily/fontSize, so post-settle reapply never forced CharSizeService/DomRenderer to remeasure. Added `forceTerminalFontRemeasure()` in `terminalPreferences.ts`, used by both `TerminalModal.tsx` and `SessionTerminal.tsx` at every post-`waitForTerminalFontMetrics()` settle site.
