---
"@runfusion/fusion": patch
---

summary: Terminal now auto-reconnects on first launch instead of getting stuck on "Disconnected".
category: fix
dev: useTerminal tracks whether the socket has ever opened; a never-connected initial connect keeps retrying at capped backoff (staying "reconnecting") until it opens, while mid-session drops and 4000/4004 permanent closes are unchanged.
