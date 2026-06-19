// @vitest-environment node

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DeliveryNonceCache,
  SignalRateLimiter,
  applySignalCaps,
  fallbackGroupingKey,
  isSafeExternalUrl,
  isWithinReplayWindow,
  normalizeTitleForGrouping,
  verifyHmacSignature,
  type Signal,
  SIGNAL_FIELD_CAPS,
} from "../signal-source.js";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

describe("verifyHmacSignature", () => {
  it("accepts a matching signature and rejects a wrong one", () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const secret = "s3cr3t";
    const good = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyHmacSignature(body, good, secret)).toBe(true);
    expect(verifyHmacSignature(body, good, "wrong")).toBe(false);
    expect(verifyHmacSignature(body, undefined, secret)).toBe(false);
    expect(verifyHmacSignature(body, "deadbeef", secret)).toBe(false);
  });
});

describe("isWithinReplayWindow", () => {
  it("accepts recent timestamps and rejects stale or missing ones", () => {
    const now = 1_000_000_000_000;
    expect(isWithinReplayWindow(now, now)).toBe(true);
    expect(isWithinReplayWindow(now - 4 * 60_000, now)).toBe(true);
    expect(isWithinReplayWindow(now - 6 * 60_000, now)).toBe(false);
    expect(isWithinReplayWindow(undefined, now)).toBe(false);
  });
});

describe("DeliveryNonceCache", () => {
  it("rejects a replayed nonce within the window", () => {
    const cache = new DeliveryNonceCache(1000);
    expect(cache.check("a", 0)).toBe(true);
    expect(cache.check("a", 500)).toBe(false);
    // After TTL the nonce is evictable again.
    expect(cache.check("a", 2000)).toBe(true);
  });
});

describe("SignalRateLimiter", () => {
  it("caps a flood per source", () => {
    const limiter = new SignalRateLimiter(1000, 3);
    expect(limiter.allow("x", 0)).toBe(true);
    expect(limiter.allow("x", 1)).toBe(true);
    expect(limiter.allow("x", 2)).toBe(true);
    expect(limiter.allow("x", 3)).toBe(false);
    // A different source is independent.
    expect(limiter.allow("y", 3)).toBe(true);
    // After the window slides, capacity returns.
    expect(limiter.allow("x", 2000)).toBe(true);
  });
});

describe("isSafeExternalUrl (SSRF guard)", () => {
  it("rejects loopback, private, and non-http schemes; accepts public https", () => {
    expect(isSafeExternalUrl("https://sentry.io/issues/1")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("https://localhost/x")).toBe(false);
    expect(isSafeExternalUrl("http://127.0.0.1")).toBe(false);
    expect(isSafeExternalUrl("http://10.0.0.5")).toBe(false);
    expect(isSafeExternalUrl("http://192.168.1.1")).toBe(false);
    expect(isSafeExternalUrl("http://169.254.169.254")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl(undefined)).toBe(false);
  });
});

describe("grouping key fallback", () => {
  it("derives source + normalized title", () => {
    expect(normalizeTitleForGrouping("  Some   ERROR  ")).toBe("some error");
    expect(fallbackGroupingKey("webhook", "Disk Full!")).toBe("webhook:disk full!");
  });
});

describe("applySignalCaps", () => {
  it("truncates long fields and drops oversized meta + unsafe links", () => {
    const signal: Signal = {
      source: "webhook",
      externalId: "e1",
      groupingKey: "g1",
      title: "x".repeat(SIGNAL_FIELD_CAPS.title + 50),
      body: "y".repeat(SIGNAL_FIELD_CAPS.body + 50),
      severity: "error",
      link: "http://127.0.0.1/internal",
      meta: { big: "z".repeat(SIGNAL_FIELD_CAPS.metaBytes + 100) },
    };
    const capped = applySignalCaps(signal);
    expect(capped.title.length).toBe(SIGNAL_FIELD_CAPS.title);
    expect(capped.body?.length).toBe(SIGNAL_FIELD_CAPS.body);
    expect(capped.link).toBeUndefined(); // unsafe internal URL dropped
    expect(capped.meta).toBeUndefined(); // oversized meta dropped
  });

  it("keeps a safe external link and small meta", () => {
    const capped = applySignalCaps({
      source: "sentry",
      externalId: "e1",
      groupingKey: "g1",
      title: "boom",
      severity: "critical",
      link: "https://sentry.io/issues/42",
      meta: { project: "web" },
    });
    expect(capped.link).toBe("https://sentry.io/issues/42");
    expect(capped.meta).toEqual({ project: "web" });
  });
});

export { sign };
