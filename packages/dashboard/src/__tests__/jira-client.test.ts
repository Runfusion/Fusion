import { describe, expect, it, vi } from "vitest";
import { JiraApiError, JiraClient } from "../jira.js";

const auth = {
  apiBaseUrl: "https://acme.atlassian.net/rest/api/3",
  webBaseUrl: "https://acme.atlassian.net",
  headerName: "Authorization" as const,
  headerValue: "Bearer test-token",
  scheme: "bearer" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("JiraClient", () => {
  it("reads only the requested summary with the configured authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ fields: { summary: "My Slug", description: "ignored" } }));
    const client = new JiraClient(auth, fetchImpl as typeof fetch);

    await expect(client.getIssueSummary("PRD-1234")).resolves.toEqual({ key: "PRD-1234", summary: "My Slug" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://acme.atlassian.net/rest/api/3/issue/PRD-1234?fields=summary",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer test-token" },
        redirect: "error",
      }),
    );
  });

  it("maps generic upstream status failures to a safe route-facing reason", async () => {
    const client = new JiraClient(auth, vi.fn().mockResolvedValue(jsonResponse({}, 500)) as typeof fetch);
    await expect(client.getIssueSummary("PRD-1234")).rejects.toMatchObject({
      status: 500,
      message: "upstream_error",
    } satisfies Partial<JiraApiError>);
  });

  it("caps streamed response bytes and cancels an oversized body before parsing", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024 + 1)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 200 });
    const client = new JiraClient(auth, vi.fn().mockResolvedValue(response) as typeof fetch);

    await expect(client.getIssueSummary("PRD-1234")).rejects.toMatchObject({
      status: 0,
      message: "network_error",
    } satisfies Partial<JiraApiError>);
    expect(cancelled).toBe(true);
  });
});
