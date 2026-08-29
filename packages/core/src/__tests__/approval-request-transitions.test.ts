/**
 * FNXC:ApprovalLifecycleSecurity 2026-07-26-12:35:
 * Pure-function tests for the approval-request lifecycle validator and lazy TTL expiry.
 * The transition table below is deliberately HARDCODED (all 16 from×to combos as literals, not generated
 * from the function or shared constants) so a regression in the validator cannot silently rewrite the
 * expectations: same-status replay (from===to) must be invalid because a replayed decision re-stamps
 * decidedAt and forges duplicate audit history.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  APPROVAL_REQUEST_GRANT_TTL_MS,
  getApprovalRequestGrantTtlMs,
  configureApprovalRequestTtls,
  APPROVAL_REQUEST_PENDING_TTL_MS,
  isApprovalRequestExpired,
  isValidApprovalRequestTransition,
  type ApprovalRequestStatus,
} from "../types/agents/index.js";

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

  it("approved grant is redeemable within the grant TTL of decidedAt", () => {
    expect(
      isApprovalRequestExpired(
        {
          status: "approved",
          requestedAt: new Date(T0 - 60_000).toISOString(),
          decidedAt: new Date(T0).toISOString(),
        },
        T0 + getApprovalRequestGrantTtlMs() - 1,
      ),
    ).toBe(false);
  });

  it("approved grant is expired past the grant TTL of decidedAt", () => {
    expect(
      isApprovalRequestExpired(
        {
          status: "approved",
          requestedAt: new Date(T0 - 60_000).toISOString(),
          decidedAt: new Date(T0).toISOString(),
        },
        T0 + getApprovalRequestGrantTtlMs() + 1,
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

  it("TTL defaults encode a 24h pending window and a 1h grant window", () => {
    expect(APPROVAL_REQUEST_PENDING_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(getApprovalRequestGrantTtlMs()).toBe(60 * 60 * 1000);
    expect(APPROVAL_REQUEST_GRANT_TTL_MS).toBe(60 * 60 * 1000);
  });

  /*
  FNXC:ApprovalLifecycleSecurity 2026-07-26-18:20:
  The grant window is a tradeoff an operator must be able to tune (a 15-minute hardcode expired
  grants during ordinary restarts and queue backlogs). These assert the override is honored by the
  expiry decision itself — not merely stored — and that a nonsense override cannot widen the window
  to infinity or collapse it to zero, which would silently re-open the unbounded-grant hazard.
  */
  describe("grant TTL is operator-configurable", () => {
    const approvedAtT0 = {
      status: "approved" as const,
      requestedAt: new Date(T0 - 60_000).toISOString(),
      decidedAt: new Date(T0).toISOString(),
    };

    afterEach(() => {
      configureApprovalRequestTtls({ grantTtlMs: undefined });
    });

    it("honors a configured override in the expiry decision", () => {
      configureApprovalRequestTtls({ grantTtlMs: 5 * 60 * 1000 });
      expect(getApprovalRequestGrantTtlMs()).toBe(5 * 60 * 1000);
      // Still inside the default hour, but past the configured five minutes.
      expect(isApprovalRequestExpired(approvedAtT0, T0 + 10 * 60 * 1000)).toBe(true);
      expect(isApprovalRequestExpired(approvedAtT0, T0 + 60_000)).toBe(false);
    });

    it("resets to the default when the override is cleared", () => {
      configureApprovalRequestTtls({ grantTtlMs: 5 * 60 * 1000 });
      configureApprovalRequestTtls({ grantTtlMs: undefined });
      expect(getApprovalRequestGrantTtlMs()).toBe(60 * 60 * 1000);
      expect(isApprovalRequestExpired(approvedAtT0, T0 + 10 * 60 * 1000)).toBe(false);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      "ignores the invalid override %p and keeps the default",
      (bad) => {
        configureApprovalRequestTtls({ grantTtlMs: bad });
        expect(getApprovalRequestGrantTtlMs()).toBe(60 * 60 * 1000);
      },
    );
  });
});
