import { describe, expect, it } from "vitest";

import {
  resolveWorktrunkSettings,
  requiresWorktrunkInstallVerification,
  validateWorktrunkSettings,
} from "../config/worktrunk-settings.js";

describe("worktrunk-settings", () => {
  it("returns defaults when settings are empty", () => {
    expect(resolveWorktrunkSettings({}, {})).toEqual({
      enabled: false,
      onFailure: "fail",
    });
  });

  it("lets project enabled override global enabled", () => {
    expect(resolveWorktrunkSettings({ enabled: false }, { enabled: true })).toEqual({
      enabled: true,
      onFailure: "fail",
    });
  });

  it("retains global binaryPath when project only sets enabled", () => {
    expect(
      resolveWorktrunkSettings(
        { enabled: false, binaryPath: "/x", onFailure: "fail" },
        { enabled: true },
      ),
    ).toEqual({
      enabled: true,
      binaryPath: "/x",
      onFailure: "fail",
    });
  });

  it("falls back to defaults when both scopes are undefined", () => {
    expect(resolveWorktrunkSettings(undefined, undefined)).toEqual({
      enabled: false,
      onFailure: "fail",
    });
  });

  it("classifies enable transitions that require install verification", () => {
    expect(requiresWorktrunkInstallVerification({ current: { enabled: false }, next: { enabled: true } })).toBe(true);
    expect(requiresWorktrunkInstallVerification({ current: { enabled: true }, next: { enabled: true } })).toBe(false);
    expect(requiresWorktrunkInstallVerification({ current: { enabled: true }, next: { enabled: false } })).toBe(false);
    expect(requiresWorktrunkInstallVerification({ current: undefined, next: undefined })).toBe(false);
    expect(requiresWorktrunkInstallVerification({ current: undefined, next: { enabled: true } })).toBe(true);
  });

  it("validator rejects invalid values", () => {
    expect(() => validateWorktrunkSettings({ onFailure: "ignore" })).toThrow(
      "worktrunk.onFailure must be one of",
    );
    expect(() => validateWorktrunkSettings({ binaryPath: 123 })).toThrow(
      "worktrunk.binaryPath must be a string when set",
    );
    expect(() => validateWorktrunkSettings("oops")).toThrow("worktrunk settings must be an object");
  });

  it("validator drops unknown keys", () => {
    expect(validateWorktrunkSettings({ enabled: true, unknown: "x" })).toEqual({ enabled: true });
  });
});
