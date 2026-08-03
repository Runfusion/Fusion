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

  it("bundles and loads the Todo plugin through the production core alias", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "fusion-todo-plugin-bundle-"));
    const destDir = join(tempRoot, "fusion-plugin-todos");
    try {
      await bundlePluginEntry({
        pluginId: "fusion-plugin-todos",
        srcDir: join(workspaceRoot, "plugins", "fusion-plugin-todos"),
        destDir,
      });

      const bundledPath = join(destDir, "bundled.js");
      expect(readFileSync(bundledPath, "utf8")).not.toMatch(
        /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']@fusion\//,
      );
      const plugin = await import(pathToFileURL(bundledPath).href);
      expect(plugin.default.manifest.id).toBe("fusion-plugin-todos");
    } finally {
      stopEsbuild();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("absorbs child spawn errors without throwing", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    superviseSpawn("missing-command");

    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
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
