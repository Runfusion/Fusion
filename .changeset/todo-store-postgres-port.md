---
"@runfusion/fusion": minor
---

summary: Todo lists now work on the embedded-PostgreSQL backend instead of erroring.
category: feature
dev: Ports TodoStore to the AsyncDataLayer. Adds an `AsyncTodoStore` class (in async-todo-store.ts) wrapping the already-tested async CRUD helpers over project.todo_lists/project.todo_items; `getTodoStoreImpl` returns it in backend mode instead of throwing "TodoStore is not available in PG backend mode" (which 500'd every /api/todos route). The dashboard todo routes now await the store methods so the same code path serves both the sync SQLite store and the async PG store. Adds todo-store.pg.test.ts to the blocking test:pg-gate lane. Known gap: the async store does not yet emit list/item events for SSE live-refresh (updates land on next read).
