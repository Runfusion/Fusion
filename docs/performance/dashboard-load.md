# Dashboard Load Performance Analysis

**Date:** 2026-04-10
**Task:** FN-1532

## Executive Summary

Profile analysis identified several SQLite query performance issues in the dashboard boot path. These issues cause unnecessary full table scans and temp B-tree sorts that slow dashboard load times, especially as project data grows.

## Methodology

1. Created a test database with representative data:
   - 100 tasks
   - 50 AI sessions
   - 200 activity log entries
   - 100 run audit events

2. Analyzed query plans using `EXPLAIN QUERY PLAN` for boot-critical read operations

## Query Plan Analysis Results

### Issue 1: Tasks List with ORDER BY (CRITICAL)

**Query:** `SELECT * FROM tasks ORDER BY createdAt ASC`

**Before:**
```
SCAN tasks
USE TEMP B-TREE FOR ORDER BY
```

**Problem:** Full table scan with in-memory sorting. As the tasks table grows, this becomes increasingly expensive.

**Solution:** Add `idxTasksCreatedAt` on `tasks(createdAt)` - allows index scan with ordered retrieval.

---

### Issue 2: AI Sessions Active List (HIGH)

**Query:** `SELECT ... FROM ai_sessions WHERE status IN ('generating', 'awaiting_input', 'error') ORDER BY updatedAt DESC`

**Before:**
```
SEARCH ai_sessions USING INDEX idxAiSessionsStatus (status=?)
USE TEMP B-TREE FOR ORDER BY
```

**Problem:** The existing `idxAiSessionsStatus` only indexes on `status`, but the query also needs `updatedAt` for ordering. This requires a temp B-tree to sort results.

**Solution:** Add `idxAiSessionsStatusUpdatedAt` on `ai_sessions(status, updatedAt DESC)` - covers both filtering and sorting.

---

### Issue 3: Activity Log by Task ID (MEDIUM)

**Query:** `SELECT * FROM activityLog WHERE taskId = ? ORDER BY timestamp DESC`

**Before:**
```
SEARCH activityLog USING INDEX idxActivityLogTaskId (taskId=?)
USE TEMP B-TREE FOR ORDER BY
```

**Problem:** The existing `idxActivityLogTaskId` only indexes `taskId`, but the query also needs `timestamp` for ordering.

**Solution:** Add `idxActivityLogTaskIdTimestamp` on `activityLog(taskId, timestamp DESC)` - covers both filtering and ordering.

---

### Issue 4: Activity Log by Type (MEDIUM)

**Query:** `SELECT * FROM activityLog WHERE type = ? ORDER BY timestamp DESC`

**Before:**
```
SEARCH activityLog USING INDEX idxActivityLogType (type=?)
USE TEMP B-TREE FOR ORDER BY
```

**Problem:** Similar to task ID - the type index doesn't include timestamp for ordering.

**Solution:** Add `idxActivityLogTypeTimestamp` on `activityLog(type, timestamp DESC)` - covers both filtering and ordering.

---

### Issue 5: Agent Heartbeats List (MEDIUM)

**Query:** `SELECT * FROM agentHeartbeats WHERE agentId = ? ORDER BY timestamp DESC`

**Before:**
```
SEARCH agentHeartbeats USING INDEX idxAgentHeartbeatsAgentId (agentId=?)
USE TEMP B-TREE FOR ORDER BY
```

**Problem:** The agent heartbeat index doesn't include timestamp for ordering.

**Solution:** Add `idxAgentHeartbeatsAgentIdTimestamp` on `agentHeartbeats(agentId, timestamp DESC)` - covers both filtering and ordering.

---

### Issue 6: Agents by State (LOW)

**Query:** `SELECT * FROM agents WHERE state = 'idle'`

**Before:**
```
SCAN agents
```

**Problem:** Full table scan on agents table. This affects any dashboard views that filter agents by state.

**Solution:** Add `idxAgentsState` on `agents(state)` - allows index-based lookup for state filtering.

---

## Proposed Index Changes

| Index Name | Table | Columns | Purpose |
|------------|-------|---------|---------|
| `idxTasksCreatedAt` | tasks | `createdAt` | Avoid temp B-tree for `ORDER BY createdAt` |
| `idxAiSessionsStatusUpdatedAt` | ai_sessions | `status, updatedAt DESC` | Cover status filter + updatedAt ordering |
| `idxActivityLogTaskIdTimestamp` | activityLog | `taskId, timestamp DESC` | Cover taskId filter + timestamp ordering |
| `idxActivityLogTypeTimestamp` | activityLog | `type, timestamp DESC` | Cover type filter + timestamp ordering |
| `idxAgentHeartbeatsAgentIdTimestamp` | agentHeartbeats | `agentId, timestamp DESC` | Cover agentId filter + timestamp ordering |
| `idxAgentsState` | agents | `state` | Avoid full scan for state filtering |

## Impact Assessment

- **Boot time improvement:** The `listTasks` index is the highest impact - it eliminates a full table scan + sort on every dashboard load
- **AI sessions:** Eliminates sort overhead on every session list refresh
- **Activity log:** Eliminates sort overhead on task detail views
- **Agents:** Eliminates full scan on agent list filtering

## Files Modified

- `packages/core/src/db.ts` - Add migration for new indexes
- `packages/core/src/db.test.ts` - Update expected index list
- `packages/core/src/run-audit.test.ts` - Update expected index list  
- `packages/core/src/__tests__/task-documents.test.ts` - Update expected index list
