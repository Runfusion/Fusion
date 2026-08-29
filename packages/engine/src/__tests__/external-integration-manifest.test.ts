import { describe, expect, it } from "vitest";
import { validateExternalIntegrationManifest } from "../external-integrations/manifest.js";

describe("validateExternalIntegrationManifest", () => {
  it("accepts a valid upstream-verified manifest", () => {
    const result = validateExternalIntegrationManifest({
      id: "worktrunk",
      binaryName: "wt",
      upstreamRepo: "max-sixty/worktrunk",
      docsUrl: "https://worktrunk.dev/",
      source: "upstream-verified",
      version: "0.4.2",
      verifiedAt: "2026-05-20T00:00:00.000Z",
      assets: {
        "linux-x64": {
          url: "https://github.com/max-sixty/worktrunk/releases/download/v0.4.2/wt-linux-x64.tar.gz",
          sha256: "a".repeat(64),
        },
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects pending manifests with non-empty assets", () => {
    const result = validateExternalIntegrationManifest({
      id: "worktrunk",
      binaryName: "wt",
      upstreamRepo: "max-sixty/worktrunk",
      docsUrl: "https://worktrunk.dev/",
      source: "upstream-pending-verification",
      version: null,
      verifiedAt: null,
      assets: { linux: { url: "https://github.com/max-sixty/worktrunk/releases/download/v0.4.2/x", sha256: "a".repeat(64) } },
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected validation failure");
    expect(result.missingFields).toContain("assets:must-be-empty-when-pending");
  });

  it("rejects upstream-verified manifests with empty sha256", () => {
    const result = validateExternalIntegrationManifest({
      id: "worktrunk",
      binaryName: "wt",
      upstreamRepo: "max-sixty/worktrunk",
      docsUrl: "https://worktrunk.dev/",
      source: "upstream-verified",
      version: "0.4.2",
      verifiedAt: "2026-05-20T00:00:00.000Z",
      assets: {
        linux: {
          url: "https://github.com/max-sixty/worktrunk/releases/download/v0.4.2/wt-linux-x64.tar.gz",
          sha256: "",
        },
      },
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected validation failure");
    expect(result.missingFields).toContain("assets.linux.sha256");
  });

  it("rejects malformed upstreamRepo values", () => {
    const result = validateExternalIntegrationManifest({
      id: "cloudflared",
      binaryName: "cloudflared",
      upstreamRepo: "cloudflared",
      docsUrl: "https://developers.cloudflare.com/",
      source: "upstream-pending-verification",
      version: null,
      verifiedAt: null,
      assets: {},
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected validation failure");
    expect(result.missingFields).toContain("upstreamRepo");
  });

  it("rejects asset URLs outside upstream repo and docs host", () => {
    const result = validateExternalIntegrationManifest({
      id: "worktrunk",
      binaryName: "wt",
      upstreamRepo: "max-sixty/worktrunk",
      docsUrl: "https://worktrunk.dev/",
      source: "upstream-verified",
      version: "0.4.2",
      verifiedAt: "2026-05-20T00:00:00.000Z",
      assets: {
        linux: {
          url: "https://example.com/download/wt-linux-x64.tar.gz",
          sha256: "a".repeat(64),
        },
      },
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected validation failure");
    expect(result.missingFields).toContain("assets.linux.url");
  });

  it("rejects missing required identifiers", () => {
    const result = validateExternalIntegrationManifest({
      source: "upstream-pending-verification",
      version: null,
      verifiedAt: null,
      assets: {},
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected validation failure");
    expect(result.missingFields).toEqual(expect.arrayContaining(["id", "binaryName", "docsUrl"]));
  });

  it.each([null, undefined, 42, "bad", true])("never throws for garbage input: %p", (input) => {
    expect(() => validateExternalIntegrationManifest(input)).not.toThrow();
    const result = validateExternalIntegrationManifest(input);
    expect(result.ok).toBe(false);
  });
});
