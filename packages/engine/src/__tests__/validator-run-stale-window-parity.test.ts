import { describe, expect, it } from "vitest";
import { VALIDATION_INFLIGHT_STALE_MAX_AGE_MS } from "@fusion/core";
import { VALIDATOR_RUN_STALE_MAX_AGE_MS } from "../healing/self-healing-constants.js";

describe("validator stale-window parity", () => {
  it("keeps manual admission and the stale-run reaper on the same window", () => {
    expect(VALIDATION_INFLIGHT_STALE_MAX_AGE_MS).toBe(VALIDATOR_RUN_STALE_MAX_AGE_MS);
  });
});
