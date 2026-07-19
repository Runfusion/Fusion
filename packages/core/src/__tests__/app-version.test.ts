import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAppVersion, parseSemver, compareVersions, isVersionNewer, resolveUpdateTargetVersion } from "../app-version.js";

describe("getAppVersion", () => {
  it("should return a non-empty string", () => {
    const version = getAppVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("should return a valid semver string", () => {
    const version = getAppVersion();
    // Matches basic semver format: X.Y.Z
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("should return the actual package version from package.json", () => {
    const version = getAppVersion();
    // Read the actual version from package.json for verification
    // The test file is at packages/core/src/__tests__/app-version.test.ts
    // Walk up from this file to find packages/core/package.json
    const testFileDir = dirname(fileURLToPath(import.meta.url));
    const coreDir = join(testFileDir, "..", "..");
    const pkgPath = join(coreDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    expect(version).toBe(pkg.version);
  });

  it("should cache the result", () => {
    // Clear cache by calling multiple times
    const version1 = getAppVersion();
    const version2 = getAppVersion();
    expect(version1).toBe(version2);
    // Verify cached version matches the actual package version
    const testFileDir = dirname(fileURLToPath(import.meta.url));
    const coreDir = join(testFileDir, "..", "..");
    const pkgPath = join(coreDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    expect(version1).toBe(pkg.version);
  });
});

describe("parseSemver", () => {
  describe("valid semver versions", () => {
    it("parses simple version", () => {
      const result = parseSemver("1.2.3");
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it("parses zero version", () => {
      const result = parseSemver("0.0.0");
      expect(result).toEqual({ major: 0, minor: 0, patch: 0 });
    });

    it("parses large version numbers", () => {
      const result = parseSemver("10.20.30");
      expect(result).toEqual({ major: 10, minor: 20, patch: 30 });
    });

    it("parses prerelease version", () => {
      const result = parseSemver("1.2.3-beta.1");
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it("parses prerelease with multiple segments", () => {
      const result = parseSemver("1.2.3-alpha.beta.1");
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it("parses version with build metadata", () => {
      const result = parseSemver("1.2.3+build.123");
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it("parses version with prerelease and build metadata", () => {
      const result = parseSemver("1.2.3-beta.1+build.123");
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });
  });

  describe("invalid semver versions", () => {
    it("returns null for empty string", () => {
      expect(parseSemver("")).toBeNull();
    });

    it("returns null for non-semver string", () => {
      expect(parseSemver("not-semver")).toBeNull();
    });

    it("returns null for partial version", () => {
      expect(parseSemver("1")).toBeNull();
      expect(parseSemver("1.2")).toBeNull();
    });

    it("returns null for invalid major version", () => {
      expect(parseSemver("abc.2.3")).toBeNull();
    });

    it("returns null for version with trailing characters", () => {
      expect(parseSemver("1.2.3foo")).toBeNull();
      expect(parseSemver("1.2.3 foo")).toBeNull();
    });

    it("returns null for version with v prefix", () => {
      expect(parseSemver("v1.2.3")).toBeNull();
    });

    it("returns null for version with too many parts", () => {
      expect(parseSemver("1.2.3.4")).toBeNull();
      expect(parseSemver("1.2.3.4.5")).toBeNull();
    });

    it("returns null for invalid prerelease suffix", () => {
      expect(parseSemver("1.2.3-")).toBeNull();
    });

    it("returns null for whitespace", () => {
      expect(parseSemver(" 1.2.3")).toBeNull();
      expect(parseSemver("1.2.3 ")).toBeNull();
      expect(parseSemver("1.2.3\n")).toBeNull();
    });
  });

  /*
  FNXC:UpdateChannels 2026-07-19-13:40:
  Shared version ordering + channel resolution for every update surface.
  Full SemVer 2.0.0 precedence, including prerelease identifiers — the class of
  bug being prevented: comparators that ignore prerelease suffixes treat
  0.73.0-beta.2, -beta.3, and 0.73.0 as equal.
  */
  describe("compareVersions / isVersionNewer", () => {
    it("orders plain releases", () => {
      expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
      expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
      expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    });

    it("ranks a prerelease below its release", () => {
      expect(compareVersions("0.73.0-beta.1", "0.73.0")).toBeLessThan(0);
      expect(isVersionNewer("0.73.0", "0.73.0-beta.9")).toBe(true);
    });

    it("ranks a prerelease above lower releases", () => {
      expect(isVersionNewer("0.73.0-beta.0", "0.72.5")).toBe(true);
    });

    it("orders prerelease iterations numerically", () => {
      expect(isVersionNewer("0.73.0-beta.3", "0.73.0-beta.2")).toBe(true);
      expect(isVersionNewer("0.73.0-beta.10", "0.73.0-beta.2")).toBe(true);
      expect(compareVersions("0.73.0-beta.2", "0.73.0-beta.2")).toBe(0);
    });

    it("orders numeric prerelease identifiers below alphanumeric ones", () => {
      // SemVer spec: 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta
      expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
      expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBeLessThan(0);
      expect(compareVersions("1.0.0-alpha.beta", "1.0.0-beta")).toBeLessThan(0);
    });

    it("ignores build metadata", () => {
      expect(compareVersions("1.2.3+build.1", "1.2.3+build.2")).toBe(0);
    });

    it("sorts unparseable versions below parseable ones", () => {
      expect(isVersionNewer("not-a-version", "0.0.1")).toBe(false);
      expect(isVersionNewer("0.0.1", "not-a-version")).toBe(true);
    });
  });

  describe("resolveUpdateTargetVersion", () => {
    it("stable follows latest only and never sees beta", () => {
      expect(resolveUpdateTargetVersion("stable", { latest: "0.72.0", beta: "0.73.0-beta.5" })).toBe("0.72.0");
      expect(resolveUpdateTargetVersion(undefined, { latest: "0.72.0", beta: "0.73.0-beta.5" })).toBe("0.72.0");
    });

    it("beta resolves the semver-max of latest and beta", () => {
      expect(resolveUpdateTargetVersion("beta", { latest: "0.72.0", beta: "0.73.0-beta.1" })).toBe("0.73.0-beta.1");
      // A promoted stable overtakes its own betas.
      expect(resolveUpdateTargetVersion("beta", { latest: "0.73.0", beta: "0.73.0-beta.4" })).toBe("0.73.0");
    });

    it("handles missing dist-tags", () => {
      expect(resolveUpdateTargetVersion("beta", { latest: "0.72.0" })).toBe("0.72.0");
      expect(resolveUpdateTargetVersion("beta", { beta: "0.73.0-beta.1" })).toBe("0.73.0-beta.1");
      expect(resolveUpdateTargetVersion("stable", { beta: "0.73.0-beta.1" })).toBeNull();
      expect(resolveUpdateTargetVersion("beta", {})).toBeNull();
      expect(resolveUpdateTargetVersion("stable", { latest: "" })).toBeNull();
    });
  });
});
