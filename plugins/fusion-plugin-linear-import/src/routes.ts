import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { LinearClient, linearErrorToResponse, type LinearIssueListOptions } from "./linear-client.js";
import { importLinearIssue } from "./import-linear.js";
import { resolveLinearSettings } from "./settings.js";

interface RequestLike {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readBody(req: unknown): Record<string, unknown> {
  return asRecord((req as RequestLike).body);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

function requireClient(ctx: PluginContext): LinearClient | PluginRouteResponse {
  const settings = resolveLinearSettings(ctx.settings);
  if (!settings.apiKey) {
    return response(401, { ok: false, authenticated: false, error: "Configure a Linear API key in Plugin Manager settings before importing issues.", code: "missing_api_key" });
  }
  return new LinearClient(settings.apiKey);
}

function readListOptions(ctx: PluginContext, source: Record<string, unknown>): LinearIssueListOptions {
  const settings = resolveLinearSettings(ctx.settings);
  return {
    query: readString(source.query),
    teamKey: readString(source.teamKey) ?? readString(source.teamId) ?? settings.defaultTeamKey,
    state: (readString(source.state) ?? settings.defaultStateFilter) as LinearIssueListOptions["state"],
    assigneeId: readString(source.assigneeId) ?? settings.defaultAssigneeId,
    limit: readNumber(source.limit),
    after: readString(source.after),
  };
}

function errorResponse(error: unknown): PluginRouteResponse {
  const mapped = linearErrorToResponse(error);
  return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
}

export async function getLinearStatus(_req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const settings = resolveLinearSettings(ctx.settings);
  if (!settings.apiKey) {
    return response(200, { ok: true, authenticated: false, configured: false, defaultTeamKey: settings.defaultTeamKey ?? null, defaultStateFilter: settings.defaultStateFilter });
  }
  try {
    const client = new LinearClient(settings.apiKey);
    await client.listIssues({ limit: 1, teamKey: settings.defaultTeamKey, state: settings.defaultStateFilter, assigneeId: settings.defaultAssigneeId });
    return response(200, { ok: true, authenticated: true, configured: true, defaultTeamKey: settings.defaultTeamKey ?? null, defaultStateFilter: settings.defaultStateFilter });
  } catch (error) {
    const mapped = linearErrorToResponse(error);
    return response(mapped.status, { ok: false, authenticated: false, configured: true, error: mapped.error, code: mapped.code });
  }
}

export async function listLinearIssues(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const client = requireClient(ctx);
  if (!(client instanceof LinearClient)) return client;
  try {
    const query = { ...asRecord((req as RequestLike).query), ...readBody(req) };
    const result = await client.listIssues(readListOptions(ctx, query));
    return response(200, { ok: true, issues: result.issues, pageInfo: result.pageInfo });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function getLinearIssueDetail(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const client = requireClient(ctx);
  if (!(client instanceof LinearClient)) return client;
  const body = readBody(req);
  const issueId = readString(body.issueId) ?? readString(body.id) ?? readString(body.identifier);
  if (!issueId) return response(400, { ok: false, error: "issueId or identifier is required.", code: "validation_error" });
  try {
    const issue = await client.getIssue(issueId);
    return response(200, { ok: true, issue });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function importSingleLinearIssue(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const client = requireClient(ctx);
  if (!(client instanceof LinearClient)) return client;
  const body = readBody(req);
  const issueId = readString(body.issueId) ?? readString(body.id) ?? readString(body.identifier);
  if (!issueId) return response(400, { ok: false, error: "issueId or identifier is required.", code: "validation_error" });
  try {
    const issue = await client.getIssue(issueId);
    const result = await importLinearIssue(ctx.taskStore, issue);
    return response(result.duplicate ? 200 : 201, { ok: true, ...result, task: undefined });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function importBatchLinearIssues(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const client = requireClient(ctx);
  if (!(client instanceof LinearClient)) return client;
  const body = readBody(req);
  const issueIds = Array.isArray(body.issueIds) ? body.issueIds.map(readString).filter((id): id is string => Boolean(id)) : [];
  if (issueIds.length === 0) return response(400, { ok: false, error: "issueIds must include at least one Linear issue id or identifier.", code: "validation_error" });
  if (issueIds.length > 25) return response(400, { ok: false, error: "Batch import is limited to 25 Linear issues at a time.", code: "limit_exceeded" });
  try {
    const results = [];
    for (const issueId of issueIds) {
      const issue = await client.getIssue(issueId);
      const result = await importLinearIssue(ctx.taskStore, issue);
      results.push({ ...result, task: undefined });
    }
    return response(200, {
      ok: true,
      results,
      imported: results.filter((result) => result.imported).length,
      duplicates: results.filter((result) => result.duplicate).length,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const linearImportRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/status", handler: getLinearStatus, description: "Check Linear import plugin authentication status." },
  { method: "POST", path: "/issues", handler: listLinearIssues, description: "List/search Linear issues using plugin settings." },
  { method: "POST", path: "/issues/detail", handler: getLinearIssueDetail, description: "Fetch one Linear issue by id or identifier." },
  { method: "POST", path: "/issues/import", handler: importSingleLinearIssue, description: "Import one Linear issue as a Fusion task." },
  { method: "POST", path: "/issues/import-batch", handler: importBatchLinearIssues, description: "Import selected Linear issues as Fusion tasks." },
];
