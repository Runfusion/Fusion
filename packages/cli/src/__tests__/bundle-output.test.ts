import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
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

  it("does not contain bare @kb/* import specifiers", () => {
    const content = readFileSync(bundlePath, "utf-8");
    expect(content).not.toMatch(/from\s+["']@kb\/core["']/);
    expect(content).not.toMatch(/from\s+["']@kb\/dashboard["']/);
    expect(content).not.toMatch(/from\s+["']@kb\/engine["']/);
  });

  it("contains inlined workspace code", () => {
    const content = readFileSync(bundlePath, "utf-8");
    // TaskStore from @kb/core
    expect(content).toContain("TaskStore");
    // createServer from @kb/dashboard
    expect(content).toContain("createServer");
  });

  it("dashboard client assets are included", () => {
    const clientIndex = join(cliRoot, "dist", "client", "index.html");
    expect(existsSync(clientIndex)).toBe(true);
  });

  it("runtime native assets are staged after build:exe", () => {
    // After running build:exe, runtime directory should exist with platform assets
    const runtimeDir = join(cliRoot, "dist", "runtime");
    // The exact platform depends on the host, but we can verify the structure
    if (existsSync(runtimeDir)) {
      // At least one platform directory should exist
      const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
      const hasPlatform = platforms.some(p => existsSync(join(runtimeDir, p, "pty.node")));
      expect(hasPlatform).toBe(true);
    }
  });
});
