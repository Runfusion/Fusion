import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshProviderModels } from "../api";
import { clearAuthToken } from "../auth";

function mockFetchResponse(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

describe("custom provider API wrappers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAuthToken();
  });

  it("posts to the per-provider model refresh endpoint", async () => {
    const response = {
      provider: {
        id: "provider/id",
        name: "Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "fresh-model", name: "Fresh model" }],
      },
      modelsRefreshed: 1,
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(response));

    await expect(refreshProviderModels("provider/id")).resolves.toEqual(response);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/custom-providers/provider%2Fid/refresh-models",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
