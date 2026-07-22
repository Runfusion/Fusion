/**
 * FNXC:PostgresMigrationNulSanitize 2026-07-20:
 * Unit coverage for the shared NUL-byte sanitizer (packages/core/src/postgres/nul-sanitize.ts),
 * extracted from sqlite-migrator.ts so live write paths (async-chat-store.ts,
 * async-message-store.ts) can reuse the same tested behavior. No PostgreSQL
 * connection required — pure function coverage.
 */

import { describe, it, expect } from "vitest";
import {
  stripNulChars,
  deepStripNulChars,
  sanitizeTextValue,
  sanitizeJsonbValue,
} from "../postgres/nul-sanitize.js";

describe("stripNulChars", () => {
  it("removes U+0000 from a string", () => {
    expect(stripNulChars("hello\u0000world")).toBe("helloworld");
  });

  it("is a no-op when no NUL is present", () => {
    expect(stripNulChars("clean string")).toBe("clean string");
  });

  it("strips multiple NUL bytes", () => {
    expect(stripNulChars("a\u0000b\u0000c\u0000")).toBe("abc");
  });
});

describe("deepStripNulChars", () => {
  it("strips NUL from nested string values and object keys", () => {
    const input = {
      ["key\u0000nul"]: "value\u0000nul",
      nested: ["a\u0000b", { deeper: "c\u0000d" }],
    };
    expect(deepStripNulChars(input)).toEqual({
      keynul: "valuenul",
      nested: ["ab", { deeper: "cd" }],
    });
  });

  it("passes through non-string primitives and null unchanged", () => {
    expect(deepStripNulChars(42)).toBe(42);
    expect(deepStripNulChars(true)).toBe(true);
    expect(deepStripNulChars(null)).toBe(null);
  });
});

describe("sanitizeTextValue", () => {
  it("strips NUL from a string value", () => {
    expect(sanitizeTextValue("diag\u0000nostic dump")).toBe("diagnostic dump");
  });

  it("passes through null/undefined unchanged", () => {
    expect(sanitizeTextValue(null)).toBe(null);
    expect(sanitizeTextValue(undefined)).toBe(undefined);
  });
});

describe("sanitizeJsonbValue", () => {
  it("deep-strips NUL from an object destined for a jsonb column", () => {
    expect(sanitizeJsonbValue({ note: "tail\u0000end" })).toEqual({ note: "tailend" });
  });

  it("passes through null/undefined unchanged", () => {
    expect(sanitizeJsonbValue(null)).toBe(null);
    expect(sanitizeJsonbValue(undefined)).toBe(undefined);
  });

  it("handles the exact failure signature observed in production: a raw NUL embedded in a diagnostics dump", () => {
    // Real-world trigger: an agent piped a Windows CLI diagnostics dump
    // (tasklist/netstat output) directly into a chat message body. The dump
    // contained a raw NUL byte, which Postgres's json_ereport_error rejected
    // with "unsupported Unicode escape sequence" / "\u0000 cannot be
    // converted to text", aborting the chat write mid-conversation.
    const diagnosticDump =
      "===FUSION DB AGENTS===\n===NODES===\n\u0000===RUNNING PROCESSES===\n";
    expect(sanitizeTextValue(diagnosticDump)).toBe(
      "===FUSION DB AGENTS===\n===NODES===\n===RUNNING PROCESSES===\n",
    );
    expect(sanitizeJsonbValue({ toolOutput: diagnosticDump })).toEqual({
      toolOutput: "===FUSION DB AGENTS===\n===NODES===\n===RUNNING PROCESSES===\n",
    });
  });
});
