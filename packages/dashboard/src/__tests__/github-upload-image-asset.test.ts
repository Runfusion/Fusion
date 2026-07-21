import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return { ...actual, isGhAvailable: vi.fn(() => true), isGhAuthenticated: vi.fn(() => true), runGhJsonAsync: vi.fn(), runGhAsync: vi.fn(), runGh: vi.fn(), getGhErrorMessage: vi.fn((error) => String(error)) };
});

import { runGhJsonAsync } from "@fusion/core";
import { GitHubClient } from "../github.js";

const image = Buffer.alloc(1024 * 1024, 0xab).toString("base64");
const params = { owner: "owner", repo: "repo", path: ".fusion-reports/safe/image.png", contentBase64: image, message: "Store report screenshot", mimeType: "image/png" };
const response = { content: { html_url: "https://github.com/owner/repo/blob/main/.fusion-reports/safe/image.png", download_url: "https://raw.githubusercontent.com/owner/repo/main/.fusion-reports/safe/image.png", path: params.path, sha: "abc" } };

describe("GitHubClient.uploadImageAsset", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends large contents payload through gh stdin, never argv", async () => {
    vi.mocked(runGhJsonAsync).mockResolvedValue(response as never);
    const uploaded = await new GitHubClient({ forceMode: "gh-cli" }).uploadImageAsset(params);
    const [argv, options] = vi.mocked(runGhJsonAsync).mock.calls[0]!;
    expect(argv).toEqual(["api", "--method", "PUT", "repos/owner/repo/contents/.fusion-reports/safe/image.png", "--input", "-"]);
    expect(JSON.stringify(argv)).not.toContain(image);
    expect(JSON.parse((options as { input: string }).input).content).toBe(image);
    expect(uploaded.rawUrl).toBe(response.content.download_url);
  });

  it("uses encoded Contents API endpoint in token mode", async () => {
    const fetch = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 201, json: async () => response, headers: new Headers() } as Response);
    await new GitHubClient({ token: "token", forceMode: "token" }).uploadImageAsset({ ...params, path: ".fusion-reports/a space/image.png" });
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/contents/.fusion-reports/a%20space/image.png", expect.objectContaining({ method: "PUT" }));
  });

  it.each([{ mimeType: "image/svg+xml" }, { contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }])("rejects invalid upload before transport", async (patch) => {
    const client = new GitHubClient({ forceMode: "gh-cli" });
    await expect(client.uploadImageAsset({ ...params, ...patch })).rejects.toThrow();
    expect(runGhJsonAsync).not.toHaveBeenCalled();
  });
});
