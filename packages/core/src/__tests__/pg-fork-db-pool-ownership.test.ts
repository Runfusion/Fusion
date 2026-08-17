import { describe, expect, it } from "vitest";
import {
  PG_FORK_DB_POOL_PREFIX,
  parsePgForkDbPoolName,
  pgForkDbPoolIdentity,
  shouldReclaimPgForkDbPoolName,
} from "../__test-utils__/pg-fork-db-pool.js";

describe("PgForkDbPool ownership namespace", () => {
  it("is disjoint from the schema-template namespace in both directions", () => {
    const poolName = `${PG_FORK_DB_POOL_PREFIX}_123_run_1_nonce`;
    const templateName = "fusion_schema_template_123_goldenrun";
    const templateParser = /^fusion_schema_template_(\d+)(?:_[a-z0-9]+)?$/;
    expect(templateParser.test(poolName)).toBe(false);
    expect(parsePgForkDbPoolName(templateName)).toBeNull();
  });

  it("extracts only a pool owner pid and token", () => {
    expect(parsePgForkDbPoolName("fusion_pool_123_runabc_1_nonce")).toEqual({ pid: 123, token: "runabc" });
    expect(parsePgForkDbPoolName("fusion_pool_not-a-pid_run_1_nonce")).toBeNull();
  });

  it("keeps foreign and unknown owners outside this invocation's reclaim boundary", () => {
    const identity = pgForkDbPoolIdentity({
      FUSION_PG_TEMPLATE_OWNER_PID: "999",
      FUSION_TEST_WORKER_ROOT: "/tmp/fusion-test-workers-runabc",
    });
    const dead = () => false;
    const alive = () => true;
    expect(shouldReclaimPgForkDbPoolName("fusion_pool_123_fusiontestworkersrunabc_1_nonce", identity, dead, "invocation")).toBe(true);
    expect(shouldReclaimPgForkDbPoolName("fusion_pool_123_other_1_nonce", identity, dead, "invocation")).toBe(false);
    expect(shouldReclaimPgForkDbPoolName("fusion_pool_123_other_1_nonce", identity, dead, "orphan")).toBe(true);
    expect(shouldReclaimPgForkDbPoolName("fusion_pool_123_other_1_nonce", identity, alive, "orphan")).toBe(false);
    expect(shouldReclaimPgForkDbPoolName("fusion_pool_123_other_1_nonce", { ...identity, sharedInvocation: false }, dead, "orphan")).toBe(false);
  });
});
