---
"@dustinbyrne/kb": patch
---

Add `--paused` flag to `kb dashboard` command to start with engine automation disabled. When used, the dashboard starts with `enginePaused` set to true, preventing triage, execution, and auto-merge from running until manually unpaused from the web dashboard settings.
