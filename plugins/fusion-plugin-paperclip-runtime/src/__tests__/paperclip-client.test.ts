import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  addComment,
  checkoutIssue,
  createIssue,
  getAgentIdentity,
  getIssue,
  getIssueComments,
  invokeHeartbeat,
  listIssues,
  probePaperclipInstance,
  resolvePaperclipConfig,
  updateIssue,
} from "../pi-module.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paperclip client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  describe("resolvePaperclipConfig", () => {
    it("prefers plugin settings over env vars", () => {
      process.env.PAPERCLIP_API_URL = "http://env-host:3100";
      process.env.PAPERCLIP_API_KEY = "env-key";
      process.env.PAPERCLIP_AGENT_ID = "env-agent";
      process.env.PAPERCLIP_COMPANY_ID = "env-company";

      const config = resolvePaperclipConfig({
        apiUrl: "http://settings-host:4000/",
        apiKey: "settings-key",
        agentId: "settings-agent",
        companyId: "settings-company",
      });

      expect(config).toEqual({
        apiUrl: "http://settings-host:4000",
        apiKey: "settings-key",
        agentId: "settings-agent",
        companyId: "settings-company",
      });
    });

    it("uses env vars when settings are absent", () => {
      process.env.PAPERCLIP_API_URL = "http://env-host:3100/";
      process.env.PAPERCLIP_API_KEY = "env-key";
      process.env.PAPERCLIP_AGENT_ID = "env-agent";
      process.env.PAPERCLIP_COMPANY_ID = "env-company";

      expect(resolvePaperclipConfig()).toEqual({
        apiUrl: "http://env-host:3100",
        apiKey: "env-key",
        agentId: "env-agent",
        companyId: "env-company",
      });
    });

    it("falls back to hardcoded defaults", () => {
      delete process.env.PAPERCLIP_API_URL;
      delete process.env.PAPERCLIP_API_KEY;
      delete process.env.PAPERCLIP_AGENT_ID;
      delete process.env.PAPERCLIP_COMPANY_ID;

      expect(resolvePaperclipConfig()).toEqual({
        apiUrl: "http://localhost:3100",
        apiKey: undefined,
        agentId: undefined,
        companyId: undefined,
      });
    });
  });

  it("probePaperclipInstance returns success on health check", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", deploymentMode: "local_trusted" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(probePaperclipInstance("http://localhost:3100", "secret")).resolves.toEqual({
      ok: true,
      deploymentMode: "local_trusted",
    });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3100/api/health", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer secret",
      },
      body: undefined,
    });
  });

  it("probePaperclipInstance returns error on connection failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await probePaperclipInstance("http://localhost:3100");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("network error");
    }
  });

  it("getAgentIdentity returns agent on 200 and structured auth failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ id: "AG-1", name: "Agent", companyId: "CO-1", role: "executor", status: "active" }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAgentIdentity("http://localhost:3100", "key")).resolves.toEqual({
      ok: true,
      agent: { id: "AG-1", name: "Agent", companyId: "CO-1", role: "executor", status: "active" },
    });

    await expect(getAgentIdentity("http://localhost:3100")).resolves.toEqual({
      ok: false,
      reason: "unauthenticated",
    });

    await expect(getAgentIdentity("http://localhost:3100", "key")).resolves.toEqual({
      ok: false,
      reason: "not_agent",
    });
  });

  it("createIssue posts issue payload and returns created issue", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "ISS-1", status: "backlog" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createIssue("http://localhost:3100", "key", "COMP-1", {
      title: "Title",
      description: "Desc",
      status: "backlog",
      assigneeAgentId: "A-1",
    });

    expect(result).toEqual({ id: "ISS-1", status: "backlog" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/companies/COMP-1/issues",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Title",
          description: "Desc",
          status: "backlog",
          assigneeAgentId: "A-1",
        }),
      }),
    );
  });

  it("getIssue returns issue object", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "ISS-7", status: "in_progress" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getIssue("http://localhost:3100", "key", "ISS-7")).resolves.toEqual({
      id: "ISS-7",
      status: "in_progress",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/issues/ISS-7",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("checkoutIssue posts agent payload and throws ConflictError on 409", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "ISS-1", status: "in_progress" }))
      .mockResolvedValueOnce(jsonResponse({ error: "already checked out" }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkoutIssue("http://localhost:3100", "key", "ISS-1", "AG-1")).resolves.toEqual({
      id: "ISS-1",
      status: "in_progress",
    });

    await expect(checkoutIssue("http://localhost:3100", "key", "ISS-1", "AG-1")).rejects.toThrow(
      ConflictError,
    );
  });

  it("updateIssue sends run id header when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "ISS-1", status: "done" }));
    vi.stubGlobal("fetch", fetchMock);

    await updateIssue("http://localhost:3100", "key", "ISS-1", { status: "done" }, "RUN-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/issues/ISS-1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "X-Paperclip-Run-Id": "RUN-1" }),
      }),
    );
  });

  it("getIssueComments and addComment hit comment endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "C1", body: "result" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "C2" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getIssueComments("http://localhost:3100", "key", "ISS-1")).resolves.toEqual([
      { id: "C1", body: "result" },
    ]);

    await expect(addComment("http://localhost:3100", "key", "ISS-1", "hello", "RUN-2")).resolves.toEqual({
      id: "C2",
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://localhost:3100/api/issues/ISS-1/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "hello" }),
      }),
    );
  });

  it("invokeHeartbeat handles queued and skipped responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "RUN-1", status: "queued", agentId: "AG-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "skipped" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeHeartbeat("http://localhost:3100", "key", "AG-1")).resolves.toEqual({
      ok: true,
      run: { id: "RUN-1", status: "queued", agentId: "AG-1" },
    });

    await expect(invokeHeartbeat("http://localhost:3100", "key", "AG-1")).resolves.toEqual({
      ok: true,
      skipped: true,
    });
  });

  it("listIssues applies query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: "ISS-1" }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listIssues("http://localhost:3100", "key", "COMP-1", {
        status: ["todo", "in_progress"],
        assigneeAgentId: "AG-1",
      }),
    ).resolves.toEqual([{ id: "ISS-1" }]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/companies/COMP-1/issues?status=todo%2Cin_progress&assigneeAgentId=AG-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws on non-200 and invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500)));
    await expect(getIssue("http://localhost:3100", "key", "ISS-1")).rejects.toThrow("Paperclip API 500");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );
    await expect(getIssue("http://localhost:3100", "key", "ISS-1")).rejects.toThrow("invalid JSON");
  });
});
