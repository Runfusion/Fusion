---
"@runfusion/fusion": patch
---

summary: Replace task priority levels with one arrival-ordered queue plus a Boost button on each card.
category: breaking
dev: |
  FN-509 removes the task priority contract. `TaskPriority`, `TASK_PRIORITIES`, `DEFAULT_TASK_PRIORITY`,
  the priority comparators, and the `priority` field on `Task`/`TaskCreateInput`/`PlanningSummary`/
  `MergeQueueEntry` are deleted. The `priority` parameter is removed from `fn_task_create` and
  `fn_task_update`, from the engine/triage task-creation tools, and from the Todos plugin's
  create-task route; the `POST /api/tasks`, `PATCH /api/tasks/:id`, research-promotion, and Todos
  routes now REFUSE an explicit `priority` with a clear error rather than silently ignoring it.
  `GET /api/tasks/done` no longer accepts `sort`, and its opaque cursor is bumped to v2 so a cursor
  minted under the retired task-id order cannot be replayed.

  Replacement: `POST /api/tasks/:id/boost` (requires `requestId`; optional `expectedColumn` /
  `expectedColumnEntryAt` preconditions; 404 absent, 409 active/changed/no-queue) and
  `TaskStore.boostTask`. Migration `0082_fn_509_task_queue_order.sql` adds the nullable
  `project.tasks.queue_boost` column and the `project.task_queue_boost_seq` ordering sequence.

  Existing data: the legacy `project.tasks.priority` and `merge_queue.priority` columns are NOT
  dropped. They remain as inert historical values with no reader and no writer — nothing re-emits
  them as a task field, migrates them into a Boost, copies them onto a new task, or sorts by them.
  Reading and resuming old planning sessions and archived documents stays tolerant.

  Also removed: the column header "…" menu (with its Replan All, Stop All, auto-approve shortcut and
  per-column sort control — the individual operations and their endpoints are unchanged), the
  FN-4969 dependency-unblock fanout dispatch weighting, the admission lane rank
  (review → execute → planning), and the starved-refinement priority nudge.
