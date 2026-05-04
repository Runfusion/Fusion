import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetLlamaResolverCache,
  resolveLlamaServerApiKey,
  resolveLlamaServerUrl,
} from "../resolver.js";

const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

describe("resolveLlamaServerUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    resetLlamaResolverCache();
    process.env = { ...originalEnv };
    delete process.env.LLAMA_SERVER_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses project config first", async () => {
    readFileMock.mockResolvedValueOnce('{"url":"http://localhost:8081/"}');
    const url = await resolveLlamaServerUrl("/tmp/project");
    expect(url).toBe("http://localhost:8081");
  });

  it("falls back to env var", async () => {
    readFileMock.mockRejectedValueOnce(new Error("missing"));
    process.env.LLAMA_SERVER_URL = "http://localhost:9999/";
    const url = await resolveLlamaServerUrl("/tmp/project");
    expect(url).toBe("http://localhost:9999");
  });

  it("falls back to default", async () => {
    readFileMock.mockRejectedValue(new Error("missing"));
    const url = await resolveLlamaServerUrl("/tmp/project");
    expect(url).toBe("http://127.0.0.1:8080");
  });
});

describe("resolveLlamaServerApiKey", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns undefined when not configured", async () => {
    readFileMock.mockRejectedValueOnce(new Error("missing"));
    await expect(resolveLlamaServerApiKey()).resolves.toBeUndefined();
  });

  it("returns provider key for llama-server", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        "llama-server": { type: "api_key", key: "secret-token" },
      }),
    );
    await expect(resolveLlamaServerApiKey()).resolves.toBe("secret-token");
  });
});
