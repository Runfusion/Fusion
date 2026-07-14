---
"@runfusion/fusion": minor
---

summary: Planning Mode sessions are now lock-free — any browser tab can read and interact with the same session.
category: feature
dev: Removed the per-tab session lock (checkSessionLock 409s, Take Control overlay) and BroadcastChannel sync from all planning surfaces; the persisted session row plus per-session SSE and global `ai_session:updated` events are the single source of truth. `tabId` params were dropped from the planning API client functions and `/planning/*` routes ignore any tabId sent by older clients. Subtask/mission interviews keep their existing lock behavior.
