// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCliPackageVersion, resolveCliPackageVersionInfo } from "../cli-package-version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  it("returns the published CLI version for dashboard consumers", () => {
    const expectedCliPackageJson = join(__dirname, "..", "..", "..", "cli", "package.json");
    const expectedVersion = JSON.parse(readFileSync(expectedCliPackageJson, "utf-8")).version;

    expect(getCliPackageVersion()).toBe(expectedVersion);
  });
});
