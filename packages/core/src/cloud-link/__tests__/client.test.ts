import { describe, expect, it, vi, afterEach } from "vitest";
import { buildCloudLoginHandoffUrl, cloudRedeemTicket } from "../client.js";

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

describe("cloudRedeemTicket", () => {
  it("POSTs ticket to /v1/tickets/redeem", async () => {
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
      expect.objectContaining({ method: "POST" }),
    );
  });
});
