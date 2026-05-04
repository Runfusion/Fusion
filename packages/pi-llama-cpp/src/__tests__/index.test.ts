import { describe, expect, it, vi } from "vitest";
import extension from "../../index.js";

vi.mock("../retriever.js", () => ({
  isLlamaServerReady: vi.fn(),
  listLlamaModels: vi.fn(),
}));
vi.mock("../resolver.js", () => ({
  resolveLlamaServerUrl: vi.fn(),
  resolveLlamaServerApiKey: vi.fn(),
}));

import { isLlamaServerReady, listLlamaModels } from "../retriever.js";
import { resolveLlamaServerApiKey, resolveLlamaServerUrl } from "../resolver.js";

describe("pi-llama-cpp extension", () => {
  it("does not register provider when server is offline", async () => {
    vi.mocked(isLlamaServerReady).mockResolvedValue(false);
    const registerProvider = vi.fn();

    await extension({ registerProvider } as never);
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("registers llama-server provider when server is reachable", async () => {
    vi.mocked(isLlamaServerReady).mockResolvedValue(true);
    vi.mocked(resolveLlamaServerUrl).mockResolvedValue("http://127.0.0.1:8080");
    vi.mocked(resolveLlamaServerApiKey).mockResolvedValue("abc");
    vi.mocked(listLlamaModels).mockResolvedValue([{ id: "qwen" }]);
    const registerProvider = vi.fn();

    await extension({ registerProvider } as never);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(
      "llama-server",
      expect.objectContaining({
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "abc",
      }),
    );
  });
});
