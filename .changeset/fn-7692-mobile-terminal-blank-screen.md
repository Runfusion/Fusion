---
"@runfusion/fusion": patch
---

summary: Fix the terminal rendering blank on mobile even though the shell prompt already loaded.
category: fix
dev: Adds `guardAgainstCollapsedTerminalScreen` (app/utils/terminalPreferences.ts), wired into TerminalModal and SessionTerminal. On the mobile fullscreen layout xterm could measure a 0-width character cell, so FitAddon.fit() proposed 0 columns/rows and `.xterm-screen` (plus the WebGL canvas) collapsed to 0x0 — prompt bytes arrived but painted into a zero-size box. The guard watches for that collapsed state (container has width, `.xterm-screen` does not) and forces a genuine remeasure+fit, re-driven by a ResizeObserver until the screen has a real width. Renderer-agnostic and bounded. Recurrence of FN-7620/FN-7686.
