---
"@runfusion/fusion": minor
---

summary: AI planning, subtask, and mission interviews are now multi-tab — any tab can use the same session.
category: feature
dev: Removed the per-tab session lock end to end: the `/ai-sessions/:id/lock{,/force,/beacon}` routes, `checkSessionLock` on every planning/subtask/mission/milestone route, the store's acquire/release/force/holder/stale-release methods and their `@fusion/core` async helpers, the `useSessionLock` hook, the `getSessionTabId` util, the Take Control overlay + "active in another tab" banners, and the `useAiSessionSync` tab-ownership half (activeTabMap, broadcastLock/Unlock/Heartbeat, owningTabId). `tabId` params are gone from the session API client; routes ignore any tabId older clients still send. The persisted session row is the single source of truth, with per-session SSE plus global `ai_session:updated` events keeping tabs current and each producer's generation-in-progress guard resolving concurrent writes. The `ai_sessions.locked_by_tab`/`locked_at` columns are retained as dead, always-NULL columns — dropping them is an irreversible migration that would break older installed binaries whose upsert names those columns.
