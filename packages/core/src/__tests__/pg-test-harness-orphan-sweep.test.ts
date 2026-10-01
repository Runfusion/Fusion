/**
 * FNXC:PgTestOrphanSweep 2026-09-28-00:32:
 * Pure-function coverage for the per-file orphan-sweep name matcher. A killed
 * vitest run leaves its `uniqueDbName` per-file databases behind with no
 * reclamation path; the golden-template sweep now drops any per-file database
 * whose embedded (dead) pid is gone. The safety-critical property is that the
 * matcher extracts the OWNING pid for genuine per-file names and returns null
 * for templates and real Fusion project databases, so the sweep can never drop
 * something it does not own.
 */
import { describe, it, expect } from "vitest";
import { __pgTestTemplateTestHooks } from "../__test-utils__/pg-test-harness.js";

const { parsePerFileDbPid } = __pgTestTemplateTestHooks;

describe("per-file orphan-sweep name matcher", () => {
  it("extracts the owning pid from a uniqueDbName-shaped per-file database", () => {
    // uniqueDbName: `${prefix}_${process.pid}_${counter}_${random6}`
    expect(parsePerFileDbPid("fusion_shared_12345_7_abc123")).toBe(12345);
    expect(parsePerFileDbPid("fusion_handoff_atomic_98765_1_zx09qq")).toBe(98765);
  });

  it("resolves the pid even when the prefix itself ends in digits", () => {
    // e.g. observed leftover `fusion_u8_health_64841_10_ax10e0`: the pid is the
    // FIRST of the three trailing `_<pid>_<counter>_<random6>` segments.
    expect(parsePerFileDbPid("fusion_u8_health_64841_10_ax10e0")).toBe(64841);
  });

  it("handles an all-digit random suffix without misreading the pid", () => {
    // Math.random().toString(36) can produce an all-digit 6-char token.
    expect(parsePerFileDbPid("fusion_shared_555_3_123456")).toBe(555);
  });

  it("never matches a schema-template database (those have a dedicated sweep)", () => {
    expect(parsePerFileDbPid("fusion_schema_template_95722_goldenestworkersnhtgkd")).toBeNull();
    expect(parsePerFileDbPid("fusion_schema_template_601")).toBeNull();
  });

  it("never matches a real Fusion project database", () => {
    expect(parsePerFileDbPid("fusion")).toBeNull();
    expect(parsePerFileDbPid("fusion_prod")).toBeNull();
    expect(parsePerFileDbPid("fusion_my_project")).toBeNull();
    // A non-fusion database is out of scope entirely.
    expect(parsePerFileDbPid("app_12345_1_abc123")).toBeNull();
  });

  it("rejects names missing the full per-file tail", () => {
    expect(parsePerFileDbPid("fusion_shared_12345_7")).toBeNull(); // no random6
    expect(parsePerFileDbPid("fusion_shared_12345")).toBeNull(); // pid only
    expect(parsePerFileDbPid("fusion_shared_12345_7_abc12")).toBeNull(); // random too short
    expect(parsePerFileDbPid("fusion_shared_12345_7_abc1234")).toBeNull(); // random too long
  });
});
