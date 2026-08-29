import { AgentStore, type PluginContext, type PluginRouteDefinition, type PluginRouteResponse, type TaskCreateInput, type TaskPriority } from "@fusion/core";

type Request = { params: Record<string, string>; query?: Record<string, string | string[] | undefined>; body?: unknown };

class RequestValidationError extends Error {}

const badRequest = (error: string): PluginRouteResponse => ({ status: 400, body: { error } });
const notFound = (error: string): PluginRouteResponse => ({ status: 404, body: { error } });
const noContent = (): PluginRouteResponse => ({ status: 204 });

function value(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function projectId(req: Request): string | undefined {
  const query = value(req.query?.projectId).trim();
  if (query) return query;
  const body = req.body as { projectId?: unknown } | undefined;
  return typeof body?.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined;
}

async function store(req: Request, ctx: PluginContext) {
  const id = projectId(req);
  return id && ctx.resolveProjectTaskStore ? await ctx.resolveProjectTaskStore(id) : ctx.taskStore;
}

function title(input: unknown, field: "title" | "text", max: number): string {
  if (typeof input !== "string" || !input.trim()) throw new RequestValidationError(`${field} is required`);
  if (input.length > max) throw new RequestValidationError(`${field} must not exceed ${max} characters`);
  return input.trim();
}

function bool(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") throw new RequestValidationError(`${field} must be a boolean`);
  return input;
}

function stringArray(input: unknown, field: string): string[] {
  if (!Array.isArray(input) || !input.every((item) => typeof item === "string")) {
    throw new RequestValidationError(`${field} must be an array of strings`);
  }
  return input;
}

function priority(input: unknown): TaskPriority | undefined {
  if (input === undefined) return undefined;
  if (input === "low" || input === "normal" || input === "high" || input === "urgent") return input;
  throw new RequestValidationError("priority must be one of low, normal, high, urgent");
}

function optionalTrimmedString(input: unknown, field: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") throw new RequestValidationError(`${field} must be a string`);
  return input.trim() || undefined;
}

function optionalTaskTitle(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") throw new RequestValidationError("title must be a string");
  if (!input.trim()) throw new RequestValidationError("title must not be blank");
  if (input.length > 200) throw new RequestValidationError("title must not exceed 200 characters");
  return input.trim();
}

function route(handler: (req: Request, ctx: PluginContext) => Promise<unknown | PluginRouteResponse>) {
  return async (raw: unknown, ctx: PluginContext): Promise<unknown | PluginRouteResponse> => {
    try {
      return await handler(raw as Request, ctx);
    } catch (error) {
      if (error instanceof RequestValidationError) return badRequest(error.message);
      throw error;
    }
  };
}

/*
FNXC:TodoPluginOwnership 2026-08-03-15:16:
Todo routes live only under the plugin namespace. Project plugin enablement now controls whether the API is registered, removing the hardcoded host route as a second authority.

FNXC:TodoPluginRouteSemantics 2026-08-03-16:00:
Plugin validation failures remain client-visible 400 responses, while TodoStore, AgentStore, and task-creation failures propagate to the host error boundary as 500 responses. Validate create-task inputs before item lookup so invalid input wins over a missing-item 404, matching the former host API.
*/
export function createTodoPluginRoutes(): PluginRouteDefinition[] {
  return [
    { method: "GET", path: "/todos", handler: route(async (req, ctx) => (await store(req, ctx)).getTodoStore().getListsWithItems(projectId(req) ?? "")) },
    { method: "POST", path: "/todos", handler: route(async (req, ctx) => {
      const list = await (await store(req, ctx)).getTodoStore().createList(projectId(req) ?? "", { title: title((req.body as { title?: unknown })?.title, "title", 200) });
      return { status: 201, body: list };
    }) },
    { method: "GET", path: "/todos/:id", handler: route(async (req, ctx) => {
      const todo = (await store(req, ctx)).getTodoStore();
      const list = await todo.getList(req.params.id);
      return list ? { ...list, items: await todo.listItems(req.params.id) } : notFound(`Todo list ${req.params.id} not found`);
    }) },
    { method: "GET", path: "/todos/:id/items", handler: route(async (req, ctx) => {
      const todo = (await store(req, ctx)).getTodoStore();
      return await todo.getList(req.params.id) ? todo.listItems(req.params.id) : notFound(`Todo list ${req.params.id} not found`);
    }) },
    { method: "PATCH", path: "/todos/:id", handler: route(async (req, ctx) => {
      const input = req.body as { title?: unknown };
      if (input?.title === undefined) return badRequest("At least one field must be provided");
      const list = await (await store(req, ctx)).getTodoStore().updateList(req.params.id, { title: title(input.title, "title", 200) });
      return list ?? notFound(`Todo list ${req.params.id} not found`);
    }) },
    { method: "DELETE", path: "/todos/:id", handler: route(async (req, ctx) => {
      await (await store(req, ctx)).getTodoStore().deleteList(req.params.id);
      return noContent();
    }) },
    { method: "POST", path: "/todos/:id/items", handler: route(async (req, ctx) => {
      const item = await (await store(req, ctx)).getTodoStore().createItem(req.params.id, { text: title((req.body as { text?: unknown })?.text, "text", 2000) });
      return { status: 201, body: item };
    }) },
    { method: "GET", path: "/todos/items/:id", handler: route(async (req, ctx) => (await store(req, ctx)).getTodoStore().getItem(req.params.id) ?? notFound(`Todo item ${req.params.id} not found`)) },
    { method: "PATCH", path: "/todos/items/:id", handler: route(async (req, ctx) => {
      const input = req.body as { text?: unknown; completed?: unknown };
      const patch: { text?: string; completed?: boolean } = {};
      if (input?.text !== undefined) patch.text = title(input.text, "text", 2000);
      if (input?.completed !== undefined) patch.completed = bool(input.completed, "completed");
      if (!Object.keys(patch).length) return badRequest("At least one field must be provided");
      return await (await store(req, ctx)).getTodoStore().updateItem(req.params.id, patch) ?? notFound(`Todo item ${req.params.id} not found`);
    }) },
    { method: "DELETE", path: "/todos/items/:id", handler: route(async (req, ctx) => {
      await (await store(req, ctx)).getTodoStore().deleteItem(req.params.id);
      return noContent();
    }) },
    { method: "POST", path: "/todos/:id/items/reorder", handler: route(async (req, ctx) => {
      await (await store(req, ctx)).getTodoStore().reorderItems(req.params.id, stringArray((req.body as { itemIds?: unknown })?.itemIds, "itemIds"));
      return noContent();
    }) },
    { method: "GET", path: "/host/agents", handler: route(async (req, ctx) => {
      const scoped = await store(req, ctx);
      const agents = new AgentStore({ rootDir: scoped.getFusionDir(), asyncLayer: scoped.getAsyncLayer() ?? undefined });
      await agents.init();
      return agents.listAgents();
    }) },
    { method: "POST", path: "/todos/items/:id/create-task", handler: route(async (req, ctx) => {
      const input = req.body as { title?: unknown; priority?: unknown; workflowId?: unknown; assignedAgentId?: unknown };
      const taskTitle = optionalTaskTitle(input?.title);
      const taskPriority = priority(input?.priority);
      const workflowId = optionalTrimmedString(input?.workflowId, "workflowId");
      const assignedAgentId = optionalTrimmedString(input?.assignedAgentId, "assignedAgentId");
      const scoped = await store(req, ctx);
      const item = await scoped.getTodoStore().getItem(req.params.id);
      if (!item) return notFound(`Todo item ${req.params.id} not found`);
      const taskInput: TaskCreateInput = {
        title: taskTitle ?? item.text.slice(0, 200),
        description: item.text,
        ...(taskPriority ? { priority: taskPriority } : {}),
        ...(workflowId ? { workflowId } : {}),
        ...(assignedAgentId ? { assignedAgentId } : {}),
        source: { sourceType: "api", sourceMetadata: { todoItemId: item.id, todoListId: item.listId } },
      };
      return { status: 201, body: await scoped.createTask(taskInput) };
    }) },
  ];
}
