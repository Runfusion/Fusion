import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolvePgSetupParticipation } from "../__test-utils__/pg-setup-participation.js";

describe("PostgreSQL setup participation", () => {
  it.each([undefined, "", " ", "0", "true", "1 "])("keeps %j non-participating", (value) => {
    expect(resolvePgSetupParticipation(value === undefined ? {} : { FUSION_PG_TEST_SETUP_PARTICIPANT: value })).toEqual({ participating: false, reason: "not-opted-in" });
  });

  it("accepts only the explicit participant value and honors skip", () => {
    expect(resolvePgSetupParticipation({ FUSION_PG_TEST_SETUP_PARTICIPANT: "1" })).toEqual({ participating: true, reason: "enabled" });
    expect(resolvePgSetupParticipation({ FUSION_PG_TEST_SETUP_PARTICIPANT: "1", FUSION_PG_TEST_SKIP: "1", FUSION_PG_TEST_PREADMISSION_PROBE: "1" })).toEqual({ participating: false, reason: "skip-requested" });
  });

  it("has no PostgreSQL or harness dependency", () => {
    const source = readFileSync(new URL("../__test-utils__/pg-setup-participation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/postgres|pg-test-harness|node:net|node:fs/);
    expect(source).not.toMatch(/process\.env\s*\[[^\]]+\]\s*=/);
  });
});
