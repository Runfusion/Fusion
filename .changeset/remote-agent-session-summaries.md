---
"@runfusion/fusion": minor
---

summary: Generate an AI summary of a remote agent session, with the turns it covered and explicit stale or failed state.
category: feature
dev: New `project.external_session_summaries` table (migration 0092) and `GET`/`POST /external-sessions/:id/summary`. Generation is operator-triggered and uses the title-summarizer model lane. Staleness is derived from the session's current turns, never stored, and a failed attempt writes only the failure columns so the previous summary survives an inference outage.
