import { describe, expect, it, vi } from "vitest";
import { buildLinearIssueFilter, clampLinearLimit, LinearClient, LinearApiError, LINEAR_GRAPHQL_ENDPOINT } from "../linear-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("LinearClient", () => {
  it("constructs auth headers without leaking the token in errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "Bad token secret-linear-token" }] }, 401)) as unknown as typeof fetch;
    const client = new LinearClient("secret-linear-token", fetchImpl);
    await expect(client.listIssues()).rejects.toMatchObject({ message: "Linear API key is missing, invalid, or expired." });
    expect(fetchImpl).toHaveBeenCalledWith(LINEAR_GRAPHQL_ENDPOINT, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "secret-linear-token" }),
    }));
    await client.listIssues().catch((error) => {
      expect(String(error.message)).not.toContain("secret-linear-token");
    });
  });

  it("passes bounded GraphQL variables and state/team filters", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        issues: {
          nodes: [{ id: "iss-1", identifier: "ENG-1", title: "Bug", url: "https://linear.app/acme/issue/ENG-1/bug", labels: { nodes: [] } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })) as unknown as typeof fetch;
    const client = new LinearClient("token", fetchImpl);
    const result = await client.listIssues({ limit: 999, teamKey: "ENG", state: "active", query: "bug", assigneeId: "user-1" });
    expect(result.issues).toHaveLength(1);
    const body = JSON.parse(String((fetchImpl as any).mock.calls[0][1].body));
    expect(body.variables.first).toBe(50);
    expect(body.variables.filter.and).toEqual(expect.arrayContaining([
      { state: { type: { eq: "active" } } },
      { assignee: { id: { eq: "user-1" } } },
    ]));
  });

  it("follows cursor pagination within bounds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { issues: { nodes: [{ id: "iss-1", identifier: "ENG-1", title: "One", url: "https://linear.app/acme/issue/ENG-1/one", labels: { nodes: [] } }], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { issues: { nodes: [{ id: "iss-2", identifier: "ENG-2", title: "Two", url: "https://linear.app/acme/issue/ENG-2/two", labels: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    const client = new LinearClient("token", fetchImpl as unknown as typeof fetch);
    const result = await client.listIssues({ limit: 2 });
    expect(result.issues.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2"]);
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1][1].body));
    expect(secondBody.variables.after).toBe("cursor-1");
  });

  it("maps GraphQL and rate-limit errors to safe messages", async () => {
    const graphqlFetch = vi.fn(async () => jsonResponse({ errors: [{ message: "Variable invalid" }] })) as unknown as typeof fetch;
    await expect(new LinearClient("token", graphqlFetch).listIssues()).rejects.toMatchObject({
      message: "Linear GraphQL error: Variable invalid",
      code: "graphql_error",
    });

    const rateLimitFetch = vi.fn(async () => jsonResponse({ message: "nope" }, 429)) as unknown as typeof fetch;
    await expect(new LinearClient("token", rateLimitFetch).listIssues()).rejects.toMatchObject({
      message: "Linear rate limit exceeded. Try again later.",
    });
  });

  it("validates empty issue detail identifiers", async () => {
    await expect(new LinearClient("token", vi.fn() as unknown as typeof fetch).getIssue(" ")).rejects.toBeInstanceOf(LinearApiError);
  });
});

describe("Linear query helpers", () => {
  it("clamps list limits", () => {
    expect(clampLinearLimit(undefined)).toBe(30);
    expect(clampLinearLimit(0)).toBe(1);
    expect(clampLinearLimit(999)).toBe(100);
  });

  it("omits all-state filters", () => {
    expect(buildLinearIssueFilter({ state: "all" })).toBeUndefined();
  });
});
