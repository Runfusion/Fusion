# Dashboard Load Performance Analysis

> Historical pre-cutover analysis: the SQLite query plans below do not describe the current PostgreSQL runtime. Retained for performance archaeology and regression context.

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

---

# Dashboard Card Rendering Performance (FN-1544)

**Date:** 2026-04-10
**Task:** FN-1544

## Executive Summary

Performance analysis identified that `TaskCard` components triggered expensive network requests (`session-files` and `diff` endpoints) eagerly on initial render, causing sluggish board/list views with large task sets. Additionally, the memo comparator used high-cost `JSON.stringify` on attachments and comments arrays.

## Issues Identified

### Issue 1: Eager Session Files Fetching (HIGH)

**Problem:** Every `TaskCard` unconditionally called `useSessionFiles` hook, which fetches from `/api/tasks/:id/session-files`. With many cards visible or nearly-visible, this created a flood of network requests on initial render.

**Solution:** Added an `enabled` parameter to `useSessionFiles` (default `true` for backward compatibility). The hook returns stable empty state when disabled without triggering fetches.

### Issue 2: Eager Diff Stats Fetching (HIGH)

**Problem:** Every `TaskCard` for done tasks unconditionally called `useTaskDiffStats` hook, which fetches from `/api/tasks/:id/diff`. This caused repeated fetches during rerenders.

**Solution:** 
1. Added an `enabled` parameter to `useTaskDiffStats` (default `true` for backward compatibility)
2. Added short-lived in-memory caching (30-second TTL) keyed by `taskId:projectId` to avoid repeated fetches during rerenders
3. Cache hits return immediately without loading flicker

### Issue 3: High-Cost Memo Comparison (MEDIUM)

**Problem:** `areTaskCardPropsEqual` used `JSON.stringify(attachments)` and `JSON.stringify(comments)` for comparison. For tasks with many attachments or comments, this serialized entire arrays on every render cycle.

**Solution:** Replaced `JSON.stringify` with lightweight field-by-field comparison functions:
- `areAttachmentsEqual()` - compares attachment counts and metadata fields (filename, mimeType, size)
- `areCommentsEqual()` - compares comment counts and metadata fields (author, content, createdAt)

## Mitigation Pattern: Viewport-Gated Card Metadata Loading

The key mitigation uses the existing `isInViewport` state with a 200px margin:

```typescript
// TaskCard.tsx - Hook calls are gated on viewport visibility
const { files: sessionFiles, loading: sessionFilesLoading } = useSessionFiles(
  task.id,
  task.worktree,
  task.column,
  projectId,
  { enabled: isInViewport },  // Only fetch when card is visible
);

const { stats: diffStats } = useTaskDiffStats(
  task.id,
  task.column,
  task.mergeDetails?.commitSha,
  projectId,
  { enabled: isInViewport },  // Only fetch when card is visible
);
```

**Benefits:**
- Offscreen cards don't trigger fetches
- Cards entering viewport trigger fetches as expected
- No new polling loops or background timers
- Preserves existing card behaviors (badges, file counts, drag/drop, etc.)

## Cache Implementation Details

## Startup slim `listTasks` memoization (FN-4027)

A short-lived startup memo now collapses duplicate `listTasks({ slim: true })` reads that happen during boot choreography (watch cache warmup, scheduler PR hydration, worktree pool scan, and dashboard badge priming).

- Scope: startup-only slim reads keyed by `includeArchived` + `column`
- Safety: memo entries expire quickly (2.5s TTL) and are explicitly cleared when `watch()` handoff completes
- Freshness: steady-state polling/watch reads bypass the memo, so normal runtime updates are not served from stale startup data
- Mutation safety: memoized responses are cloned before return so callers cannot poison shared cached objects

### useTaskDiffStats Cache

```typescript
const diffStatsCache = new Map<string, { stats: DiffStats; expiresAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds
```

- Key format: `"taskId:projectId"`
- Entries expire after TTL to ensure freshness
- Cache is checked before initiating fetch - returns immediately on hit
- Export `__test_clearDiffStatsCache()` for testing

## Files Modified

- `packages/dashboard/app/hooks/useSessionFiles.ts` - Added `enabled` option
- `packages/dashboard/app/hooks/useTaskDiffStats.ts` - Added `enabled` option and caching
- `packages/dashboard/app/hooks/__tests__/useSessionFiles.test.ts` - Tests for `enabled` option
- `packages/dashboard/app/hooks/__tests__/useTaskDiffStats.test.ts` - Tests for `enabled` option and caching
- `packages/dashboard/app/components/TaskCard.tsx` - Viewport-gated hook calls, lightweight memo comparison
- `packages/dashboard/app/components/TaskCard.test.tsx` - Fixed pre-existing test expectations

## Impact Assessment

- **Initial render:** Significant reduction in network requests as offscreen cards don't fetch
- **Rerenders:** Reduced CPU usage from eliminating `JSON.stringify` on large arrays
- **Cache efficiency:** Repeated renders of the same task use cached diff stats instead of refetching
- **User experience:** Board/list views feel more responsive, especially with many tasks

## Key Learnings

1. **Viewport gating is effective** - Using IntersectionObserver with a margin lets us fetch just-in-time without visible delay
2. **Caching with TTL prevents staleness** - 30-second cache balances freshness with reduced network overhead
3. **Lightweight comparisons outperform serialization** - Field-by-field comparison is O(n) vs JSON.stringify's O(n) + allocation overhead
