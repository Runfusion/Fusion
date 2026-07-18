/**
 * FNXC:BackendFlip 2026-06-26-15:00:
 * Tests for the runtime startup factory (createTaskStoreForBackend).
 *
 * Post default-flip (flip-embedded-pg-default), embedded PostgreSQL is the
 * DEFAULT backend when DATABASE_URL is unset. The former
 * FUSION_NO_EMBEDDED_PG escape hatch is rejected after the final cutover so
 * production cannot silently return to a removed SQLite runtime. These
 * gate-relevant tests assert the
 * resolution contract without requiring a real embedded boot (the merge gate
 * must stay green without running initdb):
 *   - isEmbeddedPgRequested / isEmbeddedPgOptedOut resolution (opt-out
 *     semantics: embedded is on by default unless opted out).
 *   - shouldUsePostgresBackend always selects PostgreSQL.
 *   - createTaskStoreForBackend rejects obsolete SQLite opt-out controls.
 *   - createTaskStoreForBackend requires rootDir when projectId is absent.
 *
 * The external-mode and embedded-boot integration tests (real PG / real initdb)
 * live in the postgres/ integration suite and are skipped when PG/unreached.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTaskStoreForBackend,
  isEncodingConversionError,
  shouldUsePostgresBackend,
  isEmbeddedPgRequested,
  isEmbeddedPgOptedOut,
  EMBEDDED_PG_ENV,
  NO_EMBEDDED_PG_ENV,
} from "../../postgres/startup-factory.js";
import { resolveBackend } from "../../postgres/backend-resolver.js";

describe("startup-factory: isEmbeddedPgOptedOut (FUSION_NO_EMBEDDED_PG)", () => {
  // FNXC:BackendFlip 2026-06-26-15:00:
  // The parser remains for a precise startup diagnostic. Truthy values detect
  // the removed opt-out configuration; createTaskStoreForBackend rejects it.
  const cases: Array<[string, boolean]> = [
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["yes", true],
    ["Yes", true],
    ["on", true],
    ["0", false],
    ["false", false],
    ["", false],
    ["no", false],
    ["off", false],
    ["anything-else", false],
  ];

  for (const [raw, expected] of cases) {
    it(`treats FUSION_NO_EMBEDDED_PG="${raw}" as ${expected ? "obsolete opt-out configured" : "embedded PG default"}`, () => {
      expect(isEmbeddedPgOptedOut({ [NO_EMBEDDED_PG_ENV]: raw })).toBe(expected);
    });
  }

  it("defaults to process.env when no record is passed", () => {
    // No assertion on the exact value — just that it does not throw.
    expect(typeof isEmbeddedPgOptedOut()).toBe("boolean");
  });
});

describe("startup-factory: isEmbeddedPgRequested (inverted: default-on)", () => {
  // FNXC:BackendFlip 2026-06-26-15:00:
  // isEmbeddedPgRequested is now the logical inverse of isEmbeddedPgOptedOut:
  // embedded PG is requested UNLESS the obsolete opt-out is present; startup
  // rejects that configuration instead of selecting another backend.
  it("returns true by default (embedded PG is the default backend)", () => {
    expect(isEmbeddedPgRequested({})).toBe(true);
  });

  it("returns false when obsolete FUSION_NO_EMBEDDED_PG=1 is detected", () => {
    expect(isEmbeddedPgRequested({ [NO_EMBEDDED_PG_ENV]: "1" })).toBe(false);
  });

  it("returns false when FUSION_NO_EMBEDDED_PG=true is set", () => {
    expect(isEmbeddedPgRequested({ [NO_EMBEDDED_PG_ENV]: "true" })).toBe(false);
  });

  it("returns true when FUSION_NO_EMBEDDED_PG is a non-truthy value (e.g. 0)", () => {
    expect(isEmbeddedPgRequested({ [NO_EMBEDDED_PG_ENV]: "0" })).toBe(true);
  });

  it("legacy FUSION_EMBEDDED_PG is a no-op alias (does not force embedded; default already on)", () => {
    // FNXC:BackendFlip 2026-06-26-15:00:
    // Setting FUSION_EMBEDDED_PG=1 used to opt in; now it is a no-op because
    // embedded is already the default. Setting it to 0 also does nothing
    // (it cannot opt out; the former opt-out now fails startup).
    expect(isEmbeddedPgRequested({ [EMBEDDED_PG_ENV]: "1" })).toBe(true);
    expect(isEmbeddedPgRequested({ [EMBEDDED_PG_ENV]: "0" })).toBe(true);
  });
});

describe("startup-factory: shouldUsePostgresBackend", () => {
  it("returns true when DATABASE_URL is set (external mode)", () => {
    expect(
      shouldUsePostgresBackend({ DATABASE_URL: "postgresql://localhost:5432/fusion" }),
    ).toBe(true);
  });

  it("returns true by default when DATABASE_URL is unset (embedded PG default)", () => {
    // FNXC:BackendFlip 2026-06-26-15:00:
    // Post default-flip, embedded PG is the default. shouldUsePostgresBackend
    // returns true unless the operator explicitly opted out.
    expect(shouldUsePostgresBackend({})).toBe(true);
  });

  it("returns true when DATABASE_URL is empty/whitespace (embedded default)", () => {
    expect(shouldUsePostgresBackend({ DATABASE_URL: "   " })).toBe(true);
  });

  it("returns true when the obsolete SQLite opt-out is present", () => {
    expect(
      shouldUsePostgresBackend({ [NO_EMBEDDED_PG_ENV]: "1" }),
    ).toBe(true);
  });

  it("returns true when the obsolete embedded override is false", () => {
    expect(shouldUsePostgresBackend({}, { embeddedPgRequested: false })).toBe(true);
  });

  it("returns true when embeddedPgRequested override is true (force embedded)", () => {
    expect(shouldUsePostgresBackend({}, { embeddedPgRequested: true })).toBe(true);
  });
});

describe("startup-factory: createTaskStoreForBackend resolution (no real boot)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("rejects FUSION_NO_EMBEDDED_PG instead of falling back to SQLite", async () => {
    await expect(createTaskStoreForBackend({
      rootDir,
      env: { [NO_EMBEDDED_PG_ENV]: "1" },
    })).rejects.toThrow(/SQLite opt-out.*removed/i);
  });

  it("rejects the SQLite opt-out when DATABASE_URL is whitespace", async () => {
    await expect(createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: "   ", [NO_EMBEDDED_PG_ENV]: "1" },
    })).rejects.toThrow(/SQLite opt-out.*removed/i);
  });

  it("rejects embeddedPgRequested:false instead of forcing SQLite", async () => {
    await expect(createTaskStoreForBackend({
      rootDir,
      env: {},
      embeddedPgRequested: false,
    })).rejects.toThrow(/SQLite opt-out.*removed/i);
  });

  it("throws when rootDir is missing and projectId is absent (and PG is requested)", async () => {
    // Force external mode so we reach the rootDir guard.
    await expect(
      createTaskStoreForBackend({
        env: { DATABASE_URL: "postgresql://localhost:5432/fusion" },
      }),
    ).rejects.toThrow(/rootDir is required/i);
  });

  it("rejects the removed SQLite opt-out before validating a project root", async () => {
    await expect(createTaskStoreForBackend({
      env: { [NO_EMBEDDED_PG_ENV]: "1" },
    })).rejects.toThrow(/SQLite opt-out.*removed/i);
  });
});

describe("startup-factory: backend descriptor propagation", () => {
  it("the factory respects an explicitly-provided external backend even when env has no DATABASE_URL", async () => {
    // Provide an explicit external backend so resolveBackend() is bypassed.
    // We expect the factory to attempt a real connection (which will fail in
    // the absence of a reachable server) and surface a connection error —
    // proving the factory honored the explicit backend override rather than
    // short-circuiting to the legacy SQLite default.
    const backend = resolveBackend({ DATABASE_URL: "postgresql://localhost:5432/fusion" });
    expect(backend.mode).toBe("external");

    await expect(
      createTaskStoreForBackend({
        rootDir: "/tmp/startup-factory-nonexistent",
        env: {},
        backend,
      }),
    ).rejects.toThrow();
  });
});

/*
FNXC:PostgresEmbedded 2026-07-18-01:10:
Issue #2286 auto-recovery trigger. The classifier must catch PostgreSQL's
encoding-conversion failure raised when a non-UTF-8 cluster (WIN1252/WIN1254
from a pre-fix initdb on a non-UTF-8 OS locale) receives the UTF-8 schema
SQL — and nothing else, so ordinary schema errors never delete a data dir.
*/
describe("isEncodingConversionError (#2286 recovery trigger)", () => {
  it("matches the encoding-conversion failure from a non-UTF-8 cluster", () => {
    expect(
      isEncodingConversionError(
        'character with byte sequence 0xe2 0x86 0x92 in encoding "UTF8" has no equivalent in encoding "WIN1254"',
      ),
    ).toBe(true);
    expect(
      isEncodingConversionError(
        'Failed query: CREATE TABLE ... params: caused by: character with byte sequence 0xe2 0x86 0x92 in encoding "UTF8" has no equivalent in encoding "WIN1252"',
      ),
    ).toBe(true);
  });

  it("does not match unrelated schema or connection errors", () => {
    expect(isEncodingConversionError('syntax error at or near "CREATE"')).toBe(false);
    expect(isEncodingConversionError("connection refused")).toBe(false);
    expect(isEncodingConversionError('FATAL: invalid value for parameter "shared_memory_type"')).toBe(false);
  });
});
