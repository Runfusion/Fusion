import { describe, expect, it } from "vitest";
import { SECRET_ACCESS_POLICIES } from "../types.js";
import {
  SECRET_ACCESS_POLICY_FALLBACK,
  isSecretAccessPolicy,
  resolveSecretAccessPolicy,
} from "../secrets/secret-access-policy.js";

describe("secret-access-policy", () => {
  it("isSecretAccessPolicy accepts supported values and rejects invalid values", () => {
    expect(isSecretAccessPolicy("auto")).toBe(true);
    expect(isSecretAccessPolicy("prompt")).toBe(true);
    expect(isSecretAccessPolicy("deny")).toBe(true);

    expect(isSecretAccessPolicy("")).toBe(false);
    expect(isSecretAccessPolicy("AUTO")).toBe(false);
    expect(isSecretAccessPolicy(null)).toBe(false);
    expect(isSecretAccessPolicy(undefined)).toBe(false);
    expect(isSecretAccessPolicy(123)).toBe(false);
    expect(isSecretAccessPolicy({ policy: "auto" })).toBe(false);
  });

  it("prefers secret row policy over global default", () => {
    expect(resolveSecretAccessPolicy({ secretPolicy: "auto", settings: { secretsAccessPolicy: "deny" } })).toEqual({
      policy: "auto",
      source: "secret",
    });
  });

  it("falls back to global default when secret policy is null", () => {
    expect(resolveSecretAccessPolicy({ secretPolicy: null, settings: { secretsAccessPolicy: "deny" } })).toEqual({
      policy: "deny",
      source: "global-default",
    });
  });

  it("falls back to hard default when secret policy is undefined and settings are empty", () => {
    expect(resolveSecretAccessPolicy({ secretPolicy: undefined, settings: {} })).toEqual({
      policy: "prompt",
      source: "fallback",
    });
  });

  it("falls back when input is empty", () => {
    expect(resolveSecretAccessPolicy({})).toEqual({ policy: "prompt", source: "fallback" });
  });

  it("treats unknown row value as missing and uses global default", () => {
    expect(
      resolveSecretAccessPolicy({ secretPolicy: "allow" as never, settings: { secretsAccessPolicy: "deny" } }),
    ).toEqual({
      policy: "deny",
      source: "global-default",
    });
  });

  it("treats unknown global value as missing and uses fallback", () => {
    expect(resolveSecretAccessPolicy({ secretPolicy: null, settings: { secretsAccessPolicy: "allow" as never } })).toEqual({
      policy: "prompt",
      source: "fallback",
    });
  });

  it("uses prompt as fail-safe fallback", () => {
    expect(SECRET_ACCESS_POLICY_FALLBACK).toBe("prompt");
  });

  it("exports stable policy list for downstream UI", () => {
    expect(SECRET_ACCESS_POLICIES).toHaveLength(3);
    expect(SECRET_ACCESS_POLICIES).toEqual(["auto", "prompt", "deny"]);
  });

  it("is pure and deterministic across repeated calls", () => {
    const input = { secretPolicy: undefined, settings: { secretsAccessPolicy: "deny" as const } };
    const expected = { policy: "deny", source: "global-default" };

    for (let i = 0; i < 100; i += 1) {
      expect(resolveSecretAccessPolicy(input)).toEqual(expected);
    }
  });
});
