/**
 * FNXC:BackendFlip 2026-06-26-15:00:
 * Tests for the runtime startup factory (createTaskStoreForBackend).
 *
 * Post default-flip (flip-embedded-pg-default), embedded PostgreSQL is the
 * DEFAULT backend when DATABASE_URL is unset. FUSION_NO_EMBEDDED_PG=1 is the
 * opt-out back to legacy SQLite. These gate-relevant tests assert the
 * resolution contract without requiring a real embedded boot (the merge gate
 * must stay green without running initdb):
 *   - isEmbeddedPgRequested / isEmbeddedPgOptedOut resolution (opt-out
 *     semantics: embedded is on by default unless opted out).
 *   - shouldUsePostgresBackend resolution (true by default; false only on opt-out).
 *   - createTaskStoreForBackend returns null ONLY when the operator opted out
 *     (FUSION_NO_EMBEDDED_PG=1) or passed embeddedPgRequested:false.
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
  shouldUsePostgresBackend,
  isEmbeddedPgRequested,
  isEmbeddedPgOptedOut,
  EMBEDDED_PG_ENV,
  NO_EMBEDDED_PG_ENV,
} from "../../postgres/startup-factory.js";
import { resolveBackend } from "../../postgres/backend-resolver.js";

describe("startup-factory: isEmbeddedPgOptedOut (FUSION_NO_EMBEDDED_PG)", () => {
  // FNXC:BackendFlip 2026-06-26-15:00:
  // Post default-flip, the opt-out is the single control. Truthy values opt
  // OUT of embedded PG (back to legacy SQLite); everything else keeps the
  // embedded default.
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
    it(`treats FUSION_NO_EMBEDDED_PG="${raw}" as ${expected ? "opted-out (legacy SQLite)" : "not opted-out (embedded PG default)"}`, () => {
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
  // embedded PG is requested (used) UNLESS FUSION_NO_EMBEDDED_PG opts out.
  it("returns true by default (embedded PG is the default backend)", () => {
    expect(isEmbeddedPgRequested({})).toBe(true);
  });

  it("returns false when FUSION_NO_EMBEDDED_PG=1 is set (opt-out to legacy SQLite)", () => {
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
    // (it cannot opt out — only FUSION_NO_EMBEDDED_PG can).
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

  it("returns false when DATABASE_URL is unset AND FUSION_NO_EMBEDDED_PG=1 (opt-out)", () => {
    expect(
      shouldUsePostgresBackend({ [NO_EMBEDDED_PG_ENV]: "1" }),
    ).toBe(false);
  });

  it("returns false when embeddedPgRequested override is false (force legacy SQLite)", () => {
    expect(shouldUsePostgresBackend({}, { embeddedPgRequested: false })).toBe(false);
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

  it("returns null when FUSION_NO_EMBEDDED_PG=1 opts out (legacy SQLite path)", async () => {
    // FNXC:BackendFlip 2026-06-26-15:00:
    // The ONLY way to get the legacy SQLite null result post default-flip is
    // the explicit opt-out. This keeps the gate fast (no initdb) for tests
    // that need the legacy path.
    const result = await createTaskStoreForBackend({
      rootDir,
      env: { [NO_EMBEDDED_PG_ENV]: "1" }, // no DATABASE_URL, opt-out
    });
    expect(result).toBeNull();
  });

  it("returns null when DATABASE_URL is whitespace and FUSION_NO_EMBEDDED_PG=1", async () => {
    const result = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: "   ", [NO_EMBEDDED_PG_ENV]: "1" },
    });
    expect(result).toBeNull();
  });

  it("returns null when embeddedPgRequested override is false (force legacy SQLite)", async () => {
    const result = await createTaskStoreForBackend({
      rootDir,
      env: {},
      embeddedPgRequested: false,
    });
    expect(result).toBeNull();
  });

  it("throws when rootDir is missing and projectId is absent (and PG is requested)", async () => {
    // Force external mode so we reach the rootDir guard.
    await expect(
      createTaskStoreForBackend({
        env: { DATABASE_URL: "postgresql://localhost:5432/fusion" },
      }),
    ).rejects.toThrow(/rootDir is required/i);
  });

  it("does not throw on the legacy SQLite opt-out path even without rootDir (short-circuits before the guard)", async () => {
    // FNXC:BackendFlip 2026-06-26-15:00:
    // Opt-out path: returns null before reaching the rootDir guard.
    const result = await createTaskStoreForBackend({
      env: { [NO_EMBEDDED_PG_ENV]: "1" },
    });
    expect(result).toBeNull();
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
