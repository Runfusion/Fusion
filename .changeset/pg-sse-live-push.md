---
"@runfusion/fusion": minor
---

summary: Live dashboard updates (SSE) work on the PostgreSQL backend for missions, research, and insights.
category: feature
dev: The async store wrappers (AsyncMissionStore/AsyncResearchStore/AsyncInsightStore) now extend EventEmitter and emit the same events as their sync counterparts at the same mutation points (after the persistence await), so the SSE handler's subscriptions fire in PG mode instead of no-op'ing. sse.ts/server.ts drop the instanceof-sync narrowing and subscribe to the union store in both backends. Live push for mission/milestone/slice/feature/assertion/validator-start, research run lifecycle, and insight create/update events. Validator-loop-completed and fix-feature emits remain sync-only (those methods aren't in AsyncMissionStore yet).
