import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMetrics } from "../project-runtime.js";
import { RemoteNodeClient } from "./remote-node-client.js";

const BASE_URL = "https://node.example.com";
const API_KEY = "secret-token";

describe("RemoteNodeClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("health() parses successful response and sends auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", version: "1.0.0", uptime: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });
    const health = await client.health();

    expect(health).toEqual({ status: "ok", version: "1.0.0", uptime: 123 });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/api/health`, expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({
        Authorization: `Bearer ${API_KEY}`,
      }),
    }));
  });

  it("getMetrics() parses runtime metrics", async () => {
    const metrics: RuntimeMetrics = {
      inFlightTasks: 4,
      activeAgents: 2,
      lastActivityAt: "2026-04-08T00:00:00.000Z",
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(metrics), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });
    await expect(client.getMetrics()).resolves.toEqual(metrics);
  });

  it("createTask() sends POST with JSON body", async () => {
    const createdTask = {
      id: "KB-001",
      description: "Create me",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      status: "pending",
      log: [],
      attachments: [],
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
      size: "M",
      reviewLevel: 1,
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createdTask), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });
    await client.createTask({ description: "Create me" });

    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/api/tasks`, expect.any(Object));
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual(expect.objectContaining({
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    }));
    expect(options.body).toBe(JSON.stringify({ description: "Create me" }));
  });

  it("listTasks() sends optional query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });
    await client.listTasks({ column: "in-progress", limit: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/api/tasks?column=in-progress&limit=10`,
      expect.objectContaining({ method: "GET" })
    );
  });

  it("executeTask() posts to execute endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ acknowledged: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });
    const result = await client.executeTask("KB-123");

    expect(result).toEqual({ acknowledged: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/api/tasks/KB-123/execute`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("streamEvents() yields parsed events from SSE stream", async () => {
    const sseBody = [
      "event: task:created",
      'data: {"type":"task:created","payload":{"id":"KB-1"},"timestamp":"2026-04-08T00:00:00.000Z"}',
      "",
      "event: task:updated",
      'data: {"type":"task:updated","payload":{"id":"KB-1","column":"in-progress"},"timestamp":"2026-04-08T00:01:00.000Z"}',
      "",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    ) as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });

    const events: unknown[] = [];
    for await (const event of client.streamEvents()) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "task:created",
        payload: { id: "KB-1" },
        timestamp: "2026-04-08T00:00:00.000Z",
      },
      {
        type: "task:updated",
        payload: { id: "KB-1", column: "in-progress" },
        timestamp: "2026-04-08T00:01:00.000Z",
      },
    ]);
  });

  it("retries on network errors", async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ok", version: "1.0.0", uptime: 123 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });

    const request = client.health();
    const expectation = expect(request).resolves.toEqual({
      status: "ok",
      version: "1.0.0",
      uptime: 123,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });

    await expect(client.health()).rejects.toThrow("401 Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx responses", async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("server error", { status: 500, statusText: "Internal Server Error" })
      )
      .mockResolvedValueOnce(
        new Response("server error", { status: 502, statusText: "Bad Gateway" })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ok", version: "1.0.0", uptime: 999 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });

    const request = client.health();
    const expectation = expect(request).resolves.toEqual({
      status: "ok",
      version: "1.0.0",
      uptime: 999,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts requests after timeoutMs", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockImplementation((_: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 5,
    });

    const request = client.health();
    const expectation = expect(request).rejects.toThrow("timed out");

    await vi.runAllTimersAsync();
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("sends auth header on all request methods", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ok", version: "1.0.0", uptime: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ inFlightTasks: 0, activeAgents: 0, lastActivityAt: "now" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ acknowledged: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response("event: ping\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new RemoteNodeClient({ baseUrl: BASE_URL, apiKey: API_KEY });

    await client.health();
    await client.getMetrics();
    await client.listTasks();
    await client.executeTask("KB-777");
    for await (const _event of client.streamEvents()) {
      // Drain one-response event stream
    }

    for (const call of fetchMock.mock.calls) {
      const options = call[1] as RequestInit;
      expect(options.headers).toEqual(
        expect.objectContaining({
          Authorization: `Bearer ${API_KEY}`,
        })
      );
    }
  });
});
