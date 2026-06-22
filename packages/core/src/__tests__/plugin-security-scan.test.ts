import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setCreateAiSessionFactory } from "../ai-engine-loader.js";
import { scanPluginSecurity } from "../plugin-security-scan.js";

describe("scanPluginSecurity", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    setCreateAiSessionFactory(undefined);
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("includes executable plugin source in the scan payload", async () => {
    const pluginPath = await mkdtemp(join(tmpdir(), "fusion-plugin-scan-"));
    tempDirs.push(pluginPath);
    await writeFile(join(pluginPath, "index.js"), "export default function plugin() { return 'source-marker'; }");

    const prompt = vi.fn().mockResolvedValue(undefined);
    setCreateAiSessionFactory(async () => ({
      session: {
        prompt,
        state: {
          messages: [{ role: "assistant", content: JSON.stringify({ verdict: "clean", summary: "ok", findings: [] }) }],
        },
      },
    }));

    const result = await scanPluginSecurity({ pluginId: "test", pluginPath });

    expect(result.verdict).toBe("clean");
    expect(result.scannedFiles).toContain("index.js");
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("source-marker"));
  });

  it("returns an error and disposes a session whose prompt exceeds the timeout", async () => {
    vi.useFakeTimers();
    const pluginPath = await mkdtemp(join(tmpdir(), "fusion-plugin-scan-timeout-"));
    tempDirs.push(pluginPath);

    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
    const dispose = vi.fn();
    setCreateAiSessionFactory(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(() => {
          markPromptStarted();
          return new Promise<void>(() => undefined);
        }),
        dispose,
        state: { messages: [] },
      },
    }));

    const pending = scanPluginSecurity({ pluginId: "test", pluginPath });
    await promptStarted;
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.verdict).toBe("error");
    expect(result.summary).toContain("timed out");
    expect(dispose).toHaveBeenCalledOnce();
  });
});
