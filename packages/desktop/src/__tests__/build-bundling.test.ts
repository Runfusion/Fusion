import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  requiredEmbeddedPostgresPackages,
  verifyEmbeddedPostgresPayloads,
} from "../../scripts/workspace-tools";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "../..");

async function readDesktopFile(relativePath: string): Promise<string> {
  return readFile(path.join(desktopRoot, relativePath), "utf-8");
}

describe("desktop Electron main bundling", () => {
  it("builds dashboard server artifacts and registry manifest from the desktop release build path", async () => {
    const buildScript = await readDesktopFile("scripts/build.ts");

    expect(buildScript).toContain("buildDashboard()");
    expect(buildScript).toContain("dashboardRegistryManifestSource");
    expect(buildScript).toContain("dashboardRegistryManifestDist");
    expect(buildScript).toContain("await cp(dashboardRegistryManifestSource, dashboardRegistryManifestDist)");
  });

  it("externalizes production main-process packages so updater CJS deps are not bundled into ESM", async () => {
    const buildScript = await readDesktopFile("scripts/build.ts");
    const mainBuildBlock = buildScript.match(/entryPoints: \[join\(packageRoot, "src", "main\.ts"\)\],[\s\S]*?logLevel: "info",/m)?.[0];

    expect(mainBuildBlock).toBeDefined();
    expect(mainBuildBlock).toContain('format: "esm"');
    expect(mainBuildBlock).toContain('platform: "node"');
    expect(mainBuildBlock).toContain('packages: "external"');
    expect(mainBuildBlock).toContain("external: mainExternals");

    const preloadBuildBlock = buildScript.match(/entryPoints: \[join\(packageRoot, "src", "preload\.ts"\)\],[\s\S]*?logLevel: "info",/m)?.[0];
    expect(preloadBuildBlock).toBeDefined();
    expect(preloadBuildBlock).toContain('format: "cjs"');
    expect(preloadBuildBlock).toContain('packages: "external"');
  });

  it("keeps development main-process bundling aligned with the production package-external invariant", async () => {
    const devScript = await readDesktopFile("scripts/dev.ts");
    const mainBuildBlock = devScript.match(/entryPoints: \[join\(packageRoot, "src", "main\.ts"\)\],[\s\S]*?logLevel: "info",/m)?.[0];

    expect(mainBuildBlock).toBeDefined();
    expect(mainBuildBlock).toContain('format: "esm"');
    expect(mainBuildBlock).toContain('packages: "external"');
    expect(mainBuildBlock).toContain('external: ["electron"]');
  });

  it("keeps known updater CommonJS dependencies available as packaged runtime files", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    for (const runtimeDependency of [
      "node_modules/electron-updater/**/*",
      "node_modules/fs-extra/**/*",
      "node_modules/graceful-fs/**/*",
    ]) {
      expect(builderConfig).toContain(`- ${runtimeDependency}`);
    }
  });
});

describe("desktop embedded Postgres payload", () => {
  /**
   * FNXC:DesktopEmbeddedPostgres 2026-07-14-09:31:
   * Desktop packaging must prove the zero-config database payload for every
   * emitted architecture, not merely that Electron can assemble an installer.
   */
  it("maps release hosts to supported native database packages", () => {
    expect(requiredEmbeddedPostgresPackages("darwin")).toEqual([
      "@embedded-postgres/darwin-x64",
      "@embedded-postgres/darwin-arm64",
    ]);
    expect(requiredEmbeddedPostgresPackages("linux")).toEqual([
      "@embedded-postgres/linux-x64",
      "@embedded-postgres/linux-arm64",
    ]);
    expect(requiredEmbeddedPostgresPackages("win32")).toEqual([
      "@embedded-postgres/windows-x64",
    ]);
  });

  it("rejects a staged desktop closure missing a native executable", async () => {
    const deployDir = await mkdtemp(path.join(tmpdir(), "fusion-desktop-pg-payload-"));
    try {
      await mkdir(path.join(deployDir, "node_modules", "embedded-postgres"), { recursive: true });
      await writeFile(
        path.join(deployDir, "node_modules", "embedded-postgres", "package.json"),
        "{}",
      );

      const packageRoot = path.join(
        deployDir,
        "node_modules",
        "@embedded-postgres",
        "windows-x64",
      );
      await mkdir(path.join(packageRoot, "native", "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), "{}");
      await writeFile(path.join(packageRoot, "native", "bin", "initdb.exe"), "");
      await writeFile(path.join(packageRoot, "native", "bin", "pg_ctl.exe"), "");

      await expect(verifyEmbeddedPostgresPayloads(deployDir, "win32")).rejects.toThrow(
        /postgres\.exe/,
      );

      await writeFile(path.join(packageRoot, "native", "bin", "postgres.exe"), "");
      await expect(verifyEmbeddedPostgresPayloads(deployDir, "win32")).resolves.toBeUndefined();
    } finally {
      await rm(deployDir, { recursive: true, force: true });
    }
  });
});
