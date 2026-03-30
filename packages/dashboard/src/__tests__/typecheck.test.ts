import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { rename, access } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Clean-checkout typecheck regression test.
 *
 * This test verifies that `pnpm typecheck` succeeds from a clean checkout
 * state without relying on pre-built dist/ artifacts. It temporarily moves
 * any existing dist directories to ensure the typecheck runs against
 * source files and project references.
 */
describe("clean-checkout typecheck", () => {
  const cwd = resolve(__dirname, "../..");
  const distPaths = [
    "packages/core/dist",
    "packages/engine/dist",
    "packages/dashboard/dist",
    "packages/cli/dist",
  ];
  const movedSuffix = ".moved-for-test";
  const movedPaths = distPaths.map((p) => `${p}${movedSuffix}`);

  // Helper to check if a path exists
  async function pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    // Move any existing dist directories to simulate clean checkout
    for (let i = 0; i < distPaths.length; i++) {
      const distPath = resolve(cwd, distPaths[i]);
      const movedPath = resolve(cwd, movedPaths[i]);

      if (await pathExists(distPath)) {
        await rename(distPath, movedPath);
      }
    }
  });

  afterAll(async () => {
    // Restore moved directories even if test failed
    for (let i = 0; i < distPaths.length; i++) {
      const distPath = resolve(cwd, distPaths[i]);
      const movedPath = resolve(cwd, movedPaths[i]);

      if (await pathExists(movedPath)) {
        try {
          await rename(movedPath, distPath);
        } catch {
          // Best effort - if restore fails, we'll rebuild in subsequent steps
        }
      }
    }
  });

  it("passes pnpm typecheck without relying on dist/ artifacts", () => {
    let error: Error | null = null;
    let stdout = "";
    let stderr = "";

    try {
      stdout = execSync("pnpm typecheck", {
        cwd,
        encoding: "utf-8",
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      error = e as Error;
      // Capture stdout/stderr from the error object if available
      const execError = e as { stdout?: string; stderr?: string };
      stdout = execError.stdout ?? "";
      stderr = execError.stderr ?? "";
    }

    // Assertion-based verification - fail on non-zero exit
    if (error) {
      const failureContext = [
        "pnpm typecheck failed with non-zero exit code",
        "",
        "--- STDOUT ---",
        stdout,
        "",
        "--- STDERR ---",
        stderr,
        "",
        "--- ERROR ---",
        error.message,
      ].join("\n");

      expect.fail(failureContext);
    }

    // Verify that typecheck ran and succeeded - just check no error was thrown
    // The fact that we got here without error means it passed
    expect(error).toBeNull();
  });
});
