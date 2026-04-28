import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsMe,
  createIssue,
  getIssue,
  getIssueComments,
  getRunEvents,
  listCompanyAgents,
  mintAgentApiKeyViaCli,
  probePaperclipConnection,
  resolvePaperclipConfig,
  wakeAgent,
} from "../paperclip-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function networkError(): never {
  throw new TypeError("fetch failed: ECONNREFUSED");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// resolvePaperclipConfig
// ---------------------------------------------------------------------------

describe("resolvePaperclipConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("prefers plugin settings over env vars", () => {
    process.env.PAPERCLIP_API_URL = "http://env-host:3100";
    process.env.PAPERCLIP_API_KEY = "env-key";
    const config = resolvePaperclipConfig({
      apiUrl: "http://settings-host:4000/",
      apiKey: "settings-key",
      agentId: "AG-set",
      companyId: "CO-set",
      mode: "issue-per-prompt",
    });
    expect(config.apiUrl).toBe("http://settings-host:4000");
    expect(config.apiKey).toBe("settings-key");
    expect(config.agentId).toBe("AG-set");
    expect(config.companyId).toBe("CO-set");
    expect(config.mode).toBe("issue-per-prompt");
  });

  it("falls back to env vars then defaults", () => {
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_AGENT_ID;
    delete process.env.PAPERCLIP_COMPANY_ID;
    delete process.env.PAPERCLIP_RUNTIME_MODE;

    const config = resolvePaperclipConfig();
    expect(config.apiUrl).toBe("http://localhost:3100");
    expect(config.apiKey).toBeUndefined();
    expect(config.mode).toBe("rolling-issue");
    expect(config.runTimeoutMs).toBe(600_000);
  });
});

// ---------------------------------------------------------------------------
// agentsMe
// ---------------------------------------------------------------------------

describe("agentsMe", () => {
  it("happy path — returns parsed identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "AG-1",
        name: "Coder",
        role: "engineer",
        companyId: "CO-1",
        companyName: "Acme",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentsMe("http://localhost:3100", "key");
    expect(result).toEqual({
      agentId: "AG-1",
      agentName: "Coder",
      role: "engineer",
      companyId: "CO-1",
      companyName: "Acme",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/agents/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer key" }),
      }),
    );
  });

  it("no apiKey → no Authorization header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "AG-1", companyId: "CO-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await agentsMe("http://localhost:3100");
    const call = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = call.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("401 → throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401)),
    );
    await expect(agentsMe("http://localhost:3100", "bad")).rejects.toThrow(
      /401/,
    );
  });

  it("connect refused → throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => networkError()));
    await expect(agentsMe("http://localhost:3100", "k")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createIssue
// ---------------------------------------------------------------------------

describe("createIssue", () => {
  it("posts correct body to /companies/{id}/issues", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "ISS-1", status: "todo" }));
    vi.stubGlobal("fetch", fetchMock);

    await createIssue("http://localhost:3100", "k", "CO-1", {
      title: "Fix bug",
      description: "details",
      status: "todo",
      assigneeAgentId: "AG-1",
      projectId: "PROJ-1",
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3100/api/companies/CO-1/issues");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toMatchObject({
      title: "Fix bug",
      assigneeAgentId: "AG-1",
      projectId: "PROJ-1",
    });
  });
});

// ---------------------------------------------------------------------------
// wakeAgent
// ---------------------------------------------------------------------------

describe("wakeAgent", () => {
  it("posts wakeup with idempotency key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "RUN-1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await wakeAgent("http://localhost:3100", "k", "AG-1", {
      source: "on_demand",
      triggerDetail: "manual",
      idempotencyKey: "session-1:1",
      payload: { hello: "world" },
    });

    expect(result).toEqual({ id: "RUN-1", status: "queued" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3100/api/agents/AG-1/wakeup");
    expect(JSON.parse(opts.body as string).idempotencyKey).toBe("session-1:1");
  });
});

// ---------------------------------------------------------------------------
// getRunEvents
// ---------------------------------------------------------------------------

describe("getRunEvents", () => {
  it("uses afterSeq + limit query params", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ seq: 5, type: "heartbeat.run.status", payload: {} }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRunEvents("http://localhost:3100", "k", "RUN-1", 4, 50);
    expect(result).toEqual([{ seq: 5, type: "heartbeat.run.status", payload: {} }]);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/heartbeat-runs/RUN-1/events?");
    expect(url).toContain("afterSeq=4");
    expect(url).toContain("limit=50");
  });

  it("accepts both bare-array and { events: [...] } envelopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ events: [{ seq: 1, type: "x", payload: {} }] }))
        .mockResolvedValueOnce(jsonResponse([{ seq: 2, type: "y", payload: {} }])),
    );
    const a = await getRunEvents("http://localhost:3100", "k", "R", 0);
    const b = await getRunEvents("http://localhost:3100", "k", "R", 0);
    expect(a.map((e) => e.type)).toEqual(["x"]);
    expect(b.map((e) => e.type)).toEqual(["y"]);
  });
});

