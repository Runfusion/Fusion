import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildCloudLoginHandoffUrl,
  CloudLinkHttpError,
  cloudRedeemTicket,
  normalizeCloudControlPlaneUrl,
} from "../client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildCloudLoginHandoffUrl", () => {
  it("appends cloudTicket on /remote-login", () => {
    expect(buildCloudLoginHandoffUrl("https://eng.example:4040", "jti.sec")).toBe(
      "https://eng.example:4040/remote-login?cloudTicket=jti.sec",
    );
  });
});

describe("normalizeCloudControlPlaneUrl", () => {
  it("accepts https origins", () => {
    expect(normalizeCloudControlPlaneUrl("https://cloud.example/v1/")).toBe(
      "https://cloud.example",
    );
  });

  it("accepts loopback http for localhost, 127.0.0.1, and ::1", () => {
    expect(normalizeCloudControlPlaneUrl("http://localhost:3210")).toBe(
      "http://localhost:3210",
    );
    expect(normalizeCloudControlPlaneUrl("http://127.0.0.1:3210")).toBe(
      "http://127.0.0.1:3210",
    );
    expect(normalizeCloudControlPlaneUrl("http://[::1]:3210")).toBe(
      "http://[::1]:3210",
    );
  });

  it("rejects non-loopback http", () => {
    expect(() => normalizeCloudControlPlaneUrl("http://evil.example")).toThrow(CloudLinkHttpError);
  });
});

describe("cloudRedeemTicket", () => {
  it("POSTs ticket to /v1/tickets/redeem with an abort signal", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          engineId: "eng_1",
          userId: "user_1",
          localSessionToken: "sess",
          candidates: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await cloudRedeemTicket("https://cloud.example.convex.site", {
      ticket: "a.b",
      engineId: "eng_1",
    });
    expect(result.localSessionToken).toBe("sess");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.convex.site/v1/tickets/redeem",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
