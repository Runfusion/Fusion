import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  SANDBOX_BACKEND_NAMES,
  SANDBOX_FAILURE_MODES,
  isSandboxExperimentalEnabled,
  validateSandboxBackendName,
  validateSandboxFailureMode,
  validateSandboxPolicy,
  validateSandboxProjectSettings,
} from "../index.js";

describe("sandbox settings", () => {
  it("defines sandbox defaults and scope keys", () => {
    expect(DEFAULT_PROJECT_SETTINGS.sandbox).toEqual({
      backend: "native",
      policy: { allowNetwork: true, allowedPaths: [] },
      failureMode: "fail-hard",
    });
    expect(PROJECT_SETTINGS_KEYS).toContain("sandbox");
    expect(GLOBAL_SETTINGS_KEYS).not.toContain("sandbox");
  });

  describe("validateSandboxBackendName", () => {
    it.each(SANDBOX_BACKEND_NAMES)("accepts %s", (backend) => {
      expect(validateSandboxBackendName(backend)).toBe(backend);
    });

    it("rejects invalid values", () => {
      expect(validateSandboxBackendName("firejail")).toBeUndefined();
      expect(validateSandboxBackendName(123)).toBeUndefined();
      expect(validateSandboxBackendName(null)).toBeUndefined();
      expect(validateSandboxBackendName(undefined)).toBeUndefined();
      expect(validateSandboxBackendName("")).toBeUndefined();
    });
  });

  describe("validateSandboxFailureMode", () => {
    it.each(SANDBOX_FAILURE_MODES)("accepts %s", (mode) => {
      expect(validateSandboxFailureMode(mode)).toBe(mode);
    });

    it("rejects invalid values", () => {
      expect(validateSandboxFailureMode("fallback")).toBeUndefined();
      expect(validateSandboxFailureMode({})).toBeUndefined();
      expect(validateSandboxFailureMode(null)).toBeUndefined();
      expect(validateSandboxFailureMode(undefined)).toBeUndefined();
      expect(validateSandboxFailureMode("")).toBeUndefined();
    });
  });

  describe("validateSandboxPolicy", () => {
    it("accepts individual valid keys", () => {
      expect(validateSandboxPolicy({ allowNetwork: true })).toEqual({ allowNetwork: true });
      expect(validateSandboxPolicy({ allowedPaths: ["foo", "bar/baz"] })).toEqual({
        allowedPaths: ["foo", "bar/baz"],
      });
    });

    it("rejects invalid policy payloads", () => {
      expect(validateSandboxPolicy({ allowedPaths: [""] })).toBeUndefined();
      expect(validateSandboxPolicy({ allowedPaths: "not-an-array" })).toBeUndefined();
      expect(validateSandboxPolicy(null)).toBeUndefined();
      expect(validateSandboxPolicy([])).toBeUndefined();
      expect(validateSandboxPolicy(42)).toBeUndefined();
    });

    it("drops invalid sub-fields when a valid field remains", () => {
      expect(validateSandboxPolicy({ allowNetwork: true, allowedPaths: ["", "ok"] })).toEqual({
        allowNetwork: true,
      });
      expect(validateSandboxPolicy({ allowNetwork: "yes", allowedPaths: ["ok"] })).toEqual({
        allowedPaths: ["ok"],
      });
    });

    it("rejects traversal and tilde paths", () => {
      expect(validateSandboxPolicy({ allowedPaths: ["../etc"] })).toBeUndefined();
      expect(validateSandboxPolicy({ allowedPaths: ["~/secret"] })).toBeUndefined();
    });
  });

  describe("validateSandboxProjectSettings", () => {
    it("composes valid nested settings", () => {
      expect(
        validateSandboxProjectSettings({
          backend: "docker",
          failureMode: "fallback-native",
          policy: { allowNetwork: false, allowedPaths: ["src/**"] },
        }),
      ).toEqual({
        backend: "docker",
        failureMode: "fallback-native",
        policy: { allowNetwork: false, allowedPaths: ["src/**"] },
      });
    });

    it("returns undefined for empty and invalid inputs", () => {
      expect(validateSandboxProjectSettings({})).toBeUndefined();
      expect(validateSandboxProjectSettings({ backend: "firejail", policy: { allowedPaths: [""] } })).toBeUndefined();
      expect(validateSandboxProjectSettings("nope")).toBeUndefined();
    });
  });

  describe("isSandboxExperimentalEnabled", () => {
    it("returns false for undefined settings", () => {
      expect(isSandboxExperimentalEnabled(undefined)).toBe(false);
    });

    it("returns false when sandbox flag is missing", () => {
      expect(isSandboxExperimentalEnabled({ experimentalFeatures: {} })).toBe(false);
    });

    it("returns false when sandbox flag is false", () => {
      expect(isSandboxExperimentalEnabled({ experimentalFeatures: { sandbox: false } })).toBe(false);
    });

    it("returns true when sandbox flag is true", () => {
      expect(isSandboxExperimentalEnabled({ experimentalFeatures: { sandbox: true } })).toBe(true);
    });
  });
});
