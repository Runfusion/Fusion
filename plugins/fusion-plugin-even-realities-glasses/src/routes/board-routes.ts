import { resolveProjectColumnsForRoles, TERMINAL_ROLES } from "@fusion/core";
import type { Task } from "@fusion/core";
import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import {
  boardToDeck,
  DEFAULT_MAX_CARDS_PER_DECK,
  DEFAULT_MAX_CHARS_PER_LINE,
  DEFAULT_MAX_LINES_PER_CARD,
  taskToCard,
} from "../cards.js";
import { requireApiKey } from "./quick-capture-routes.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-00:45:
`?columns=` filters on the ids the CALLER asked for. There is no allow-list to clear first.

This validated the parameter against a hardcoded six-id list, and the failure mode was the worst
available one — silent and inverted. On a board whose lanes are named anything else, every requested
id was discarded, `parsed.length` was 0, the function returned `null`, and `null` is the SAME value
it returns for "no filter requested". So the route answered 200 with the ENTIRE board: a caller
asking for one column received all of them, with nothing in the response saying the filter had been
dropped.

The list also still named `triage`, a column U11 deleted, so it described a board that no longer
exists in either direction.

No allow-list can be correct here and none is needed. The valid ids are whatever the project's
workflows declare; `Task["column"]` is already `ColumnId = Column | (string & {})`, i.e. open by
construction. Filtering directly on the requested ids needs no resolution source at all — which is
why this literal, unlike the display ordering in `cards.ts`, is a defect and not a documented
deferral.

Behaviour change, deliberate: `?columns=nonsense` now returns an EMPTY deck rather than the whole
board. "Show me column X" answered with every column is not a lenient default, it is the bug.
*/
function parseColumns(raw: unknown): Set<Task["column"]> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return parsed.length ? new Set(parsed) : null;
}

function parseMax(raw: unknown): number {
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_MAX_CARDS_PER_DECK;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function requestData(req: unknown): {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  params: Record<string, unknown>;
} {
  const candidate = (req ?? {}) as {
    headers?: Record<string, string | string[] | undefined>;
    query?: Record<string, unknown>;
    params?: Record<string, unknown>;
  };
  return { headers: candidate.headers ?? {}, query: candidate.query ?? {}, params: candidate.params ?? {} };
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-02:40:
The project's terminal lanes, resolved once per request and handed to the deck builder.

`boardToDeck` filters out finished cards, and it named `archived`/`done`. On a board that calls its
finished lane anything else the deck is not merely mislabelled: it is CAPPED at `maxCards`, so every
completed card counts as active and pushes real work off the glasses display — the wearer sees fewer
live tasks the more the team finishes.

`boardToDeck` takes plain `Task` rows and cannot resolve anything itself, but this package lists
`@fusion/core` as a runtime dependency (`quick-capture.ts` and `agent-actions.ts` already resolve
workflow IRs), so the route can. Project-scoped rather than per card: one `listWorkflowDefinitions()`
read regardless of board size, matching how `?columns=` already treats the board as one pool.

Best-effort — a failed resolve leaves the deck on its documented legacy default rather than failing
the request, because a slightly-wrong deck beats no deck on a pair of glasses.
*/
async function resolveTerminalLanes(ctx: PluginContext): Promise<ReadonlySet<string> | undefined> {
  try {
    return await resolveProjectColumnsForRoles(
      ctx.taskStore as Parameters<typeof resolveProjectColumnsForRoles>[0],
      TERMINAL_ROLES,
    );
  } catch {
    return undefined;
  }
}

async function getBoardCards(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const request = requestData(req);
  const auth = requireApiKey(ctx, { headers: request.headers });
  if (!auth.ok) return auth.response;

  const all = ((await ctx.taskStore.listTasks({ includeArchived: false })) as Task[]) ?? [];
  const columns = parseColumns(request.query.columns);
  const filtered = columns ? all.filter((task) => columns.has(task.column)) : all;
  const maxCards = parseMax(request.query.max);
  const deck = boardToDeck(filtered, {
    maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE,
    maxLines: DEFAULT_MAX_LINES_PER_CARD,
    maxCards,
    terminalColumns: await resolveTerminalLanes(ctx),
  });
  return { status: 200, body: { deck, generatedAt: new Date().toISOString() } };
}

async function getBoardSummary(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const request = requestData(req);
  const auth = requireApiKey(ctx, { headers: request.headers });
  if (!auth.ok) return auth.response;

  const all = ((await ctx.taskStore.listTasks({ includeArchived: false })) as Task[]) ?? [];
  const columns = parseColumns(request.query.columns);
  const filtered = columns ? all.filter((task) => columns.has(task.column)) : all;
  const deck = boardToDeck(filtered, {
    maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE,
    maxLines: DEFAULT_MAX_LINES_PER_CARD,
    maxCards: 1,
    terminalColumns: await resolveTerminalLanes(ctx),
  });

  return { status: 200, body: { summary: deck.summary, updatedAt: deck.summary.updatedAt } };
}

async function getTaskCards(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const request = requestData(req);
  const auth = requireApiKey(ctx, { headers: request.headers });
  if (!auth.ok) return auth.response;

  const taskId = typeof request.params.id === "string" ? request.params.id.trim() : "";
  if (!taskId) return { status: 400, body: { error: "task id is required" } };

  const task = (await ctx.taskStore.getTask(taskId)) as Task | undefined;
  if (!task) return { status: 404, body: { error: "task not found" } };

  const deck = {
    cards: [taskToCard(task, { maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE, maxLines: DEFAULT_MAX_LINES_PER_CARD })],
    summary: boardToDeck([task], { maxCards: 1 }).summary,
  };

  return { status: 200, body: { deck, generatedAt: new Date().toISOString() } };
}

export const boardRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/board/cards", handler: getBoardCards, description: "Read-only board card deck" },
  { method: "GET", path: "/board", handler: getBoardSummary, description: "Read-only board summary" },
  { method: "GET", path: "/tasks/:id/cards", handler: getTaskCards, description: "Read-only single task card deck" },
];
