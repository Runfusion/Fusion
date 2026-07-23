import { describe, expect, it } from "vitest";
import {
  SECRET_AUDIT_PLAINTEXT_FORBIDDEN_KEYS,
  SECRET_MUTATION_TYPES,
  assertNoSecretPlaintext,
  type FilesystemMutationType,
} from "../util/run-audit.js";

describe("run-audit secret taxonomy", () => {
  it("keeps secret mutation types assignable to FilesystemMutationType", () => {
    const _check: readonly FilesystemMutationType[] = SECRET_MUTATION_TYPES;
    expect(_check).toHaveLength(13);
  });

  it("throws when forbidden plaintext-like keys are present", () => {
    for (const key of SECRET_AUDIT_PLAINTEXT_FORBIDDEN_KEYS) {
      expect(() => assertNoSecretPlaintext({ [key]: "x" })).toThrow(
        "secret audit metadata may not include plaintext fields",
      );
    }
  });

  it("accepts benign metadata", () => {
    expect(() => assertNoSecretPlaintext({ key: "API_KEY", scope: "project" })).not.toThrow();
    expect(() => assertNoSecretPlaintext(undefined)).not.toThrow();
  });
});
