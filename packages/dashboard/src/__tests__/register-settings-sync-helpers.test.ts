import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock getAuthFileCandidates to control which paths are checked
const mockAuthCandidates: string[] = [];
vi.mock("../auth-paths.js", () => ({
  getAuthFileCandidates: () => mockAuthCandidates,
}));

// Re-import after mock
const { readStoredAuthProvidersFromDisk } = await import(
  "../routes/register-settings-sync-helpers.js"
);

describe("readStoredAuthProvidersFromDisk", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `fn-sync-helpers-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    mockAuthCandidates.length = 0;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty object when no auth files exist", async () => {
    mockAuthCandidates.push(join(tempDir, "nonexistent.json"));
    const result = await readStoredAuthProvidersFromDisk();
    expect(result).toEqual({});
  });

  it("reads providers from a single auth file", async () => {
    const authPath = join(tempDir, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        openrouter: { type: "api_key", key: "sk-or-123" },
      }),
    );
    mockAuthCandidates.push(authPath);

    const result = await readStoredAuthProvidersFromDisk();
    expect(result).toEqual({
      openrouter: { type: "api_key", key: "sk-or-123" },
    });
  });

  it("merges providers across multiple auth files", async () => {
    const fusionAuth = join(tempDir, "fusion-auth.json");
    const piAuth = join(tempDir, "pi-auth.json");

    await writeFile(
      fusionAuth,
      JSON.stringify({
        openrouter: { type: "api_key", key: "sk-or-fusion" },
        github: { type: "oauth", access: "gh-fusion-token" },
      }),
    );
    await writeFile(
      piAuth,
      JSON.stringify({
        minimax: { type: "api_key", key: "mm-pi-key" },
        github: { type: "oauth", access: "gh-pi-token" },
      }),
    );

    mockAuthCandidates.push(fusionAuth, piAuth);
    const result = await readStoredAuthProvidersFromDisk();

    expect(result).toEqual({
      openrouter: { type: "api_key", key: "sk-or-fusion" },
      github: { type: "oauth", access: "gh-fusion-token" },
      minimax: { type: "api_key", key: "mm-pi-key" },
    });
  });

  it("gives priority to first-found file for duplicate providers", async () => {
    const firstAuth = join(tempDir, "first.json");
    const secondAuth = join(tempDir, "second.json");

    await writeFile(
      firstAuth,
      JSON.stringify({ openrouter: { type: "api_key", key: "first-key" } }),
    );
    await writeFile(
      secondAuth,
      JSON.stringify({ openrouter: { type: "api_key", key: "second-key" } }),
    );

    mockAuthCandidates.push(firstAuth, secondAuth);
    const result = await readStoredAuthProvidersFromDisk();

    expect(result.openrouter).toEqual({ type: "api_key", key: "first-key" });
  });

  it("skips invalid JSON files and continues to next candidate", async () => {
    const badAuth = join(tempDir, "bad.json");
    const goodAuth = join(tempDir, "good.json");

    await writeFile(badAuth, "not valid json{{{");
    await writeFile(
      goodAuth,
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-good" } }),
    );

    mockAuthCandidates.push(badAuth, goodAuth);
    const result = await readStoredAuthProvidersFromDisk();

    expect(result).toEqual({
      openrouter: { type: "api_key", key: "sk-good" },
    });
  });

  it("picks up github-copilot from fallback when not in primary", async () => {
    const fusionAuth = join(tempDir, "fusion-auth.json");
    const piAuth = join(tempDir, "pi-auth.json");

    await writeFile(
      fusionAuth,
      JSON.stringify({
        openrouter: { type: "api_key", key: "sk-or-fusion" },
      }),
    );
    await writeFile(
      piAuth,
      JSON.stringify({
        "github-copilot": { type: "oauth", access: "copilot-token", refresh: "ghu_refresh", expires: 9999999999999 },
      }),
    );

    mockAuthCandidates.push(fusionAuth, piAuth);
    const result = await readStoredAuthProvidersFromDisk();

    expect(result).toEqual({
      openrouter: { type: "api_key", key: "sk-or-fusion" },
      "github-copilot": { type: "oauth", access: "copilot-token", refresh: "ghu_refresh", expires: 9999999999999 },
    });
  });
});
