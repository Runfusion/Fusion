import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveSettings } from "../types.js";

describe("resolveSettings", () => {
  it("returns defaults when input is undefined", () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back commandTimeoutMs when invalid", () => {
    expect(resolveSettings({ commandTimeoutMs: -1 }).commandTimeoutMs).toBe(DEFAULT_SETTINGS.commandTimeoutMs);
  });

  it("filters non-string allowedDomains entries", () => {
    expect(resolveSettings({ allowedDomains: ["ok.example.com", 42, true] }).allowedDomains).toEqual(["ok.example.com"]);
  });
});
