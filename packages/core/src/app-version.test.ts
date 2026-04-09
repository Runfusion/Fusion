import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAppVersion, parseSemver } from "./app-version.js";

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
    // The test file is at packages/core/src/app-version.test.ts
    // Walk up from this file to find packages/core/package.json
    const testFileDir = dirname(fileURLToPath(import.meta.url));
    const coreDir = join(testFileDir, "..");
    const pkgPath = join(coreDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    expect(version).toBe(pkg.version);
  });

  it("should cache the result", () => {
    // Clear cache by calling multiple times
    const version1 = getAppVersion();
    const version2 = getAppVersion();
    expect(version1).toBe(version2);
    expect(version1).toBe("0.1.0");
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
});
