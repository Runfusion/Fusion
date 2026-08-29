import { describe, expect, it } from "vitest";

// This contract test fails loudly if dashboard denial-reason enum values change without updating cross-node consumers.
describe("reliability: node settings sync auth denial-reason contract", () => {
  it("pins the SyncStatusDenialReason enum values consumed by cross-node sync-status callers", async () => {
    const { SYNC_STATUS_DENIAL_REASONS, classifySyncStatusDenialReason } = await import(
      new URL("../../../../dashboard/src/routes/register-settings-sync-helpers.js", import.meta.url).href
    ) as {
      SYNC_STATUS_DENIAL_REASONS: readonly string[];
      classifySyncStatusDenialReason: (err: unknown) => string;
    };
    const { ApiError } = await import(
      new URL("../../../../dashboard/src/api-error.js", import.meta.url).href
    ) as {
      ApiError: new (status: number, message: string) => Error;
    };

    expect(SYNC_STATUS_DENIAL_REASONS).toEqual(["missing-remote-api-key", "auth-failed", "unreachable", "unknown"]);

    expect(classifySyncStatusDenialReason(new ApiError(400, "Remote node requires an apiKey for authenticated sync"))).toBe("missing-remote-api-key");
    expect(classifySyncStatusDenialReason(new ApiError(502, "Remote node authentication failed"))).toBe("auth-failed");
    expect(classifySyncStatusDenialReason(new ApiError(504, "Remote node unreachable"))).toBe("unreachable");
    expect(classifySyncStatusDenialReason("boom")).toBe("unknown");
  });
});
