import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { browseLinearIssuesTool, importLinearIssuesTool, importLinearIssueTool, linearImportTools } from "../tools.js";

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
      createTask: vi.fn(async (input) => ({ id: "FN-10", ...input })),
    },
  } as unknown as PluginContext;
}

afterEach(() => vi.unstubAllGlobals());

describe("linear plugin tools", () => {
  it("registers explicit browse/import tool names", () => {
    expect(linearImportTools.map((tool) => tool.name)).toEqual(["linear_import_browse_issues", "linear_import_issue", "linear_import_issues"]);
  });

  it("reports missing API key safely", async () => {
    const result = await browseLinearIssuesTool.execute({}, ctx({}));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
  });

  it("browses empty and populated issue lists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { issues: { nodes: [rawIssue()], pageInfo: { hasNextPage: false, endCursor: null } } } })));
    const result = await browseLinearIssuesTool.execute({ query: "bug", limit: 5 }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("ENG-1");
    expect((result.details as any).issues).toHaveLength(1);
  });

  it("imports a single issue and skips duplicates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { issue: rawIssue() } })));
    const imported = await importLinearIssueTool.execute({ issueId: "ENG-1" }, ctx());
    expect(imported.content[0].text).toContain("Imported Linear issue ENG-1 as task FN-10");

    const duplicate = await importLinearIssueTool.execute({ issueId: "ENG-1" }, ctx({ apiKey: "token" }, [{ id: "FN-2", description: `Source: ${rawIssue().url}` }]));
    expect(duplicate.content[0].text).toContain("existing task FN-2");
    expect(duplicate.details).toMatchObject({ duplicate: true, taskId: "FN-2" });
  });

  it("imports batches with safe summaries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const id = JSON.parse(String((init as RequestInit).body)).variables.id;
      return jsonResponse({ data: { issue: rawIssue(`iss-${id}`, String(id)) } });
    }));
    const result = await importLinearIssuesTool.execute({ issueIds: ["ENG-1", "ENG-2"] }, ctx());
    expect(result.content[0].text).toContain("2 imported, 0 duplicates");
  });

  it("maps GraphQL errors without token leakage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: [{ message: "bad token-secret" }] })));
    const result = await browseLinearIssuesTool.execute({}, ctx({ apiKey: "token-secret" }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("token-secret");
  });
});
