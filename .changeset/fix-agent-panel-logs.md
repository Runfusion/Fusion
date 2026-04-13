---
"@gsxdsm/fusion": patch
---

Fix empty agent logs in the Agents panel. The `ActiveAgentsPanel` and `useLiveTranscript` hook were wired to `entry.content`, while the SSE payload from `/api/tasks/:id/logs/stream` sends `AgentLogEntry` objects with a `text` field. This caused all live agent transcript lines to appear blank. The fix normalizes the transcript interface to use `text` as the canonical field, adds backward compatibility for any legacy `content` payloads, and threads `projectId` through the component hierarchy for multi-project support.
