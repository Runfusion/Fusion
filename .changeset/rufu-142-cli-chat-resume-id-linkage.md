---
"@runfusion/fusion": patch
---

summary: Fix CLI chat session resume failing with an unknown-session error after a restart.
category: fix
dev: The CliSessionManager spawn resume branch now resolves the minted cli_sessions record via the persisted chat_session_id linkage (nativeSessionId match preferred, else newest) and updates it by its own id; the resume-coordinator caller is unchanged.
