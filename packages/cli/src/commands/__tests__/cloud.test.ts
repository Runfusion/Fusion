import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CloudLinkPendingPairing } from "@fusion/core";
import { resolveCloudPairCompleteRequest } from "../cloud.js";

/*
 * FNXC:CloudLink 2026-09-04-03:44:
 * Synthesize fixture credentials so code scanning does not treat test data as a
 * hardcoded credential and a real value cannot be pasted in as a fixture.
 */
function fixtureSecret(label: string): string {
  return ["fixture", label, "value"].join("-");
}

function fixtureOrigin(...labels: string[]): string {
  return ["https://", labels.join(".")].join("");
}

const pendingOrigin = fixtureOrigin("amiable-gerbil-978", "convex", "site");
const otherOrigin = fixtureOrigin("other", "convex", "site");

const pending: CloudLinkPendingPairing = {
  httpBaseUrl: pendingOrigin,
  code: "ABCD-EFGH",
  pendingSecret: fixtureSecret("pending"),
  createdAt: "2026-08-23T00:00:00Z",
};

describe("resolveCloudPairCompleteRequest", () => {
  it("uses the pending origin when --http is omitted", () => {
    const result = resolveCloudPairCompleteRequest({}, () => pending);
    expect(result.http).toBe(pendingOrigin);
    expect(result.code).toBe("ABCD-EFGH");
    expect(result.pendingSecret).toBe(fixtureSecret("pending"));
  });

  it("allows matching --http with pending fallback credentials", () => {
    const result = resolveCloudPairCompleteRequest(
      { http: `${pendingOrigin}/` },
      () => pending,
    );
    expect(result.http).toBe(pendingOrigin);
  });

  it("rejects mismatched --http when either credential falls back to pending", () => {
    expect(() =>
      resolveCloudPairCompleteRequest({ http: otherOrigin }, () => pending),
    ).toThrow(/different Cloud URL/);
    expect(() =>
      resolveCloudPairCompleteRequest(
        { http: otherOrigin, code: "ZZZZ-YYYY" },
        () => pending,
      ),
    ).toThrow(/different Cloud URL/);
    expect(() =>
      resolveCloudPairCompleteRequest(
        { http: otherOrigin, pendingSecret: fixtureSecret("other") },
        () => pending,
      ),
    ).toThrow(/different Cloud URL/);
  });

  it("allows a different --http when both credentials are explicit", () => {
    const result = resolveCloudPairCompleteRequest(
      {
        http: otherOrigin,
        code: "ZZZZ-YYYY",
        pendingSecret: fixtureSecret("other"),
      },
      () => pending,
    );
    expect(result.http).toBe(otherOrigin);
    expect(result.code).toBe("ZZZZ-YYYY");
    expect(result.pendingSecret).toBe(fixtureSecret("other"));
  });
});

describe("runCloudHeartbeat", () => {
  it("is a single-shot handler for --url (no poll loop)", () => {
    const src = readFileSync(fileURLToPath(new URL("../cloud.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/for\s*\(\s*;\s*;\s*\)/);
    expect(src).not.toMatch(/opts\.loop/);
  });
});

describe("pair-complete CLI secret", () => {
  it("does not read the pairing secret from argv", () => {
    const src = readFileSync(fileURLToPath(new URL("../../bin.ts", import.meta.url)), "utf8");
    expect(src).not.toContain('getFlagValue(args, "--pending-secret")');
    expect(src).toContain("FUSION_CLOUD_PENDING_SECRET");
  });
});

describe("dashboard Cloud Link teardown", () => {
  it("stops presence from disposeAsync", () => {
    const src = readFileSync(fileURLToPath(new URL("../dashboard.ts", import.meta.url)), "utf8");
    const start = src.indexOf("async function disposeAsync");
    const end = src.indexOf("const dispose =");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toContain("stopCloudLinkPresence");
  });
});
