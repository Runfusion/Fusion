import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshBuiltInModels } from "../api";
import { API_JSON_HEADERS } from "../test/apiRequestHeaders";

function mockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("refreshBuiltInModels", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to the explicit built-in catalog refresh endpoint and returns its typed outcome", async () => {
    const response = { outcome: "completed" as const };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(response));

    await expect(refreshBuiltInModels()).resolves.toEqual(response);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/models/refresh", {
      headers: API_JSON_HEADERS,
      method: "POST",
    });
  });
});
