import { describe, expect, it } from "vitest";
import { makeFakeRegistry } from "./fixtures/registry.js";
import { InvalidCredentialPlacementError, OAuthNotSupportedError } from "../store/cli-press-types.js";

describe("cli press store config flow", () => {
  it("round-trips service/spec/settings CRUD", () => {
    const h = makeFakeRegistry();
    try {
      const created = h.store.createService({
        slug: "gamma",
        displayName: "Gamma Service",
        description: "gamma",
        baseUrl: "https://gamma.example.com",
        sourceKind: "manual",
      });
      expect(h.store.getService(created.id)?.slug).toBe("gamma");

      const spec = h.store.createSpec({
        serviceId: created.id,
        name: "gamma-cli",
        version: "1.0.0",
        generatorVersion: "cli-printing-press",
        specJson: JSON.stringify({ id: created.id, regeneratedAt: "before" }),
        status: "draft",
      });

      const updated = h.store.updateSpec(spec.id, {
        status: "generated",
        generatedAt: new Date().toISOString(),
        specJson: JSON.stringify({ id: created.id, regeneratedAt: "after", artifactPath: "/tmp/gamma" }),
      });
      expect(updated.status).toBe("generated");
      expect(JSON.parse(updated.specJson)).toMatchObject({ regeneratedAt: "after" });

      const setting = h.store.setSetting({
        serviceId: created.id,
        key: "runner.timeoutMs",
        value: "120000",
        scope: "wizard",
      });
      expect(h.store.listSettings(created.id).find((entry) => entry.id === setting.id)?.value).toBe("120000");

      h.store.deleteSpec(spec.id);
      expect(h.store.getSpec(spec.id)).toBeUndefined();
      h.store.deleteService(created.id);
      expect(h.store.getService(created.id)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("stores credential values encoded and does not expose raw secrets", () => {
    const h = makeFakeRegistry();
    try {
      const acme = h.services.acme;
      const credential = h.store.listCredentials(acme.id)[0];
      expect(credential.value).toMatchObject({ encoding: "base64" });
      expect(JSON.stringify(credential.value)).not.toContain("acme-secret");
    } finally {
      h.cleanup();
    }
  });

  it("rejects oauth credentials and mismatched placement", () => {
    const h = makeFakeRegistry();
    try {
      const serviceId = h.services.acme.id;
      expect(() =>
        h.store.createCredential({
          serviceId,
          name: "oauth",
          kind: "oauth",
          placement: { kind: "oauth", provider: "acme" } as never,
          value: { encoding: "base64", value: "abc" },
        } as never),
      ).toThrow(OAuthNotSupportedError);

      expect(() =>
        h.store.createCredential({
          serviceId,
          name: "bad-placement",
          kind: "header",
          placement: { kind: "query_param", queryParam: "token" } as never,
          value: { encoding: "base64", value: "abc" },
        } as never),
      ).toThrow(InvalidCredentialPlacementError);
    } finally {
      h.cleanup();
    }
  });
});
