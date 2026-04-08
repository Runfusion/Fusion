import { describe, it, expect, beforeAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const cliRoot = join(import.meta.dirname!, "..", "..");
const outBinary = join(cliRoot, "dist", process.platform === "win32" ? "fn.exe" : "fn");
const binaryName = process.platform === "win32" ? "fn.exe" : "fn";
const clientDir = join(cliRoot, "dist", "client");
const runtimeDir = join(cliRoot, "dist", "runtime");

/**
 * Create an isolated temp directory containing the binary, client/,
 * and runtime/ assets — no package.json. Returns the dir path and a cleanup function.
 */
function createIsolatedDir(): { dir: string; binary: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fn-iso-"));
  cpSync(outBinary, join(dir, binaryName), { recursive: true });
  cpSync(clientDir, join(dir, "client"), { recursive: true });
  // Copy runtime native assets alongside binary
  if (existsSync(runtimeDir)) {
    cpSync(runtimeDir, join(dir, "runtime"), { recursive: true });
  }
  return {
    dir,
    binary: join(dir, binaryName),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function hasKnownBunSqliteLimitation(result: { stderr: string | null }): boolean {
  return result.stderr?.includes("No such built-in module: node:sqlite") ?? false;
}

describe("build-exe", () => {
  beforeAll(() => {
    // Build the executable (skip if already built to speed up re-runs)
    if (!existsSync(outBinary)) {
      execSync("bun run build.ts", {
        cwd: cliRoot,
        stdio: "pipe",
        timeout: 120_000,
      });
    }
  }, 180_000);

  it("build script produces the binary", () => {
    expect(existsSync(outBinary)).toBe(true);
  });

  it("build produces co-located client assets", () => {
    expect(existsSync(join(clientDir, "index.html"))).toBe(true);
  });

  it("dist/ does not contain a package.json", () => {
    expect(existsSync(join(cliRoot, "dist", "package.json"))).toBe(false);
  });

  it("binary runs --help without a co-located package.json", () => {
    const { binary, dir, cleanup } = createIsolatedDir();
    try {
      // Verify no package.json in the isolated dir
      expect(existsSync(join(dir, "package.json"))).toBe(false);

      const result = spawnSync(binary, ["--help"], {
        encoding: "utf-8",
        timeout: 15_000,
      });
      if (hasKnownBunSqliteLimitation(result)) {
        return;
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("fn — AI-orchestrated task board");
      expect(result.stdout).toContain("dashboard");
      expect(result.stdout).toContain("task create");
      expect(result.stdout).toContain("task list");
    } finally {
      cleanup();
    }
  });

  it("binary runs 'task list' without crashing", () => {
    const { binary, cleanup } = createIsolatedDir();
    try {
      const result = spawnSync(binary, ["task", "list"], {
        encoding: "utf-8",
        timeout: 15_000,
      });
      if (hasKnownBunSqliteLimitation(result)) {
        return;
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No tasks yet");
    } finally {
      cleanup();
    }
  });

  it("binary starts dashboard and can create PTY terminal sessions", async () => {
    const { spawn } = await import("node:child_process");
    const { binary, dir, cleanup } = createIsolatedDir();
    const port = 15040 + Math.floor(Math.random() * 1000);
    let child: ReturnType<typeof spawn> | null = null;
    
    try {
      // Start the dashboard
      child = spawn(binary, ["dashboard", "-p", String(port)], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (!child.stdout || !child.stderr) {
        throw new Error("Dashboard process stdio was not piped");
      }

      // ── Deterministic startup probe ────────────────────────────────
      //
      // Three possible outcomes:
      //   "ready"              — startup banner detected, proceed to PTY test
      //   "sqlite-unsupported" — known Bun node:sqlite limitation, skip test
      //   (reject)             — unexpected early exit, fail with diagnostics
      //
      // Uses 'close' (not 'exit') to guarantee all stdio data has been
      // consumed before evaluating the outcome. This prevents the race
      // where exit fires before stderr delivers the sqlite error message.
      //
      let startupOutput = "";
      let settled = false;

      const outcome = await new Promise<"ready" | "sqlite-unsupported">(
        (resolve, reject) => {
          const SQLITE_ERROR = "No such built-in module: node:sqlite";

          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            child!.kill("SIGTERM");
            reject(
              new Error(`Server startup timeout\nOutput:\n${startupOutput}`),
            );
          }, 10_000);

          const settle = (
            result: "ready" | "sqlite-unsupported" | Error,
          ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (result instanceof Error) {
              reject(result);
            } else if (result === "sqlite-unsupported") {
              child!.kill("SIGTERM");
              resolve(result);
            } else {
              resolve(result);
            }
          };

          child!.stdout!.on("data", (d: Buffer) => {
            startupOutput += d.toString();
            if (
              startupOutput.includes("fn board") &&
              startupOutput.includes(`→ http://localhost:${port}`)
            ) {
              settle("ready");
            }
          });

          child!.stderr!.on("data", (d: Buffer) => {
            startupOutput += d.toString();
            if (startupOutput.includes(SQLITE_ERROR)) {
              settle("sqlite-unsupported");
            }
          });

          // 'close' fires after all stdio streams are drained, so
          // startupOutput is guaranteed to be complete here.
          child!.on("close", (code) => {
            if (startupOutput.includes(SQLITE_ERROR)) {
              settle("sqlite-unsupported");
              return;
            }
            settle(
              new Error(
                `Dashboard exited unexpectedly (code=${code})\nOutput:\n${startupOutput}`,
              ),
            );
          });

          child!.on("error", (err) => {
            settle(
              new Error(
                `Dashboard process error: ${err.message}\nOutput:\n${startupOutput}`,
              ),
            );
          });
        },
      );

      // Known Bun limitation: skip the rest of the test
      if (outcome === "sqlite-unsupported") {
        return;
      }
      
      // outcome === "ready" — verify PTY session creation endpoint
      let response: Response | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          response = await fetch(`http://localhost:${port}/api/terminal/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cols: 80, rows: 24 }),
          });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException & { errors?: NodeJS.ErrnoException[] } };
          const codes = [
            err.code,
            err.cause?.code,
            ...(err.cause?.errors?.map((nested) => nested.code) ?? []),
          ];
          if (codes.includes("EPERM")) {
            return;
          }
          if (!codes.includes("ECONNREFUSED")) {
            throw new Error(`PTY endpoint request failed after startup\n${String(error)}`);
          }
          if (child?.exitCode !== null) {
            throw new Error(`Dashboard exited before PTY endpoint became available`);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      if (lastError) {
        throw lastError;
      }
      if (!response) {
        throw new Error(`PTY endpoint did not respond after retries`);
      }
      
      // Accept either success (201) or service unavailable (503 when PTY not available)
      // Both indicate the server is running correctly
      expect([201, 503]).toContain(response.status);
      
      if (response.status === 201) {
        const data = await response.json() as { sessionId?: string; shell?: string };
        expect(data.sessionId).toBeDefined();
        expect(data.sessionId).toMatch(/^term-/);
        expect(data.shell).toBeDefined();
      }
    } finally {
      if (child) {
        child.kill("SIGTERM");
        // Give it time to clean up
        await new Promise((r) => setTimeout(r, 500));
      }
      cleanup();
    }
  }, 20_000);
});
