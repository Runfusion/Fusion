import type { PluginContext, PluginToolDefinition, PluginToolResult } from "@fusion/plugin-sdk";
import { LinearClient, linearErrorToResponse, type LinearIssueListOptions } from "./linear-client.js";
import { importLinearIssue } from "./import-linear.js";
import { resolveLinearSettings } from "./settings.js";

function textResult(text: string, details?: Record<string, unknown>, isError = false): PluginToolResult {
  return { content: [{ type: "text", text }], details, isError };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getClient(ctx: PluginContext): LinearClient | PluginToolResult {
  const settings = resolveLinearSettings(ctx.settings);
  if (!settings.apiKey) {
    return textResult("Linear Import is not configured. Add a Linear API key in Plugin Manager settings.", { code: "missing_api_key" }, true);
  }
  return new LinearClient(settings.apiKey);
}

function listOptions(params: Record<string, unknown>, ctx: PluginContext): LinearIssueListOptions {
  const settings = resolveLinearSettings(ctx.settings);
  return {
    query: readString(params.query),
    teamKey: readString(params.teamKey) ?? readString(params.teamId) ?? settings.defaultTeamKey,
    state: (readString(params.state) ?? settings.defaultStateFilter) as LinearIssueListOptions["state"],
    assigneeId: readString(params.assigneeId) ?? settings.defaultAssigneeId,
    limit: readNumber(params.limit),
    after: readString(params.after),
  };
}

function safeErrorResult(error: unknown): PluginToolResult {
  const mapped = linearErrorToResponse(error);
  return textResult(`Linear import failed: ${mapped.error}`, { code: mapped.code, status: mapped.status }, true);
}

const browseParams = {
  type: "object",
  properties: {
    query: { type: "string", description: "Optional text search over Linear issue title, description, or identifier." },
    teamKey: { type: "string", description: "Optional Linear team key or UUID." },
    state: { type: "string", enum: ["active", "backlog", "started", "unstarted", "completed", "canceled", "all"], description: "Optional Linear state type filter." },
    assigneeId: { type: "string", description: "Optional Linear assignee user UUID." },
    limit: { type: "number", minimum: 1, maximum: 100, description: "Maximum issues to return." },
    after: { type: "string", description: "Optional Linear pagination cursor." },
  },
  required: [],
};

export const browseLinearIssuesTool: PluginToolDefinition = {
  name: "linear_import_browse_issues",
  description: "Browse/search Linear issues through the Linear Import plugin settings.",
  parameters: browseParams,
  execute: async (params, ctx) => {
    const client = getClient(ctx);
    if (!(client instanceof LinearClient)) return client;
    try {
      const result = await client.listIssues(listOptions(params, ctx));
      const lines = result.issues.length === 0
        ? ["No Linear issues matched the filters."]
        : result.issues.map((issue) => `- ${issue.identifier}: ${issue.title} (${issue.url})`);
      return textResult(lines.join("\n"), { issues: result.issues, pageInfo: result.pageInfo });
    } catch (error) {
      return safeErrorResult(error);
    }
  },
};

export const importLinearIssueTool: PluginToolDefinition = {
  name: "linear_import_issue",
  description: "Import one Linear issue into Fusion as a triage task, skipping duplicates.",
  parameters: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "Linear issue UUID or human identifier such as ENG-123." },
    },
    required: ["issueId"],
  },
  execute: async (params, ctx) => {
    const issueId = readString(params.issueId);
    if (!issueId) return textResult("issueId is required.", { code: "validation_error" }, true);
    const client = getClient(ctx);
    if (!(client instanceof LinearClient)) return client;
    try {
      const issue = await client.getIssue(issueId);
      const result = await importLinearIssue(ctx.taskStore, issue);
      const message = result.duplicate
        ? `Skipped duplicate Linear issue ${issue.identifier}; existing task ${result.taskId}.`
        : `Imported Linear issue ${issue.identifier} as task ${result.taskId}.`;
      return textResult(message, { imported: result.imported, duplicate: result.duplicate, taskId: result.taskId, issue: result.issue });
    } catch (error) {
      return safeErrorResult(error);
    }
  },
};

export const importLinearIssuesTool: PluginToolDefinition = {
  name: "linear_import_issues",
  description: "Import multiple Linear issues into Fusion as triage tasks, skipping duplicates.",
  parameters: {
    type: "object",
    properties: {
      issueIds: { type: "array", items: { type: "string" }, description: "Linear issue UUIDs or identifiers to import. Maximum 25." },
    },
    required: ["issueIds"],
  },
  execute: async (params, ctx) => {
    const issueIds = Array.isArray(params.issueIds) ? params.issueIds.map(readString).filter((id): id is string => Boolean(id)) : [];
    if (issueIds.length === 0) return textResult("issueIds must include at least one Linear issue id or identifier.", { code: "validation_error" }, true);
    if (issueIds.length > 25) return textResult("Batch import is limited to 25 Linear issues at a time.", { code: "limit_exceeded" }, true);
    const client = getClient(ctx);
    if (!(client instanceof LinearClient)) return client;
    try {
      const results = [];
      for (const issueId of issueIds) {
        const issue = await client.getIssue(issueId);
        results.push(await importLinearIssue(ctx.taskStore, issue));
      }
      const imported = results.filter((result) => result.imported).length;
      const duplicates = results.filter((result) => result.duplicate).length;
      return textResult(`Linear batch import complete: ${imported} imported, ${duplicates} duplicates skipped.`, {
        imported,
        duplicates,
        results: results.map((result) => ({ imported: result.imported, duplicate: result.duplicate, taskId: result.taskId, issue: result.issue })),
      });
    } catch (error) {
      return safeErrorResult(error);
    }
  },
};

export const linearImportTools: PluginToolDefinition[] = [browseLinearIssuesTool, importLinearIssueTool, importLinearIssuesTool];
