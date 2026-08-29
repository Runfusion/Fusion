// @vitest-environment node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCliPackageVersion, resolveCliPackageVersionInfo } from "../cli-package-version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function writePackageJson(dir: string, manifest: { name: string; version?: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2), "utf-8");
}

describe("cli-package-version", () => {
  it("resolves the published CLI package from dashboard source directories", () => {
    const versionInfo = resolveCliPackageVersionInfo(join(__dirname, ".."));
    const expectedCliPackageJson = join(__dirname, "..", "..", "..", "cli", "package.json");
    const dashboardPackageJson = join(__dirname, "..", "..", "package.json");

    expect(versionInfo).toEqual({
      packageJsonPath: expectedCliPackageJson,
      version: JSON.parse(readFileSync(expectedCliPackageJson, "utf-8")).version,
    });
    expect(versionInfo?.packageJsonPath).not.toBe(dashboardPackageJson);
  });

  it("resolves the published CLI package from an installed CLI ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-cli-version-installed-"));
    try {
      const cliRoot = join(root, "node_modules", "@runfusion", "fusion");
      const startDir = join(cliRoot, "dist", "dashboard");
      writePackageJson(cliRoot, { name: "@runfusion/fusion", version: "8.7.6" });
      mkdirSync(startDir, { recursive: true });

      expect(resolveCliPackageVersionInfo(startDir)).toEqual({
        packageJsonPath: join(cliRoot, "package.json"),
        version: "8.7.6",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves packaged desktop metadata when no CLI manifest is present", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-cli-version-desktop-"));
    try {
      const dashboardDist = join(root, "node_modules", "@fusion", "dashboard", "dist");
      writePackageJson(root, { name: "@fusion/desktop", version: "5.4.3" });
      writePackageJson(join(root, "node_modules", "@fusion", "dashboard"), { name: "@fusion/dashboard", version: "0.0.0" });
      mkdirSync(dashboardDist, { recursive: true });

      expect(resolveCliPackageVersionInfo(dashboardDist)).toEqual({
        packageJsonPath: join(root, "package.json"),
        version: "5.4.3",
      });
      expect(getCliPackageVersion(pathToFileURL(join(dashboardDist, "server.js")).href)).toBe("5.4.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat missing or malformed metadata as a resolved version", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-cli-version-missing-"));
    try {
      const dashboardDist = join(root, "node_modules", "@fusion", "dashboard", "dist");
      writePackageJson(root, { name: "@fusion/desktop" });
      writePackageJson(join(root, "node_modules", "@fusion", "dashboard"), { name: "@fusion/dashboard", version: "0.0.0" });
      mkdirSync(dashboardDist, { recursive: true });

      expect(resolveCliPackageVersionInfo(dashboardDist)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the published CLI version for dashboard consumers", () => {
    const expectedCliPackageJson = join(__dirname, "..", "..", "..", "cli", "package.json");
    const expectedVersion = JSON.parse(readFileSync(expectedCliPackageJson, "utf-8")).version;

    expect(getCliPackageVersion()).toBe(expectedVersion);
  });
});
