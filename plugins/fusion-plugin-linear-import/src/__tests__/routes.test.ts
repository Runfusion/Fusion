import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { getLinearIssueDetail, getLinearStatus, importBatchLinearIssues, importSingleLinearIssue, listLinearIssues } from "../routes.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const rawIssue = (id = "iss-1", identifier = "ENG-1") => ({
  id,
  identifier,
  title: `Title ${identifier}`,
  description: "Body",
  url: `https://linear.app/acme/issue/${identifier}/title`,
  state: { name: "Todo", type: "unstarted" },
  team: { id: "team-1", key: "ENG", name: "Engineering" },
  labels: { nodes: [] },
});

function ctx(settings: Record<string, unknown> = { apiKey: "token" }, tasks: any[] = []): PluginContext {
  return {
    pluginId: "fusion-plugin-linear-import",
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: {
      listTasks: vi.fn(async () => tasks),
      createTask: vi.fn(async (input) => ({ id: "FN-9", ...input })),
    },
  } as unknown as PluginContext;
}

afterEach(() => vi.unstubAllGlobals());

describe("linear plugin routes", () => {
  it("returns missing auth without calling Linear", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(listLinearIssues({ body: {} }, ctx({}))).resolves.toMatchObject({ status: 401, body: { code: "missing_api_key" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates auth status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })));
    await expect(getLinearStatus({}, ctx({ apiKey: "token", defaultStateFilter: "active" }))).resolves.toMatchObject({ status: 200, body: { authenticated: true } });
  });

  it("lists empty and populated issues with pagination metadata", async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: { issues: { nodes: [rawIssue()], pageInfo: { hasNextPage: true, endCursor: "next" } } } }));
    vi.stubGlobal("fetch", fetch);
    const result = await listLinearIssues({ body: { teamKey: "ENG", limit: 1 } }, ctx());
    expect(result).toMatchObject({ status: 200, body: { ok: true, pageInfo: { hasNextPage: true, endCursor: "next" } } });
    expect((result.body as any).issues[0].identifier).toBe("ENG-1");
  });

  it("fetches single issue detail and maps GraphQL errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: [{ message: "broken" }] })));
    await expect(getLinearIssueDetail({ body: { issueId: "ENG-1" } }, ctx())).resolves.toMatchObject({ status: 400, body: { code: "graphql_error" } });
  });

  it("imports one issue and creates a triage task", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { issue: rawIssue() } })));
    const context = ctx();
    const result = await importSingleLinearIssue({ body: { issueId: "ENG-1" } }, context);
    expect(result).toMatchObject({ status: 201, body: { imported: true, duplicate: false, taskId: "FN-9" } });
    /* FNXC:WorkflowLifecycleColumns 2026-07-30-16:35: the route must not name a column either —
       `createTask` resolves the workflow's intake lane. Pinned `"triage"` before, a column U11 deleted. */
    expect((context.taskStore as any).createTask).toHaveBeenCalledWith(expect.not.objectContaining({ column: expect.anything() }));
  });

  it("returns duplicate task id for existing imported issue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { issue: rawIssue() } })));
    const existing = { id: "FN-2", description: "", source: { sourceType: "api", sourceMetadata: { provider: "linear", issueId: "iss-1" } } };
    const result = await importSingleLinearIssue({ body: { issueId: "ENG-1" } }, ctx({ apiKey: "token" }, [existing]));
    expect(result).toMatchObject({ status: 200, body: { imported: false, duplicate: true, taskId: "FN-2" } });
  });

  it("imports batches and validates bounds", async () => {
    await expect(importBatchLinearIssues({ body: { issueIds: [] } }, ctx())).resolves.toMatchObject({ status: 400 });
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const id = JSON.parse(String((init as RequestInit).body)).variables.id;
      return jsonResponse({ data: { issue: rawIssue(`iss-${id}`, String(id)) } });
    }));
    const result = await importBatchLinearIssues({ body: { issueIds: ["ENG-1", "ENG-2"] } }, ctx());
    expect(result).toMatchObject({ status: 200, body: { imported: 2, duplicates: 0 } });
  });

  it("does not change GitHub or GitLab route namespaces", () => {
    expect(["/status", "/issues", "/issues/detail", "/issues/import", "/issues/import-batch"]).not.toContain("/api/github/issues/import");
    expect(["/status", "/issues"]).not.toContain("/api/gitlab/issues/import");
  });
});
