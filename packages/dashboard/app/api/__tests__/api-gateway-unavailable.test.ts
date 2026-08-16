/*
FNXC:DashboardApi 2026-08-16-03:09:
Planning Retry dumped the raw content-type diagnostic when a reverse proxy returned 503
text/plain "no available server". These cases pin the invariant across every dashboard
fetch parser that previously echoed that body: `api()` (Planning retry), deleteAiSession,
and summarizeTitle.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  SERVER_UNAVAILABLE_MESSAGE,
  errorFromUnparseableApiResponse,
  isGatewayUnavailableStatus,
} from "../client/client.js";
import { deleteAiSession } from "../planning/ai-sessions.js";
import { summarizeTitle } from "../planning/ai-summarize.js";
import { retryPlanningSession } from "../planning/planning.js";

function mockPlainResponse(status: number, body: string, contentType: string, statusText = ""): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { "content-type": contentType },
  });
}

describe("gateway unavailable API errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies 502/503/504 as gateway unavailable", () => {
    expect(isGatewayUnavailableStatus(502)).toBe(true);
    expect(isGatewayUnavailableStatus(503)).toBe(true);
    expect(isGatewayUnavailableStatus(504)).toBe(true);
    expect(isGatewayUnavailableStatus(500)).toBe(false);
    expect(isGatewayUnavailableStatus(404)).toBe(false);
  });

  it("maps Traefik-style 503 text/plain to the operator-facing unavailable message", () => {
    const error = errorFromUnparseableApiResponse({
      url: "/api/planning/11583415-c13c-4075-9373-4ed3cf69cd3f/retry?projectId=proj_5102b90f58514a4e",
      status: 503,
      statusText: "",
      contentType: "text/plain; charset=utf-8",
      bodyText: "no available server",
    });

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.message).toBe(SERVER_UNAVAILABLE_MESSAGE);
    expect((error as ApiRequestError).status).toBe(503);
    expect(error.message).not.toContain("text/plain");
    expect(error.message).not.toContain("no available server");
  });

  it("keeps HTML misconfiguration diagnostics for non-gateway statuses", () => {
    const error = errorFromUnparseableApiResponse({
      url: "/api/tasks",
      status: 404,
      statusText: "Not Found",
      contentType: "text/html",
      bodyText: "<!doctype html><html><body>Not Found</body></html>",
    });

    expect(error.message).toContain("API returned HTML instead of JSON for /api/tasks");
    expect(error.message).toContain("404 Not Found");
  });

  it("maps Planning retry 503 text/plain to the unavailable message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockPlainResponse(503, "no available server", "text/plain; charset=utf-8"),
    );

    await expect(
      retryPlanningSession("11583415-c13c-4075-9373-4ed3cf69cd3f", "proj_5102b90f58514a4e"),
    ).rejects.toMatchObject({
      name: "ApiRequestError",
      message: SERVER_UNAVAILABLE_MESSAGE,
      status: 503,
    });
  });

  it("maps deleteAiSession 503 text/plain to the unavailable message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockPlainResponse(503, "no available server", "text/plain; charset=utf-8"),
    );

    await expect(deleteAiSession("session-1")).rejects.toMatchObject({
      name: "ApiRequestError",
      message: SERVER_UNAVAILABLE_MESSAGE,
      status: 503,
    });
  });

  it("maps summarizeTitle 503 text/plain to the unavailable message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockPlainResponse(503, "no available server", "text/plain; charset=utf-8"),
    );

    await expect(summarizeTitle("a".repeat(201))).rejects.toMatchObject({
      name: "ApiRequestError",
      message: SERVER_UNAVAILABLE_MESSAGE,
      status: 503,
    });
  });

  it("maps HTML 502 gateway pages to the unavailable message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockPlainResponse(502, "<html>Bad Gateway</html>", "text/html"),
    );

    await expect(retryPlanningSession("session-1")).rejects.toMatchObject({
      name: "ApiRequestError",
      message: SERVER_UNAVAILABLE_MESSAGE,
      status: 502,
    });
  });

  it("still surfaces JSON 503 error fields from Fusion itself", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Session store not available" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(retryPlanningSession("session-1")).rejects.toMatchObject({
      name: "ApiRequestError",
      message: "Session store not available",
      status: 503,
    });
  });
});
