import { describe, expect, it } from "vitest";
import { isSecretScope } from "../secrets/secrets-store.js";

describe("isSecretScope", () => {
  it("accepts project and global", () => {
    expect(isSecretScope("project")).toBe(true);
    expect(isSecretScope("global")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isSecretScope(null)).toBe(false);
    expect(isSecretScope(undefined)).toBe(false);
    expect(isSecretScope(123)).toBe(false);
    expect(isSecretScope("local")).toBe(false);
    expect(isSecretScope("GLOBAL")).toBe(false);
  });
});
