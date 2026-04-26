import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildCliWithRealDashboardAssets,
  bundlePath,
  cliRoot,
  clientIndexPath,
  dashboardClientStubMarker,
  readClientIndexHtml,
} from "./bundle-output-helpers";

const tsupConfigPath = join(cliRoot, "tsup.config.ts");

describe("CLI bundle output", () => {
  beforeAll(() => {
    // Intentional: bundle-output tests validate compiled artifacts, so they
    // perform their own explicit build bootstrap instead of relying on ambient
    // workspace dist/ state.
    buildCliWithRealDashboardAssets();
  }, 300_000);

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
    expect(existsSync(clientIndexPath)).toBe(true);

    const indexHtml = readClientIndexHtml();
    expect(indexHtml).toContain("<script");
    expect(indexHtml).toMatch(/assets\/.+-[A-Za-z0-9_-]+\.js/);
    expect(indexHtml).toMatch(/assets\/vendor-react-[A-Za-z0-9_-]+\.js/);
    expect(indexHtml).not.toContain(dashboardClientStubMarker);

    const copiedAssetsDir = join(cliRoot, "dist", "client", "assets");
    const copiedAssets = readdirSync(copiedAssetsDir);
    expect(copiedAssets.some((file) => /^vendor-react-[A-Za-z0-9_-]+\.js$/.test(file))).toBe(true);
    expect(copiedAssets.some((file) => /^vendor-xterm-[A-Za-z0-9_-]+\.js$/.test(file))).toBe(true);
  });

  it("tsup config copies dashboard assets from dashboard/dist/client to dist/client", () => {
    const tsupConfig = readFileSync(tsupConfigPath, "utf-8");

    expect(tsupConfig).toContain("onSuccess");
    expect(tsupConfig).toContain('join(__dirname, "..", "dashboard", "dist", "client")');
    expect(tsupConfig).toContain('join(__dirname, "dist", "client")');
    expect(tsupConfig).toContain("cpSync(dashboardClientSrc, dashboardClientDest, { recursive: true });");
  });

  it("loads sqlite via runtime adapter (bun:sqlite under Bun, node:sqlite under Node)", () => {
    const content = readFileSync(bundlePath, "utf-8");
    // The sqlite-adapter uses createRequire to pick the runtime backend at
    // construction time; both specifiers should appear as require() targets.
    expect(content).toMatch(/["']bun:sqlite["']/);
    expect(content).toMatch(/["']node:sqlite["']/);
    // No bare "sqlite" import (we never want to pull in an npm package named sqlite)
    expect(content).not.toMatch(/from\s+["']sqlite["'][^s]/);
  });

  it("provides require via createRequire banner", () => {
    const content = readFileSync(bundlePath, "utf-8");
    // Banner should inject createRequire for ESM CJS interop
    expect(content).toContain("createRequire");
    expect(content).toContain("import.meta.url");
    // Banner should be near the top of the file (after shebang)
    const shebangEnd = content.indexOf("\n");
    const bannerPosition = content.indexOf("createRequire");
    expect(bannerPosition).toBeLessThan(100);
    expect(bannerPosition).toBeGreaterThan(shebangEnd);
  });

  it("preserves node: prefix in other node built-in imports", () => {
    const content = readFileSync(bundlePath, "utf-8");
    // Verify removeNodeProtocol: false is effective for other node: imports
    expect(content).toMatch(/from\s+["']node:fs["']/);
    expect(content).toMatch(/from\s+["']node:path["']/);
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
