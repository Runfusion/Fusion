import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, deleteAiSession } from "../legacy";

describe("deleteAiSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves on 200 responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(deleteAiSession("session-1")).resolves.toBeUndefined();
  });

  it("treats 404 responses as idempotent success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(deleteAiSession("missing-session")).resolves.toBeUndefined();
  });

  it("rejects on non-404 server failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Delete failed", details: { retryable: false } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(deleteAiSession("session-1")).rejects.toEqual(
      expect.objectContaining<ApiRequestError>({
        name: "ApiRequestError",
        message: "Delete failed",
        status: 500,
        details: { retryable: false },
      }),
    );
  });

  it("rejects on network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(deleteAiSession("session-1")).rejects.toThrow("Failed to fetch");
  });

  it("maps gateway 503 text/plain to the operator-facing unavailable message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("no available server", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );

    await expect(deleteAiSession("session-1")).rejects.toMatchObject({
      name: "ApiRequestError",
      message: "The server is temporarily unavailable. Please try again.",
      status: 503,
    });
  });
});
