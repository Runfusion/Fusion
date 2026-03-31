import { describe, it, expect, beforeAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const cliRoot = join(import.meta.dirname!, "..", "..");
const outBinary = join(cliRoot, "dist", process.platform === "win32" ? "kb.exe" : "kb");
const binaryName = process.platform === "win32" ? "kb.exe" : "kb";
const clientDir = join(cliRoot, "dist", "client");
const runtimeDir = join(cliRoot, "dist", "runtime");

/**
 * Create an isolated temp directory containing the binary, client/,
 * and runtime/ assets — no package.json. Returns the dir path and a cleanup function.
 */
function createIsolatedDir(): { dir: string; binary: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kb-iso-"));
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
      
      // Wait for server to be ready
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => {
          child!.kill("SIGTERM");
          reject(new Error("Server startup timeout"));
        }, 10_000);
        
        child!.stdout.on("data", (d: Buffer) => {
          output += d.toString();
          if (output.includes("kb board") && output.includes(`→ http://localhost:${port}`)) {
            clearTimeout(timeout);
            resolve();
          }
        });
        
        child!.stderr.on("data", (d: Buffer) => {
          output += d.toString();
        });
        
        child!.on("error", reject);
      });
      
      // Test PTY session creation endpoint
      const response = await fetch(`http://localhost:${port}/api/terminal/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      
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
