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

/**
 * Create an isolated temp directory containing only the binary and client/
 * assets — no package.json. Returns the dir path and a cleanup function.
 */
function createIsolatedDir(): { dir: string; binary: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kb-iso-"));
  cpSync(outBinary, join(dir, binaryName), { recursive: true });
  cpSync(clientDir, join(dir, "client"), { recursive: true });
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
      expect(result.stdout).toContain("kb — AI-orchestrated task board");
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

  it("binary starts dashboard and serves client assets", async () => {
    const { spawn } = await import("node:child_process");
    const { binary, dir, cleanup } = createIsolatedDir();
    const port = 14040 + Math.floor(Math.random() * 1000);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(binary, ["dashboard", "-p", String(port)], {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
        // Wait for the startup banner, then kill
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          resolve(out);
        }, 3_000);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve(out);
        });
      });
      expect(output).toContain("kb board");
    } finally {
      cleanup();
    }
  }, 15_000);
});
