---
"@runfusion/fusion": patch
---

summary: Fix Planning Mode duplicating generations and "AI returned no valid JSON" errors after leaving and returning mid-run.
category: fix
dev: Planning turns are admitted through a synchronous per-session reservation across submitResponse/retrySession/startExistingSession and the initial turn, so a racing entry is rejected instead of displacing the in-flight generation and disposing its agent mid-prompt. Duplicate starts of a generating session are no-ops, the client auto-retry budget survives view remounts (module-scoped per-session map), and SSE reconnects rebuild thinking output from a full-turn replay buffer (2000 events) instead of appending onto existing output. Planning prompts also route through the engine's promptWithFallback so context-window overflows recover via compaction instead of erroring the session.
