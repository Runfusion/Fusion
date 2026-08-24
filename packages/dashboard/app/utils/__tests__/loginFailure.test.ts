import { describe, expect, it } from "vitest";
import { describeLoginFailure } from "../loginFailure";

/*
FNXC:ProviderAuth 2026-08-18-07:10:
An operator hit `OAuth state mismatch` — a pasted redirect URL from an older sign-in attempt — and
both login surfaces reported it as "Login did not complete. Please try again.", which describes a
transient failure and prescribes the one action that reproduces it. These pin that the server's
reason survives to the operator, and that the two self-inflicted cases say what to do differently.
*/
describe("describeLoginFailure", () => {
  it("explains a stale-tab state mismatch instead of suggesting a blind retry", () => {
    const message = describeLoginFailure("OAuth state mismatch");
    expect(message).toMatch(/earlier sign-in attempt/i);
    expect(message).toMatch(/newest tab/i);
    expect(message).not.toMatch(/^Login did not complete/);
  });

  it("explains a spent authorization code", () => {
    const upstream = "Token exchange request failed. body={\"error\": \"invalid_grant\", \"error_description\": \"Invalid 'code' in request.\"}";
    expect(describeLoginFailure(upstream)).toMatch(/already used or has expired/i);
  });

  it("names a cancellation as one", () => {
    expect(describeLoginFailure("This operation was aborted")).toMatch(/cancelled/i);
  });

  it("passes an unrecognized upstream reason through verbatim", () => {
    // A specific upstream message always beats replacing it with the generic sentence.
    const upstream = "OpenAI Codex token exchange failed (401): token_expired";
    expect(describeLoginFailure(upstream)).toBe(upstream);
  });

  it("falls back to the generic sentence only when the server gave no reason", () => {
    expect(describeLoginFailure(undefined)).toBe("Login did not complete. Please try again.");
    expect(describeLoginFailure("   ")).toBe("Login did not complete. Please try again.");
  });
});
