# Todo View

[← Docs index](./README.md)

Todo View is an experimental full-height dashboard surface for personal/project todo lists that can feed directly into Fusion planning and task workflows. It renders in the project right-content area like other views rather than opening a modal overlay.

## Overview

Todo View lets you:

- Create multiple todo lists per project
- Add, edit, complete, delete, and reorder todo items
- Start Planning Mode from any todo item (💡)
- Create a task from a todo item using the project-default workflow
- Create and immediately assign a task to an agent from a todo item

The feature is implemented in `TodoView.tsx` with data/state orchestration in `useTodoLists.ts` and backend routes in `packages/dashboard/src/todo-routes.ts`.

## Enablement (`experimentalFeatures.todoView`)

Todo View is hidden unless the global experimental flag is enabled:

```json
{
  "experimentalFeatures": {
    "todoView": true
  }
}
```

Behavior when disabled:

- Todo navigation entry is hidden from dashboard navigation menus
- If a user is currently on Todo View and the flag is turned off, the app redirects back to board view

## Accessing Todo View

When enabled:

- Desktop/tablet with Left Sidebar Navigation enabled: left sidebar → **Todos**
- Desktop/tablet without the left sidebar: header overflow menu (**More views**) → **Todos**
- Mobile: **More** sheet in the mobile nav bar → **Todos**

## List management

In the left sidebar:

- **Create list**: plus button or empty-state action
- **Rename list**: pencil action
- **Delete list**: trash action (with confirm dialog)
- **Select active list**: clicking a list switches the main panel

Validation/API constraints:

- `title` is required
- `title` is trimmed
- `title` max length is 200 characters

## Item management

Within the selected list:

- **Add item** using input + Add button (or Enter)
- **Edit item text** inline
- **Toggle completion** via checkbox
- **Move up/down** to reorder items
- **Delete item** via trash action

Validation/API constraints:

- `text` is required
- `text` is trimmed
- `text` max length is 2000 characters
- Completion toggling uses `PATCH /api/todos/items/:id` with `completed: boolean` (no separate toggle endpoint)

## Planning integration

Each item has a planning action (💡):

- Opens Planning Mode with todo text as the initial plan
- Starts a planning interview flow
- Does not create a task until you complete planning and explicitly create one

See also: [Task Management → Todo item → Plan Mode](./task-management.md#3-todo-item--plan-mode).

## Task creation and agent delegation actions

Each item also has task actions:

- **Create task** (`+`): creates a new task with todo text as description; the project-default workflow selects its intake column
- **Assign to agent** (bot icon): loads agents, then creates a new task with `assignedAgentId` using that workflow's intake column

Both actions use dashboard task creation APIs and preserve project scoping when a project is selected.

## API reference (current implementation)

Base prefix: `/api/todos`

### Lists

- `GET /api/todos` — list lists with embedded items
- `POST /api/todos` — create list (`{ title }`)
- `GET /api/todos/:id` — get one list with its ordered items
- `PATCH /api/todos/:id` — update list title (`{ title }`)
- `DELETE /api/todos/:id` — delete list

### Items

- `POST /api/todos/:id/items` — create item in list (`{ text }`)
- `GET /api/todos/:id/items` — list ordered items in one list
- `GET /api/todos/items/:id` — get one item
- `POST /api/todos/items/:id/create-task` — create a board task from an item
- `PATCH /api/todos/items/:id` — update item (`{ text?; completed? }`)
- `DELETE /api/todos/items/:id` — delete item
- `POST /api/todos/:id/items/reorder` — reorder full list (`{ itemIds: string[] }`)

### Scripting a todo into execution

A script can create a list (`POST /api/todos`), add an item (`POST /api/todos/:id/items`), then create executable board work with `POST /api/todos/items/:id/create-task`.

The create-task request accepts optional `{ title?, priority?, workflowId?, assignedAgentId?, projectId? }`. `title` is trimmed and must be 1–200 characters when supplied; otherwise the task title is `item.text.slice(0, 200)`. `priority` must be `low`, `normal`, `high`, or `urgent`. Blank `workflowId` and `assignedAgentId` values are omitted, while non-blank values are trimmed. Invalid title or priority values return HTTP 400 without creating a task.

The created task has `source.sourceType: "api"` and `sourceMetadata.todoItemId` / `sourceMetadata.todoListId` provenance. It does not force `triage`: the selected or project-default workflow resolves the intake column.

### Project scoping

`projectId` may be provided:

- Query parameter (for reads and route calls that include query string)
- Request body (supported by route resolver for mutating calls)

When omitted, Todo APIs operate against the default/local project scope (`""` project ID in TodoStore).

## Storage linkage

Todo data is persisted in the project PostgreSQL schema, isolated by `project_id`, via:

- `todo_lists`
- `todo_items`

See [Storage](./storage.md) for the broader database/storage model.

## Related source-of-truth files

- `packages/dashboard/app/components/TodoView.tsx`
- `packages/dashboard/app/hooks/useTodoLists.ts`
- `packages/dashboard/src/todo-routes.ts`
- `packages/core/src/todo-store.ts`
- `packages/dashboard/src/__tests__/todo-routes.test.ts`
- `packages/dashboard/app/components/__tests__/TodoView.test.tsx`
