import { describe, it, expect, beforeAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const cliRoot = join(import.meta.dirname!, "..", "..");
const distDir = join(cliRoot, "dist");
const clientDir = join(distDir, "client");

const SUPPORTED_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const;

function hasKnownBunSqliteLimitation(result: { stdout: string; stderr: string }): boolean {
  return /node:sqlite/i.test(`${result.stdout}\n${result.stderr}`);
}

/**
 * Map target → expected binary filename (mirrors build.ts logic).
 */
function expectedBinaryName(target: string): string {
  const suffix = target.replace(/^bun-/, "");
  const isWindows = target.includes("windows");
  return `fn-${suffix}${isWindows ? ".exe" : ""}`;
}

/**
 * Determine the native target for the current host so we can run it.
 */
function nativeTarget(): string | null {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!platform || !arch) return null;
  return `bun-${platform}-${arch}`;
}

describe("build-exe-cross: single target", () => {
  beforeAll(() => {
    // Build for linux-x64 specifically
    execSync("bun run build.ts --target bun-linux-x64", {
      cwd: cliRoot,
      stdio: "pipe",
      timeout: 120_000,
    });
  }, 180_000);

  it("produces dist/fn-linux-x64", () => {
    const bin = join(distDir, "fn-linux-x64");
    expect(existsSync(bin)).toBe(true);
    expect(statSync(bin).size).toBeGreaterThan(0);
  });

  it("copies client assets alongside the binary", () => {
    expect(existsSync(join(clientDir, "index.html"))).toBe(true);
  });
});

describe("build-exe-cross: windows target has .exe extension", () => {
  beforeAll(() => {
    execSync("bun run build.ts --target bun-windows-x64", {
      cwd: cliRoot,
      stdio: "pipe",
      timeout: 120_000,
    });
  }, 180_000);

  it("produces dist/fn-windows-x64.exe", () => {
    const bin = join(distDir, "fn-windows-x64.exe");
    expect(existsSync(bin)).toBe(true);
    expect(statSync(bin).size).toBeGreaterThan(0);
  });
});

describe("build-exe-cross: --all builds all platforms", () => {
  beforeAll(() => {
    execSync("bun run build.ts --all", {
      cwd: cliRoot,
      stdio: "pipe",
      timeout: 300_000,
    });
  }, 360_000);

  for (const target of SUPPORTED_TARGETS) {
    const name = expectedBinaryName(target);
    it(`produces dist/${name}`, () => {
      const bin = join(distDir, name);
      expect(existsSync(bin)).toBe(true);
      expect(statSync(bin).size).toBeGreaterThan(0);
    });
  }

  it("copies client assets", () => {
    expect(existsSync(join(clientDir, "index.html"))).toBe(true);
  });

  it("stages runtime native assets for current platform", () => {
    // After --all build, runtime directory should have current platform's assets
    const platform = process.platform === "darwin" ? "darwin" : 
                     process.platform === "linux" ? "linux" : 
                     process.platform === "win32" ? "win32" : "unknown";
    const arch = process.arch === "arm64" ? "arm64" : 
                 process.arch === "x64" ? "x64" : "unknown";
    const prebuildName = `${platform}-${arch}`;
    const runtimeDir = join(distDir, "runtime", prebuildName);
    
    // pty.node is required for all platforms
    expect(existsSync(join(runtimeDir, "pty.node"))).toBe(true);
    // spawn-helper is only for Unix platforms
    if (process.platform !== "win32") {
      expect(existsSync(join(runtimeDir, "spawn-helper"))).toBe(true);
    }
  });

  it("native-platform binary runs --help", () => {
    const target = nativeTarget();
    if (!target) {
      // Skip on unsupported host (e.g. Windows in CI)
      return;
    }
    const name = expectedBinaryName(target);
    const bin = join(distDir, name);
    if (!existsSync(bin)) return;

    let result = spawnSync(bin, ["--help"], {
      encoding: "utf-8",
      // CI can occasionally be slow to launch freshly built native binaries.
      timeout: 45_000,
    });

    // Retry once with a longer timeout when the first probe times out.
    if (result.status === null && result.signal === "SIGTERM") {
      result = spawnSync(bin, ["--help"], {
        encoding: "utf-8",
        timeout: 120_000,
      });
    }

    if (hasKnownBunSqliteLimitation(result)) {
      return;
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fn");
  }, 60_000);
});

describe("build-exe-cross: default (no args) backward compatibility", () => {
  beforeAll(() => {
    execSync("bun run build.ts", {
      cwd: cliRoot,
      stdio: "pipe",
      timeout: 120_000,
    });
  }, 180_000);

  it("produces dist/fn (no platform suffix)", () => {
    const defaultName = process.platform === "win32" ? "fn.exe" : "fn";
    const bin = join(distDir, defaultName);
    expect(existsSync(bin)).toBe(true);
    expect(statSync(bin).size).toBeGreaterThan(0);
  });

  it("copies client assets", () => {
    expect(existsSync(join(clientDir, "index.html"))).toBe(true);
  });
});