// ---------------------------------------------------------------------------
// getIssue / getIssueComments
// ---------------------------------------------------------------------------

describe("getIssue / getIssueComments", () => {
  it("getIssue fetches /issues/{id}", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "ISS-1", status: "done" }));
    vi.stubGlobal("fetch", fetchMock);
    await getIssue("http://localhost:3100", "k", "ISS-1");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:3100/api/issues/ISS-1",
    );
  });

  it("getIssueComments returns array", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: "C-1", body: "hi" }]));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getIssueComments("http://localhost:3100", "k", "ISS-1");
    expect(result).toEqual([{ id: "C-1", body: "hi" }]);
  });
});

// ---------------------------------------------------------------------------
// listCompanyAgents
// ---------------------------------------------------------------------------

describe("listCompanyAgents", () => {
  it("returns mapped agent summaries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: "AG-1", name: "Coder", role: "engineer", companyId: "CO-1", status: "active" },
        { id: "AG-2", name: "Reviewer", role: "reviewer", companyId: "CO-1" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listCompanyAgents("http://localhost:3100", "k", "CO-1");
    expect(result).toEqual([
      { id: "AG-1", name: "Coder", role: "engineer", companyId: "CO-1", status: "active" },
      { id: "AG-2", name: "Reviewer", role: "reviewer", companyId: "CO-1", status: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/companies/CO-1/agents",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer k" }),
      }),
    );
  });

  it("non-array response → empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "unexpected" })),
    );
    const result = await listCompanyAgents("http://localhost:3100", "k", "CO-1");
    expect(result).toEqual([]);
  });

  it("skips entries missing id; falls back name=id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { id: "AG-1", name: "Ok", companyId: "CO-1" },
          { name: "Missing-id", companyId: "CO-1" },
          null,
          { id: "AG-2", companyId: "CO-1" },
        ]),
      ),
    );
    const result = await listCompanyAgents("http://localhost:3100", "k", "CO-1");
    expect(result.map((a) => a.id)).toEqual(["AG-1", "AG-2"]);
    expect(result[1]).toMatchObject({ id: "AG-2", name: "AG-2" });
  });

  it("401 → throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401)),
    );
    await expect(
      listCompanyAgents("http://localhost:3100", "bad", "CO-1"),
    ).rejects.toThrow(/401/);
  });
});

// ---------------------------------------------------------------------------
// probePaperclipConnection
// ---------------------------------------------------------------------------

describe("probePaperclipConnection", () => {
  it("200 → available + identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: "AG-1",
          name: "Coder",
          role: "engineer",
          companyId: "CO-1",
          companyName: "Acme",
        }),
      ),
    );
    const result = await probePaperclipConnection({
      apiUrl: "http://localhost:3100",
      apiKey: "k",
    });
    expect(result.available).toBe(true);
    expect(result.identity).toMatchObject({
      agentId: "AG-1",
      agentName: "Coder",
      companyId: "CO-1",
    });
  });

  it("401 → unavailable with reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401)),
    );
    const result = await probePaperclipConnection({
      apiUrl: "http://localhost:3100",
      apiKey: "bad",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/rejected|401/i);
  });

  it("connect refused → unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => networkError()));
    const result = await probePaperclipConnection({
      apiUrl: "http://localhost:9999",
      apiKey: "k",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/not reachable|ECONNREFUSED|fetch failed/i);
  });
});

// ---------------------------------------------------------------------------
// mintAgentApiKeyViaCli
// ---------------------------------------------------------------------------

