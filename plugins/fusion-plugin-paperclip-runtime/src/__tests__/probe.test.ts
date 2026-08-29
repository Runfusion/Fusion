import { afterEach, describe, expect, it, vi } from "vitest";
import { probePaperclipConnection } from "../paperclip-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("probePaperclipConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connect refused → available: false, reason mentions unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("ECONNREFUSED")));

    const result = await probePaperclipConnection({
      apiUrl: "http://localhost:3100",
    });

    expect(result.available).toBe(false);
    expect(result.reason).toContain("not reachable");
    expect(result.apiUrl).toBe("http://localhost:3100");
    expect(result.probeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("401 → available: false, reason: API key rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401)));

    const result = await probePaperclipConnection({
      apiUrl: "http://paperclip.example",
      apiKey: "bad-key",
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("API key rejected");
    expect(result.identity).toBeUndefined();
  });

  it("200 → available: true with identity filled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: "AG-1",
          name: "Coder",
          role: "engineer",
          companyId: "CO-1",
          companyName: "Acme Corp",
        }),
      ),
    );

    const result = await probePaperclipConnection({
      apiUrl: "http://paperclip.example",
      apiKey: "valid-key",
    });

    expect(result.available).toBe(true);
    expect(result.identity).toEqual({
      agentId: "AG-1",
      agentName: "Coder",
      role: "engineer",
      companyId: "CO-1",
      companyName: "Acme Corp",
    });
    expect(result.probeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("uses correct endpoint URL including api prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: "A", companyId: "C" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await probePaperclipConnection({ apiUrl: "http://localhost:3100/", apiKey: "k" });

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3100/api/agents/me");
  });

  it("passes apiKey as Authorization Bearer header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: "A", companyId: "C" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await probePaperclipConnection({ apiUrl: "http://localhost:3100", apiKey: "my-secret" });

    const call = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = call.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-secret");
  });

  it("no apiKey → no Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: "A", companyId: "C" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await probePaperclipConnection({ apiUrl: "http://localhost:3100" });

    const call = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = call.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
