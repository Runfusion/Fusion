---
"@runfusion/fusion": patch
---

summary: Fix duplicated terminal history on reconnect and a wrong terminal size when two browsers share a session.
category: fix
dev: Two defects found by driving a shared PTY with two real WebSocket viewers. (1) The server replayed the whole scrollback on every attach and the client appended it into an xterm that still displayed that history, so any reconnect — backgrounded tab, sleep, heartbeat timeout — added a second copy (visible as a duplicated prompt). `TerminalService` now tracks cumulative output (`scrollbackSeq`) and `getScrollbackSince(sessionId, sinceSeq)` returns only the delta when the offset is inside the retained window, or the full buffer with `reset: true`; the client reports `sinceSeq` on connect and resets the terminal before writing a full replay. (2) Resize was last-writer-wins across viewers: A at 80x24 had its shell report 200x50 as soon as B attached at that size, while A still rendered 80 columns. `TerminalViewportRegistry` sizes the PTY to the per-dimension minimum across attached viewers (the tmux rule) and restores room when a viewer disconnects; viewers that have not reported a size do not constrain it.
