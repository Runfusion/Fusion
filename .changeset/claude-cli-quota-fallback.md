---
"@gsxdsm/fusion": patch
---

Add CLI fallback for Claude quota display when API is rate limited (429).
Falls back to parsing `claude /usage` TUI output via PTY.
