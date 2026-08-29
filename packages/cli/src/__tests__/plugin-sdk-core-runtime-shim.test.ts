import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stop as stopEsbuild } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

import { AgentStore, superviseSpawn } from "../plugin-sdk-core-runtime-shim.mjs";
import { bundlePluginEntry } from "../../tsup.config";

const workspaceRoot = join(__dirname, "..", "..", "..", "..");

class FakeChild extends EventEmitter {
  pid = 1234;
  kill = vi.fn();
}

describe("plugin SDK core runtime shim supervision", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exposes AgentStore to bundled plugins without a private core dependency", () => {
    expect(AgentStore).toBeTypeOf("function");
  });

  async function expectBundledPluginLoads(pluginId: string) {
    const tempRoot = mkdtempSync(join(tmpdir(), `fusion-${pluginId}-bundle-`));
    const destDir = join(tempRoot, pluginId);
    try {
      await bundlePluginEntry({
        pluginId,
        srcDir: join(workspaceRoot, "plugins", pluginId),
        destDir,
      });

      const bundledPath = join(destDir, "bundled.js");
      expect(readFileSync(bundledPath, "utf8")).not.toMatch(
        /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']@fusion\//,
      );
      const plugin = await import(pathToFileURL(bundledPath).href);
      expect(plugin.default.manifest.id).toBe(pluginId);
    } finally {
      stopEsbuild();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  it("bundles and loads the Todo plugin through the production core alias", async () => {
    await expectBundledPluginLoads("fusion-plugin-todos");
  });

  it("bundles and loads the Cursor runtime through the production core alias", async () => {
    await expectBundledPluginLoads("fusion-plugin-cursor-runtime");
  });

  it("absorbs child spawn errors without throwing", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    superviseSpawn("missing-command");

    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
  });

  it("keeps Cursor's non-finite lifetime supervised until explicit cancellation", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const supervised = superviseSpawn("cursor-agent", ["--print"], {
      shell: false,
      maxLifetimeMs: Number.POSITIVE_INFINITY,
    });
    expect(mocks.spawn).toHaveBeenCalledWith("cursor-agent", ["--print"], expect.objectContaining({ shell: false }));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(supervised.pid).toBe(child.pid);
    expect(supervised.child).toBe(child);

    child.emit("close", 0, "SIGTERM");
    await expect(supervised.waitExit()).resolves.toEqual({ code: 0, signal: "SIGTERM" });
    supervised.kill();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("unrefs escalation timers and never SIGKILLs a closed child", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const timerCallbacks: Array<() => void> = [];
    const timerUnrefs: Array<ReturnType<typeof vi.fn>> = [];

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      timerCallbacks.push(callback);
      const timer = { unref: vi.fn() };
      timerUnrefs.push(timer.unref);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const supervised = superviseSpawn("command", [], { maxLifetimeMs: 10 });
    supervised.kill();
    timerCallbacks[0]!();
    child.emit("close", 0, null);
    timerCallbacks[1]!();
    timerCallbacks[2]!();

    expect(timerUnrefs).toHaveLength(3);
    expect(timerUnrefs.every((unref) => unref.mock.calls.length === 1)).toBe(true);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });
});
