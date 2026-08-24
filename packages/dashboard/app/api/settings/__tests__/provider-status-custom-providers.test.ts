/**
 * FNXC:CustomProviderThinkingFormat 2026-08-21-10:05:
 * RUFU-143: the app API mirror (provider-status) must carry the per-model thinking
 * flags (thinkingFormat + reasoning) through fetch/POST/PUT so the dashboard form
 * path persists them instead of silently dropping them, mirroring the RUFU-123
 * window carry-through. Absent flags are omitted from the wire bodies so default
 * registrations round-trip unchanged. These proofs moved into the declared
 * file-scope location (they previously lived in app/__tests__/api-custom-providers.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCustomProvider, fetchCustomProviders, updateCustomProvider } from "../provider-status.js";
import { clearAuthToken } from "../../../auth";

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

describe("custom provider API mirror — per-model thinking flags (RUFU-143)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAuthToken();
  });

  it("fetchCustomProviders carries per-model thinking flags into the legacy config (RUFU-143)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse([
      {
        id: "cp-1",
        name: "Qwen LiteLLM",
        apiType: "openai-compatible",
        baseUrl: "https://litellm.example.com/v1",
        models: [
          { id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false },
          { id: "plain", name: "Plain" },
        ],
      },
    ]));

    const result = await fetchCustomProviders();
    const [first] = result;
    expect(first?.models).toEqual([
      { id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false },
      { id: "plain", name: "Plain" },
    ]);
    // The providers field mirrors the legacy config.
    expect(result.providers[0]?.models).toEqual(first?.models);
  });

  it("addCustomProvider posts per-model thinking flags (RUFU-143)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse({
      id: "cp-1",
      name: "Qwen LiteLLM",
      apiType: "openai-compatible",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false }],
    }));

    await addCustomProvider({
      name: "Qwen LiteLLM",
      apiType: "openai-compatible",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false }],
    });

    const body = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body.models).toEqual([{ id: "qwen3", name: "Qwen3", thinkingFormat: "qwen-chat-template", reasoning: false }]);
  });

  it("updateCustomProvider carries per-model thinking flags through the PUT body (RUFU-143)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse({
      id: "cp-1",
      name: "Qwen LiteLLM",
      apiType: "openai-compatible",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "qwen3", name: "Qwen3", thinkingFormat: "deepseek", reasoning: true }],
    }));

    await updateCustomProvider("cp-1", {
      name: "Qwen LiteLLM",
      baseUrl: "https://litellm.example.com/v1",
      api: "openai-completions",
      models: [{ id: "qwen3", name: "Qwen3", thinkingFormat: "deepseek", reasoning: true }],
    });

    const body = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body.models).toEqual([{ id: "qwen3", name: "Qwen3", thinkingFormat: "deepseek", reasoning: true }]);
  });

  it("omits absent thinking flags from the wire body (RUFU-143 backward compat)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse({
      id: "cp-1",
      name: "Plain",
      apiType: "openai-compatible",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "plain", name: "Plain" }],
    }));

    await addCustomProvider({
      name: "Plain",
      apiType: "openai-compatible",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "plain", name: "Plain" }],
    });

    const body = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body.models).toEqual([{ id: "plain", name: "Plain" }]);
    expect(body.models[0]).not.toHaveProperty("thinkingFormat");
    expect(body.models[0]).not.toHaveProperty("reasoning");
  });
});

/*
FNXC:CustomProviderHttpTimeout 2026-08-25-01:15:
Per-model HTTP timeout (timeoutSeconds; 0 = disabled) must round-trip through the app API
mirror exactly like the RUFU-123/143 fields. Without the carry-through the display path
(fetchCustomProviders) strips it, the row editor renders an empty timeout field, and the next
save silently deletes the stored value — the operator's "timeout is not saving" symptom. The
0 sentinel is a valid stored value and must be carried too (unlike the positive-only windows).
*/
describe("custom provider API mirror — per-model HTTP timeout (timeoutSeconds)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAuthToken();
  });

  it("fetchCustomProviders carries per-model timeoutSeconds into the legacy config (including the 0 sentinel)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse([
      {
        id: "cp-1",
        name: "qwen-host",
        apiType: "openai-compatible",
        baseUrl: "http://192.168.12.40:8000/v1",
        models: [
          { id: "qwen", name: "qwen", contextWindow: 262144, timeoutSeconds: 3600 },
          { id: "unset", name: "unset", timeoutSeconds: 0 },
          { id: "plain", name: "plain" },
        ],
      },
    ]));

    const result = await fetchCustomProviders();
    expect(result[0]?.models).toEqual([
      { id: "qwen", name: "qwen", contextWindow: 262144, timeoutSeconds: 3600 },
      { id: "unset", name: "unset", timeoutSeconds: 0 },
      { id: "plain", name: "plain" },
    ]);
  });

  it("addCustomProvider posts per-model timeoutSeconds", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse({
      id: "cp-1",
      name: "qwen-host",
      apiType: "openai-compatible",
      baseUrl: "http://192.168.12.40:8000/v1",
      models: [{ id: "qwen", name: "qwen", timeoutSeconds: 3600 }],
    }));

    await addCustomProvider({
      name: "qwen-host",
      apiType: "openai-compatible",
      baseUrl: "http://192.168.12.40:8000/v1",
      models: [{ id: "qwen", name: "qwen", timeoutSeconds: 3600 }],
    });

    const body = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body.models).toEqual([{ id: "qwen", name: "qwen", timeoutSeconds: 3600 }]);
  });

  it("updateCustomProvider carries per-model timeoutSeconds through the PUT body", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse({
      id: "cp-1",
      name: "qwen-host",
      apiType: "openai-compatible",
      baseUrl: "http://192.168.12.40:8000/v1",
      models: [{ id: "qwen", name: "qwen", timeoutSeconds: 3600 }],
    }));

    await updateCustomProvider("cp-1", {
      name: "qwen-host",
      baseUrl: "http://192.168.12.40:8000/v1",
      api: "openai-completions",
      models: [{ id: "qwen", name: "qwen", timeoutSeconds: 3600 }],
    });

    const body = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(body.models).toEqual([{ id: "qwen", name: "qwen", timeoutSeconds: 3600 }]);
  });
});
