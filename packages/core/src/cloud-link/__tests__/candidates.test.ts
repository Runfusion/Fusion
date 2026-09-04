import { describe, expect, it } from "vitest";
import {
  buildHeartbeatCandidates,
  candidateFromUrl,
  classifyCandidateUrl,
  tunnelUrlChanged,
} from "../candidates.js";

describe("classifyCandidateUrl", () => {
  it("labels Cloudflare quick and named tunnel hosts", () => {
    expect(classifyCandidateUrl("https://abc.trycloudflare.com")).toBe("cloudflare");
    expect(classifyCandidateUrl("https://xyz.cfargotunnel.com")).toBe("cloudflare");
  });

  it("labels tailscale, public https, and lan", () => {
    expect(classifyCandidateUrl("https://box.tailnet.ts.net")).toBe("tailscale");
    expect(classifyCandidateUrl("http://100.64.0.1:4040")).toBe("tailscale");
    expect(classifyCandidateUrl("http://100.127.255.254:4040")).toBe("tailscale");
    expect(classifyCandidateUrl("http://100.63.255.255:4040")).toBe("lan");
    expect(classifyCandidateUrl("http://100.128.0.1:4040")).toBe("lan");
    expect(classifyCandidateUrl("https://edge.example")).toBe("public");
    expect(classifyCandidateUrl("http://192.168.1.9:4040")).toBe("lan");
  });
});

describe("candidateFromUrl", () => {
  it("sets an expiry on Cloudflare quick-tunnel URLs", () => {
    const c = candidateFromUrl("https://abc.trycloudflare.com/path", Date.parse("2026-08-22T00:00:00Z"));
    expect(c.kind).toBe("cloudflare");
    expect(c.url).toBe("https://abc.trycloudflare.com");
    expect(c.tls).toBe(true);
    expect(c.expiresAt).toBeDefined();
  });
});

describe("buildHeartbeatCandidates", () => {
  it("leads with the live tunnel URL and de-dupes", () => {
    const list = buildHeartbeatCandidates({
      tunnelUrl: "https://abc.trycloudflare.com",
      extraUrl: "https://abc.trycloudflare.com/",
      lanPort: 4040,
    });
    expect(list[0]?.kind).toBe("cloudflare");
    expect(list.filter((c) => c.kind === "cloudflare")).toHaveLength(1);
  });
});

describe("tunnelUrlChanged", () => {
  it("detects trycloudflare host rotation", () => {
    expect(tunnelUrlChanged(null, "https://a.trycloudflare.com")).toBe(true);
    expect(
      tunnelUrlChanged("https://a.trycloudflare.com", "https://b.trycloudflare.com"),
    ).toBe(true);
    expect(
      tunnelUrlChanged("https://a.trycloudflare.com/", "https://a.trycloudflare.com"),
    ).toBe(false);
  });
});
