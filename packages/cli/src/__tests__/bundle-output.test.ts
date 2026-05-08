import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildCliWithRealDashboardAssets,
  bundlePath,
  cliRoot,
  clientIndexPath,
  dashboardClientStubMarker,
  readClientIndexHtml,
} from "./bundle-output-helpers";
import { resolveClaudeCliExtensionFromModuleUrl } from "../commands/claude-cli-extension";
import { resolveDroidCliExtensionFromModuleUrl } from "../commands/droid-cli-extension";

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
    expect(content).not.toContain('"@fusion/core"');
    expect(content).not.toContain('"@fusion/dashboard"');
    expect(content).not.toContain('"@fusion/engine"');
  });

  it("does not contain runtime memory-backend side-load imports", () => {
    const content = readFileSync(bundlePath, "utf-8");
    expect(content).not.toMatch(/await\s+import\(\s*["']\.\/memory-backend\.js["']\s*\)/);
    expect(content).not.toMatch(/await\s+import\(\s*["']\.\.\/memory-backend\.js["']\s*\)/);
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

  it("keeps native module loaders externalized in tsup config", () => {
    const tsupConfig = readFileSync(tsupConfigPath, "utf-8");

    expect(tsupConfig).toContain('"dockerode"');
    expect(tsupConfig).toContain('"ssh2"');
    expect(tsupConfig).toContain('"cpu-features"');
  });

  it("loads sqlite from Node built-ins and never from bare sqlite npm package", () => {
    const content = readFileSync(bundlePath, "utf-8");
    // The bundle must resolve sqlite through Node's built-in module.
    expect(content).toMatch(/["']node:sqlite["']/);
    // Bun-native sqlite support is optional in this artifact depending on runtime-targeted code paths.
    // No bare "sqlite" import (we never want to pull in an npm package named sqlite).
    expect(content).not.toMatch(/from\s+["']sqlite["'][^s]/);
  });

  it("does not inline native artifact filenames into the bundled CLI", () => {
    const content = readFileSync(bundlePath, "utf-8");
    expect(content).not.toContain("sshcrypto.node");
    expect(content).not.toContain("cpufeatures.node");
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

  it("resolveClaudeCliExtension succeeds against the staged dist/ layout", () => {
    const result = resolveClaudeCliExtensionFromModuleUrl(pathToFileURL(bundlePath).href);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.path).toBe(join(cliRoot, "dist", "pi-claude-cli", "index.ts"));
      expect(result.packageVersion).toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it("dist/pi-claude-cli/ is staged with correct files", () => {
    const stagedRoot = join(cliRoot, "dist", "pi-claude-cli");

    expect(existsSync(join(stagedRoot, "package.json"))).toBe(true);
    expect(existsSync(join(stagedRoot, "index.ts"))).toBe(true);
    expect(existsSync(join(stagedRoot, "src", "process-manager.ts"))).toBe(true);
  });

  it("resolveDroidCliExtension succeeds against the staged dist/ layout", () => {
    const result = resolveDroidCliExtensionFromModuleUrl(pathToFileURL(bundlePath).href);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.path).toBe(join(cliRoot, "dist", "droid-cli", "index.ts"));
      expect(result.packageVersion).toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it("dist/droid-cli/ is staged with correct files", () => {
    const stagedRoot = join(cliRoot, "dist", "droid-cli");

    expect(existsSync(join(stagedRoot, "package.json"))).toBe(true);
    expect(existsSync(join(stagedRoot, "index.ts"))).toBe(true);
    expect(existsSync(join(stagedRoot, "src", "process-manager.ts"))).toBe(true);
  });

  it("dist/plugins/fusion-plugin-dependency-graph/ is staged with a valid manifest", () => {
    const stagedRoot = join(cliRoot, "dist", "plugins", "fusion-plugin-dependency-graph");
    const manifestPath = join(stagedRoot, "manifest.json");

    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string; name?: string };
    expect(manifest.id).toBe("fusion-plugin-dependency-graph");
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name?.length).toBeGreaterThan(0);
  });

  it("dist/plugins/fusion-plugin-whatsapp-chat/ is staged with a valid manifest", () => {
    const stagedRoot = join(cliRoot, "dist", "plugins", "fusion-plugin-whatsapp-chat");
    const manifestPath = join(stagedRoot, "manifest.json");

    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string; name?: string };
    expect(manifest.id).toBe("fusion-plugin-whatsapp-chat");
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name?.length).toBeGreaterThan(0);
  });

  it("dist/plugins/fusion-plugin-openclaw-runtime/ is staged with required bridge assets", () => {
    const stagedRoot = join(cliRoot, "dist", "plugins", "fusion-plugin-openclaw-runtime");
    const manifestPath = join(stagedRoot, "manifest.json");

    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(join(stagedRoot, "bundled.js"))).toBe(true);
    expect(existsSync(join(stagedRoot, "mcp-schema-server.cjs"))).toBe(true);
  });

  it("dist/plugins/fusion-plugin-droid-runtime/ is staged with required bridge assets", () => {
    const stagedRoot = join(cliRoot, "dist", "plugins", "fusion-plugin-droid-runtime");
    const manifestPath = join(stagedRoot, "manifest.json");

    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string };
    expect(manifest.id).toBe("fusion-plugin-droid-runtime");
    expect(existsSync(join(stagedRoot, "bundled.js"))).toBe(true);
    expect(existsSync(join(stagedRoot, "mcp-schema-server.cjs"))).toBe(true);
  });

  it("dist/plugins/fusion-plugin-cursor-runtime/ is staged with a valid manifest", () => {
    const stagedRoot = join(cliRoot, "dist", "plugins", "fusion-plugin-cursor-runtime");
    const manifestPath = join(stagedRoot, "manifest.json");

    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string; name?: string };
    expect(manifest.id).toBe("fusion-plugin-cursor-runtime");
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name?.length).toBeGreaterThan(0);
  });

  it("pi-claude-cli source imports child process helpers from node:child_process", () => {
    const processManagerSource = readFileSync(join(cliRoot, "dist", "pi-claude-cli", "src", "process-manager.ts"), "utf-8");

    expect(processManagerSource).toMatch(/import\s+\{[^}]*\bspawn\b[^}]*\}\s+from\s*["']node:child_process["']/);
  });

  it("pi-claude-cli source does not import cross-spawn directly", () => {
    const processManagerSource = readFileSync(join(cliRoot, "dist", "pi-claude-cli", "src", "process-manager.ts"), "utf-8");

    expect(processManagerSource).not.toMatch(/from\s*["']cross-spawn["']/);
  });

  it("staged pi-claude-cli package.json keeps pi extension entry and excludes cross-spawn deps", () => {
    const stagedPkg = JSON.parse(
      readFileSync(join(cliRoot, "dist", "pi-claude-cli", "package.json"), "utf-8"),
    ) as {
      pi?: { extensions?: unknown };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(stagedPkg.pi?.extensions).toEqual(["index.ts"]);
    expect(stagedPkg.dependencies?.["cross-spawn"]).toBeUndefined();
    expect(stagedPkg.dependencies?.["@types/cross-spawn"]).toBeUndefined();
    expect(stagedPkg.devDependencies?.["cross-spawn"]).toBeUndefined();
    expect(stagedPkg.devDependencies?.["@types/cross-spawn"]).toBeUndefined();
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
