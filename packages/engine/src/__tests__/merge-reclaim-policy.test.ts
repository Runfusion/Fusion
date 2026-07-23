import { describe, expect, it } from "vitest";
import {
  canStartNextMergeBody,
  DEFAULT_MERGING_PHASE_SILENCE_FLOOR_MS,
  resolveMergingPhaseSilenceFloorMs,
  shouldReclaimWedgedMerge,
} from "../merge/merge-reclaim-policy.js";

/*
FNXC:MergeQueue 2026-07-15-10:05:
Pure-policy unit tests for status-aware silence reclaim and generation settle gating.
*/

describe("merge-reclaim-policy", () => {
  const stuck = 15 * 60_000;

  describe("shouldReclaimWedgedMerge", () => {
    it("does not reclaim below stuckTimeout for any status", () => {
      expect(
        shouldReclaimWedgedMerge({ status: "reviewing", silenceMs: stuck - 1, stuckTimeoutMs: stuck }),
      ).toBe(false);
      expect(
        shouldReclaimWedgedMerge({ status: "merging", silenceMs: stuck - 1, stuckTimeoutMs: stuck }),
      ).toBe(false);
      expect(
        shouldReclaimWedgedMerge({ status: null, silenceMs: stuck - 1, stuckTimeoutMs: stuck }),
      ).toBe(false);
    });

    it("reclaims reviewing after stuckTimeout silence (post-squash hang shape)", () => {
      expect(
        shouldReclaimWedgedMerge({ status: "reviewing", silenceMs: stuck, stuckTimeoutMs: stuck }),
      ).toBe(true);
      expect(
        shouldReclaimWedgedMerge({ status: "reviewing", silenceMs: stuck + 60_000, stuckTimeoutMs: stuck }),
      ).toBe(true);
    });

    it("does not false-reclaim merging-phase silence at stuckTimeout alone", () => {
      // Monorepo single bash can exceed stuckTimeout without agent logs.
      expect(
        shouldReclaimWedgedMerge({ status: "merging", silenceMs: stuck, stuckTimeoutMs: stuck }),
      ).toBe(false);
      expect(
        shouldReclaimWedgedMerge({ status: "merging-pr", silenceMs: stuck, stuckTimeoutMs: stuck }),
      ).toBe(false);
      expect(
        shouldReclaimWedgedMerge({ status: "merging-fix", silenceMs: stuck, stuckTimeoutMs: stuck }),
      ).toBe(false);
    });

    it("reclaims merging-phase only after the higher silence floor", () => {
      const floor = resolveMergingPhaseSilenceFloorMs(stuck);
      expect(floor).toBe(DEFAULT_MERGING_PHASE_SILENCE_FLOOR_MS);
      expect(
        shouldReclaimWedgedMerge({
          status: "merging",
          silenceMs: floor - 1,
          stuckTimeoutMs: stuck,
        }),
      ).toBe(false);
      expect(
        shouldReclaimWedgedMerge({
          status: "merging",
          silenceMs: floor,
          stuckTimeoutMs: stuck,
        }),
      ).toBe(true);
    });

    it("reclaims null-status dead pump after stuckTimeout (identity without merge badge)", () => {
      expect(
        shouldReclaimWedgedMerge({ status: null, silenceMs: stuck, stuckTimeoutMs: stuck }),
      ).toBe(true);
    });

    it("respects configured merging silence floor override", () => {
      expect(
        shouldReclaimWedgedMerge({
          status: "merging",
          silenceMs: 20 * 60_000,
          stuckTimeoutMs: stuck,
          mergingSilenceFloorMs: 20 * 60_000,
        }),
      ).toBe(true);
      expect(
        shouldReclaimWedgedMerge({
          status: "merging",
          silenceMs: 19 * 60_000,
          stuckTimeoutMs: stuck,
          mergingSilenceFloorMs: 20 * 60_000,
        }),
      ).toBe(false);
    });
  });

  describe("canStartNextMergeBody", () => {
    it("allows a new body only when no prior body is in flight", () => {
      expect(canStartNextMergeBody(null)).toBe(true);
      expect(canStartNextMergeBody(undefined)).toBe(true);
      const pending = new Promise<void>(() => {});
      expect(canStartNextMergeBody(pending)).toBe(false);
    });
  });
});
