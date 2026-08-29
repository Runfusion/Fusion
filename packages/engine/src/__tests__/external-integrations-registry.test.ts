import { describe, expect, it } from "vitest";
import {
  KNOWN_EXTERNAL_INTEGRATIONS,
  validateExternalIntegrationManifest,
} from "../external-integrations/index.js";

describe("KNOWN_EXTERNAL_INTEGRATIONS contract", () => {
  it("validates every registry entry", () => {
    for (const entry of KNOWN_EXTERNAL_INTEGRATIONS) {
      const result = validateExternalIntegrationManifest(entry);
      expect(result).toEqual({ ok: true });
      expect(entry.binaryName).toMatch(/^[a-z][a-z0-9-]{0,31}$/);

      for (const asset of Object.values(entry.assets)) {
        expect(asset.url).not.toMatch(/github\.com\/([^/]+)\/\1\//);
        expect(asset.sha256).not.toBe("");
        expect(asset.sha256).not.toBe("unverified");
      }

      if (entry.source === "upstream-verified") {
        for (const asset of Object.values(entry.assets)) {
          expect(asset.url.includes(entry.upstreamRepo)).toBe(true);
        }
      }
    }
  });

  it("pins worktrunk to canonical upstream metadata", () => {
    const worktrunk = KNOWN_EXTERNAL_INTEGRATIONS.find((entry) => entry.id === "worktrunk");
    expect(worktrunk).toBeDefined();
    expect(worktrunk?.binaryName).toBe("wt");
    expect(worktrunk?.upstreamRepo).toBe("max-sixty/worktrunk");
    expect(worktrunk?.source).toBe("upstream-pending-verification");
  });
});