describe("mintAgentApiKeyViaCli", () => {
  // We mock node:child_process.spawn for each case.

  it("success path — parses apiKey from JSON", async () => {
    const mockPayload = {
      apiKey: "sk-test-mint-key",
      apiBase: "http://localhost:3100",
      agentId: "AG-1",
      companyId: "CO-1",
    };
    const { EventEmitter } = await import("node:events");
    const { Readable } = await import("node:stream");

    const fakeStdout = Readable.from([Buffer.from(JSON.stringify(mockPayload))]);
    const fakeStderr = Readable.from([]);
    const fakeChild = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
    (fakeChild as unknown as Record<string, unknown>).stdout = fakeStdout;
    (fakeChild as unknown as Record<string, unknown>).stderr = fakeStderr;
    (fakeChild as unknown as Record<string, unknown>).kill = vi.fn();

    const spawnMock = vi.fn().mockReturnValue(fakeChild);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    // Emit close asynchronously after mock is in place
    setImmediate(() => {
      fakeChild.emit("close", 0);
    });

    const result = await mintAgentApiKeyViaCli({ agentRef: "my-agent", companyId: "CO-1" });
    expect(result.apiKey).toBe("sk-test-mint-key");
    expect(result.apiBase).toBe("http://localhost:3100");
    expect(result.agentId).toBe("AG-1");
    expect(result.companyId).toBe("CO-1");

    vi.doUnmock("node:child_process");
  });

  it("ENOENT on spawn error → throws with install hint", async () => {
    const { EventEmitter } = await import("node:events");
    const { Readable } = await import("node:stream");

    const fakeChild = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
    (fakeChild as unknown as Record<string, unknown>).stdout = Readable.from([]);
    (fakeChild as unknown as Record<string, unknown>).stderr = Readable.from([]);
    (fakeChild as unknown as Record<string, unknown>).kill = vi.fn();

    const spawnMock = vi.fn().mockReturnValue(fakeChild);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    setImmediate(() => {
      const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      fakeChild.emit("error", err);
    });

    await expect(
      mintAgentApiKeyViaCli({ agentRef: "my-agent", cliBinaryPath: "/usr/local/bin/paperclipai", companyId: "CO-1" }),
    ).rejects.toThrow(/binary not found.*npm i -g paperclipai/i);

    vi.doUnmock("node:child_process");
  });

  it("non-zero exit → throws with stderr hint", async () => {
    const { EventEmitter } = await import("node:events");
    const { Readable } = await import("node:stream");

    const fakeStdout = Readable.from([]);
    const fakeStderr = Readable.from([Buffer.from("Error: CLI is not authenticated\n")]);
    const fakeChild = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
    (fakeChild as unknown as Record<string, unknown>).stdout = fakeStdout;
    (fakeChild as unknown as Record<string, unknown>).stderr = fakeStderr;
    (fakeChild as unknown as Record<string, unknown>).kill = vi.fn();

    const spawnMock = vi.fn().mockReturnValue(fakeChild);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    setImmediate(() => {
      fakeChild.emit("close", 1);
    });

    await expect(
      mintAgentApiKeyViaCli({ agentRef: "my-agent", companyId: "CO-1" }),
    ).rejects.toThrow(/exited 1.*paperclipai onboard/i);

    vi.doUnmock("node:child_process");
  });

  it("malformed JSON output → throws", async () => {
    const { EventEmitter } = await import("node:events");
    const { Readable } = await import("node:stream");

    const fakeStdout = Readable.from([Buffer.from("not-json-at-all")]);
    const fakeStderr = Readable.from([]);
    const fakeChild = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
    (fakeChild as unknown as Record<string, unknown>).stdout = fakeStdout;
    (fakeChild as unknown as Record<string, unknown>).stderr = fakeStderr;
    (fakeChild as unknown as Record<string, unknown>).kill = vi.fn();

    const spawnMock = vi.fn().mockReturnValue(fakeChild);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    setImmediate(() => {
      fakeChild.emit("close", 0);
    });

    await expect(
      mintAgentApiKeyViaCli({ agentRef: "my-agent", companyId: "CO-1" }),
    ).rejects.toThrow(/non-JSON output/i);

    vi.doUnmock("node:child_process");
  });
});
