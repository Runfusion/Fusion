import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_INSTANCE_ID,
  PROVIDER_INSTANCE_ID_MAX_LENGTH,
  formatProviderInstanceKey,
  isReservedAuthStorageKey,
  parseProviderInstanceKey,
} from "./provider-instance.js";

describe("provider instance keys", () => {
  it("round trips bare defaults and named instances", () => {
    expect(parseProviderInstanceKey(formatProviderInstanceKey({ providerId: "anthropic", instanceId: DEFAULT_PROVIDER_INSTANCE_ID }))).toEqual({ providerId: "anthropic", instanceId: DEFAULT_PROVIDER_INSTANCE_ID });
    expect(parseProviderInstanceKey(formatProviderInstanceKey({ providerId: "anthropic", instanceId: "work" }))).toEqual({ providerId: "anthropic", instanceId: "work" });
  });

  it("rejects non-invertible provider and instance names", () => {
    for (const value of ["", " ", "a b", "a[b", "a]b", "a".repeat(PROVIDER_INSTANCE_ID_MAX_LENGTH + 1)]) {
      expect(() => formatProviderInstanceKey({ providerId: value, instanceId: "work" })).toThrow();
      expect(() => formatProviderInstanceKey({ providerId: "provider", instanceId: value })).toThrow();
    }
    for (const key of ["p[", "p]", "p[]", "p[a[b]", "p[default]", ""]) expect(parseProviderInstanceKey(key)).toBeUndefined();
    expect(isReservedAuthStorageKey("__fusionDefaultInstances")).toBe(true);
  });
});
