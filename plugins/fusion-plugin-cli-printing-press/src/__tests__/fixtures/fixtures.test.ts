import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makeFakeRegistry } from "./registry.js";
import { installExecMock } from "./exec-mock.js";

describe("test fixtures", () => {
  it("creates seeded fake registry", () => {
    const registry = makeFakeRegistry();
    try {
      expect(registry.store.listServices().map((s) => s.slug).sort()).toEqual(["acme", "beta"]);
      expect(registry.store.listArtifacts(registry.specs.acme.id)).toHaveLength(1);
      expect(registry.store.listArtifacts(registry.specs.beta.id)).toHaveLength(0);
    } finally {
      registry.cleanup();
    }
  });

  it("records mocked exec calls", async () => {
    const execMock = installExecMock();
    execMock.setNextResult({ stdout: "ok" });

    const { exec } = await import("node:child_process");
    const execAsync = promisify(exec);
    const result = await execAsync("node --version", { cwd: "/tmp" });

    expect(result.stdout).toBe("ok");
    expect(execMock.getCalls()).toEqual([{ command: "node --version", options: { cwd: "/tmp" } }]);
    execMock.assertExecSyncUnused();
  });

  it("simulates timeout and blocks execSync", async () => {
    const execMock = installExecMock();
    execMock.setNextResult({ timeoutAfterMs: 25, stderr: "timed out" });
    const { exec, execSync } = await import("node:child_process");
    const execAsync = promisify(exec);

    await expect(execAsync("echo slow", { timeout: 25 })).rejects.toThrow(/timed out/i);
    expect(() => execSync("echo no")).toThrow("execSync should never be called");
  });
});
