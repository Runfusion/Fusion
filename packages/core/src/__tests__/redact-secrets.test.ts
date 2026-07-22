import { describe, it, expect } from "vitest";
import { redactSecrets } from "../secrets/redact-secrets.js";

// Parity fixtures mirror the original ACP plugin's process-manager tests so the
// shared implementation produces identical behavior (Risk S8).
describe("redactSecrets (shared @fusion/core)", () => {
  it("redacts bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer sk-live-ABCDEFG1234567890abcdef");
    expect(out).not.toContain("sk-live-ABCDEFG1234567890abcdef");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts key=/token= assignments", () => {
    const out = redactSecrets("api_key=abcdef0123456789 token=ZZZ987654321");
    expect(out).not.toContain("abcdef0123456789");
    expect(out).not.toContain("ZZZ987654321");
  });

  it("redacts long opaque hex/base64 secrets", () => {
    const out = redactSecrets("value 0123456789abcdef0123456789abcdef done");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("leaves benign text intact", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });

  it("redacts standalone sk-/ghp_/AKIA opaque tokens", () => {
    const out = redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out).toBe("[REDACTED]");
  });

  it("redacts quoted secret assignments", () => {
    const out = redactSecrets('client_secret="topsecretvalue123"');
    expect(out).not.toContain("topsecretvalue123");
    expect(out).toContain("[REDACTED]");
  });
});
