// @vitest-environment node
/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 remote-node forwards. The generic wildcard builds its upstream path differently from
 * `proxyToRemoteNode`, so these two routes are explicit and must stay AHEAD of it. The assertions
 * below pin the things that silently break a remote search: a missing `/api` prefix, dropped query
 * parameters, a POST forwarded without its body, a swallowed upstream status, and — worst of all —
 * a fallback to the LOCAL store, which would show another project's tasks as if they were the
 * remote node's.
 *
 * The four pre-existing forwards are covered here as explicit non-regression controls because this
 * task widened the shared helper they all use.
 */
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerProxyRoutes } from "../register-proxy-routes.js";
import { AI_TASK_SEARCH_PROXY_TIMEOUT_MS } from "../../shared/task-search.js";

const central = vi.hoisted(() => ({
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getNode: vi.fn(),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return { ...actual, CentralCore: vi.fn().mockImplementation(function () { return central; }) };
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeApp(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return fetchImpl(String(url), init);
  }));

  const router = express.Router();
  const logger = { child: () => logger, error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  registerProxyRoutes(router, {
    store: { getGlobalSettingsDir: () => "/global" } as never,
    runtimeLogger: logger as never,
  });
  const server = express();
  server.use(express.json());
  server.use("/api", router);
  server.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(err.statusCode ?? 500).json({ error: err.message }));
  return { server, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  central.getNode.mockResolvedValue({ id: "node-b", type: "remote", url: "https://node-b.example", apiKey: "node-key" });
});

describe("GET /api/proxy/:nodeId/tasks/page", () => {
  it("forwards to the remote /api path with every query parameter and the node key", async () => {
    const { server, calls } = makeApp(async () => jsonResponse({ tasks: [{ id: "FN-1" }], hasMore: false, nextCursor: null, total: 1 }));

    const response = await request(
      server,
      "GET",
      "/api/proxy/node-b/tasks/page?projectId=proj-9&q=collapse&limit=50&cursor=abc",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tasks: [{ id: "FN-1" }], hasMore: false, nextCursor: null, total: 1 });
    expect(calls).toHaveLength(1);
    // The `/api` prefix is the helper's contract; the wildcard does NOT add it.
    expect(calls[0].url).toBe("https://node-b.example/api/tasks/page?projectId=proj-9&q=collapse&limit=50&cursor=abc");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer node-key");
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("preserves the remote error status instead of falling back to the local store", async () => {
    const { server, calls } = makeApp(async () => jsonResponse({ error: "boom" }, 503));
    const response = await request(server, "GET", "/api/proxy/node-b/tasks/page?projectId=proj-9&q=x");
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it("refuses a local node rather than serving local rows under a remote identity", async () => {
    central.getNode.mockResolvedValue({ id: "local", type: "local", url: "" });
    const { server, calls } = makeApp(async () => jsonResponse({}));
    const response = await request(server, "GET", "/api/proxy/local/tasks/page?q=x");
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns 404 for an unknown node", async () => {
    central.getNode.mockResolvedValue(undefined);
    const { server } = makeApp(async () => jsonResponse({}));
    expect((await request(server, "GET", "/api/proxy/ghost/tasks/page?q=x")).status).toBe(404);
  });
});

describe("POST /api/proxy/:nodeId/ai/search-tasks", () => {
  it("forwards the parsed JSON body as a POST to the remote /api path", async () => {
    const { server, calls } = makeApp(async () => jsonResponse({ query: "collapse", tasks: [{ id: "FN-1" }] }));

    const response = await request(
      server,
      "POST",
      "/api/proxy/node-b/ai/search-tasks?projectId=proj-9",
      JSON.stringify({ query: "collapse" }),
      { "Content-Type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ query: "collapse", tasks: [{ id: "FN-1" }] });
    expect(calls[0].url).toBe("https://node-b.example/api/ai/search-tasks?projectId=proj-9");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "collapse" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer node-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("passes an abort signal so a downstream disconnect can stop the upstream generation", async () => {
    const { server, calls } = makeApp(async () => jsonResponse({ query: "q", tasks: [] }));
    await request(server, "POST", "/api/proxy/node-b/ai/search-tasks", JSON.stringify({ query: "q" }), { "Content-Type": "application/json" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the longer AI budget so a real answer is not masked as a gateway timeout", async () => {
    // The generic 10s helper default would abort before the 25s upstream generation budget elapses.
    expect(AI_TASK_SEARCH_PROXY_TIMEOUT_MS).toBeGreaterThan(25_000);

    let observedDeadline = 0;
    const { server } = makeApp(async (_url, init) => {
      const signal = init.signal as AbortSignal;
      // Prove the request is not aborted well before the AI budget by sampling after a short wait.
      await new Promise((resolve) => setTimeout(resolve, 30));
      observedDeadline = signal.aborted ? 0 : 1;
      return jsonResponse({ query: "q", tasks: [] });
    });
    await request(server, "POST", "/api/proxy/node-b/ai/search-tasks", JSON.stringify({ query: "q" }), { "Content-Type": "application/json" });
    expect(observedDeadline).toBe(1);
  });

  it("surfaces a remote 429/503 verbatim with no local fallback", async () => {
    for (const status of [429, 503]) {
      const { server, calls } = makeApp(async () => jsonResponse({ error: "AI_TASK_SEARCH_RATE_LIMIT" }, status));
      const response = await request(server, "POST", "/api/proxy/node-b/ai/search-tasks", JSON.stringify({ query: "q" }), { "Content-Type": "application/json" });
      expect(response.status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  it("reports an unreachable node as 502 rather than an empty result set", async () => {
    const { server } = makeApp(async () => { throw new TypeError("fetch failed"); });
    const response = await request(server, "POST", "/api/proxy/node-b/ai/search-tasks", JSON.stringify({ query: "q" }), { "Content-Type": "application/json" });
    expect(response.status).toBe(502);
  });

  it("reports an upstream timeout as 504 rather than an empty result set", async () => {
    const { server } = makeApp(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const response = await request(server, "POST", "/api/proxy/node-b/ai/search-tasks", JSON.stringify({ query: "q" }), { "Content-Type": "application/json" });
    expect(response.status).toBe(504);
  });
});

describe("pre-existing forwards are unchanged", () => {
  it.each([
    ["/health", "/api/proxy/node-b/health", "https://node-b.example/api/health"],
    ["/projects", "/api/proxy/node-b/projects", "https://node-b.example/api/projects"],
    ["/tasks", "/api/proxy/node-b/tasks?projectId=p&q=z", "https://node-b.example/api/tasks?projectId=p&q=z"],
    ["/project-health", "/api/proxy/node-b/project-health?projectId=p", "https://node-b.example/api/project-health?projectId=p"],
  ])("keeps %s a plain GET with no body", async (_label, path, expectedUrl) => {
    const { server, calls } = makeApp(async () => jsonResponse({ ok: true }));
    const response = await request(server, "GET", path);
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe(expectedUrl);
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });
});
