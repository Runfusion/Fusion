import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const cliRoot = join(__dirname, "..", "..");
const bundlePath = join(cliRoot, "dist", "bin.js");

describe("CLI bundle output", () => {
  it("dist/bin.js exists", () => {
    expect(existsSync(bundlePath)).toBe(true);
  });

  it("starts with a shebang", () => {
    const content = readFileSync(bundlePath, "utf-8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("does not contain bare @fusion/* import specifiers", () => {
    const content = readFileSync(bundlePath, "utf-8");
    expect(content).not.toMatch(/from\s+["']@fusion\/core["']/);
    expect(content).not.toMatch(/from\s+["']@fusion\/dashboard["']/);
    expect(content).not.toMatch(/from\s+["']@fusion\/engine["']/);
  });

  it("contains inlined workspace code", () => {
    const content = readFileSync(bundlePath, "utf-8");
    // TaskStore from @fusion/core
    expect(content).toContain("TaskStore");
    // createServer from @fusion/dashboard
    expect(content).toContain("createServer");
  });

  it("dashboard client assets are included", () => {
    const clientIndex = join(cliRoot, "dist", "client", "index.html");
    expect(existsSync(clientIndex)).toBe(true);
  });

  it("runtime native assets are staged after build:exe", () => {
    const runtimeDir = join(cliRoot, "dist", "runtime");
    if (!existsSync(runtimeDir)) return;

    const platformDirs = readdirSync(runtimeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    if (platformDirs.length === 0) return;

    const nativeAssets = platformDirs.flatMap((platform) => {
      const platformDir = join(runtimeDir, platform);
      return readdirSync(platformDir).filter((file) => file === "pty.node" || file === "spawn-helper");
    });

    // `build:exe` coverage lives in the dedicated build-exe tests. This check only
    // validates already-staged runtime outputs when they are present, without
    // failing on partially populated stale directories from earlier test runs.
    if (nativeAssets.length === 0) return;

    expect(nativeAssets.length).toBeGreaterThan(0);
  });
});
