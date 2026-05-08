import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { boardToDeck } from "../cards/board-cards.js";
import { DEFAULT_MAX_CARDS_PER_DECK, DEFAULT_MAX_CHARS_PER_LINE, DEFAULT_MAX_LINES_PER_CARD } from "../cards/format.js";
import { taskToCard } from "../cards/task-cards.js";
import type { CardDeck, FusionColumn, FusionTask } from "../cards/types.js";
import { requireApiKey } from "./auth.js";

const ALLOWED_COLUMNS: FusionColumn[] = ["triage", "todo", "in-progress", "in-review", "done", "archived"];

function parseColumns(raw: unknown): Set<FusionColumn> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is FusionColumn => ALLOWED_COLUMNS.includes(value as FusionColumn));
  return parsed.length ? new Set(parsed) : null;
}

function parseMax(raw: unknown): number {
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_MAX_CARDS_PER_DECK;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function requestData(req: unknown): { headers: Record<string, string | string[] | undefined>; query: Record<string, unknown>; params: Record<string, unknown> } {
  const candidate = (req ?? {}) as { headers?: Record<string, string | string[] | undefined>; query?: Record<string, unknown>; params?: Record<string, unknown> };
  return { headers: candidate.headers ?? {}, query: candidate.query ?? {}, params: candidate.params ?? {} };
}

async function getBoardCards(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const request = requestData(req);
  const auth = requireApiKey(ctx, { headers: request.headers });
  if (!auth.ok) return auth.response;

  const all = ((await ctx.taskStore.listTasks({ includeArchived: false })) as FusionTask[]) ?? [];
  const columns = parseColumns(request.query.columns);
  const filtered = columns ? all.filter((task) => columns.has(task.column)) : all;
  const maxCards = parseMax(request.query.max);
  const deck = boardToDeck(filtered, { maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE, maxLines: DEFAULT_MAX_LINES_PER_CARD, maxCards });
  return { status: 200, body: { deck, generatedAt: new Date().toISOString() } };
}

async function getBoardSummary(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const request = requestData(req);
  const auth = requireApiKey(ctx, { headers: request.headers });
  if (!auth.ok) return auth.response;

  const all = ((await ctx.taskStore.listTasks({ includeArchived: false })) as FusionTask[]) ?? [];
  const columns = parseColumns(request.query.columns);
  const filtered = columns ? all.filter((task) => columns.has(task.column)) : all;
  const deck = boardToDeck(filtered, { maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE, maxLines: DEFAULT_MAX_LINES_PER_CARD, maxCards: 1 });

  return { status: 200, body: { summary: deck.summary, updatedAt: deck.summary.updatedAt } };
}

async function getTaskCards(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const request = requestData(req);
  const auth = requireApiKey(ctx, { headers: request.headers });
  if (!auth.ok) return auth.response;

  const taskId = typeof request.params.id === "string" ? request.params.id.trim() : "";
  if (!taskId) return { status: 400, body: { error: "task id is required" } };

  const task = (await ctx.taskStore.getTask(taskId)) as FusionTask | undefined;
  if (!task) return { status: 404, body: { error: "task not found" } };

  const deck: CardDeck = {
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
