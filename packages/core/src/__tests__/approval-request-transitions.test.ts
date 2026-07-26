/**
 * FNXC:ApprovalLifecycleSecurity 2026-07-26-12:35:
 * Pure-function tests for the approval-request lifecycle validator and lazy TTL expiry.
 * The transition table below is deliberately HARDCODED (all 16 from×to combos as literals, not generated
 * from the function or shared constants) so a regression in the validator cannot silently rewrite the
 * expectations: same-status replay (from===to) must be invalid because a replayed decision re-stamps
 * decidedAt and forges duplicate audit history.
 */
import { describe, it, expect } from "vitest";
import {
  APPROVAL_REQUEST_GRANT_TTL_MS,
  APPROVAL_REQUEST_PENDING_TTL_MS,
  isApprovalRequestExpired,
  isValidApprovalRequestTransition,
  type ApprovalRequestStatus,
} from "../types/agents.js";

describe("isValidApprovalRequestTransition", () => {
  // Hardcoded 16-row expectation table: [from, to, expected].
  const table: Array<[ApprovalRequestStatus, ApprovalRequestStatus, boolean]> = [
    ["pending", "pending", false],
    ["pending", "approved", true],
    ["pending", "denied", true],
    ["pending", "completed", false],
    ["approved", "pending", false],
    ["approved", "approved", false],
    ["approved", "denied", false],
    ["approved", "completed", true],
    ["denied", "pending", false],
    ["denied", "approved", false],
    ["denied", "denied", false],
    ["denied", "completed", false],
    ["completed", "pending", false],
    ["completed", "approved", false],
    ["completed", "denied", false],
    ["completed", "completed", false],
  ];

  it.each(table)("%s -> %s is %s", (from, to, expected) => {
    expect(isValidApprovalRequestTransition(from, to)).toBe(expected);
  });

  it("rejects all four from===to replay combos", () => {
    for (const status of ["pending", "approved", "denied", "completed"] as const) {
      expect(isValidApprovalRequestTransition(status, status)).toBe(false);
    }
  });
});

describe("isApprovalRequestExpired", () => {
  const T0 = Date.parse("2026-07-26T00:00:00.000Z");

  it("pending is not expired within 24h of requestedAt", () => {
    expect(
      isApprovalRequestExpired(
        { status: "pending", requestedAt: new Date(T0).toISOString(), decidedAt: undefined },
        T0 + APPROVAL_REQUEST_PENDING_TTL_MS - 1,
      ),
    ).toBe(false);
    expect(
      isApprovalRequestExpired(
        { status: "pending", requestedAt: new Date(T0).toISOString(), decidedAt: undefined },
        T0 + APPROVAL_REQUEST_PENDING_TTL_MS,
      ),
    ).toBe(false);
  });

  it("pending is expired past 24h of requestedAt", () => {
    expect(
      isApprovalRequestExpired(
        { status: "pending", requestedAt: new Date(T0).toISOString(), decidedAt: undefined },
        T0 + APPROVAL_REQUEST_PENDING_TTL_MS + 1,
      ),
    ).toBe(true);
  });

  it("approved grant is redeemable within 15min of decidedAt", () => {
    expect(
      isApprovalRequestExpired(
        {
          status: "approved",
          requestedAt: new Date(T0 - 60_000).toISOString(),
          decidedAt: new Date(T0).toISOString(),
        },
        T0 + APPROVAL_REQUEST_GRANT_TTL_MS - 1,
      ),
    ).toBe(false);
  });

  it("approved grant is expired past 15min of decidedAt", () => {
    expect(
      isApprovalRequestExpired(
        {
          status: "approved",
          requestedAt: new Date(T0 - 60_000).toISOString(),
          decidedAt: new Date(T0).toISOString(),
        },
        T0 + APPROVAL_REQUEST_GRANT_TTL_MS + 1,
      ),
    ).toBe(true);
  });

  it("approved row with missing decidedAt is treated as expired (fail closed)", () => {
    expect(
      isApprovalRequestExpired(
        { status: "approved", requestedAt: new Date(T0).toISOString(), decidedAt: undefined },
        T0,
      ),
    ).toBe(true);
  });

  it("approved row with unparseable decidedAt is treated as expired (fail closed)", () => {
    expect(
      isApprovalRequestExpired(
        { status: "approved", requestedAt: new Date(T0).toISOString(), decidedAt: "not-a-date" },
        T0,
      ),
    ).toBe(true);
  });

  it("denied and completed never expire", () => {
    const farFuture = T0 + 365 * 24 * 60 * 60 * 1000;
    expect(
      isApprovalRequestExpired(
        { status: "denied", requestedAt: new Date(T0).toISOString(), decidedAt: new Date(T0).toISOString() },
        farFuture,
      ),
    ).toBe(false);
    expect(
      isApprovalRequestExpired(
        {
          status: "completed",
          requestedAt: new Date(T0).toISOString(),
          decidedAt: new Date(T0).toISOString(),
        },
        farFuture,
      ),
    ).toBe(false);
  });

  it("TTL constants encode 24h pending / 15min grant windows", () => {
    expect(APPROVAL_REQUEST_PENDING_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(APPROVAL_REQUEST_GRANT_TTL_MS).toBe(15 * 60 * 1000);
  });
});
