import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DASHBOARD_ROOT = join(__dirname, "../../../../../packages/dashboard/src/routes");

function readRouteFile(name: string): string {
  return readFileSync(join(DASHBOARD_ROOT, name), "utf8");
}

describe("reliability interactions: cross-node secrets sync route contracts", () => {
  it("pins outbound push/pull contracts and sync audit events", () => {
    const outbound = readRouteFile("register-secrets-sync-routes.ts");
    expect(outbound).toContain('router.post("/nodes/:id/secrets/push"');
    expect(outbound).toContain('res.status(400).json({ error: "passphrase-not-configured" })');
    expect(outbound).toContain('fetchFromRemoteNode(node, "/api/secrets/sync-receive"');
    expect(outbound).toContain('emitSecretsAudit(req, ctx, "secret:sync-push"');

    expect(outbound).toContain('router.post("/nodes/:id/secrets/pull"');
    expect(outbound).toContain('fetchFromRemoteNode(node, "/api/secrets/sync-export"');
    expect(outbound).toContain('records = await unwrapSecretsBundle(remoteEnvelope, passphrase)');
    expect(outbound).toContain('emitSecretsAudit(req, ctx, "secret:sync-pull"');
  });

  it("pins inbound receive failure-mode ordering", () => {
    const inbound = readRouteFile("register-secrets-sync-inbound-routes.ts");
    expect(inbound).toContain('router.post("/secrets/sync-receive"');
    expect(inbound).toContain('if (!authHeader || !authHeader.startsWith("Bearer "))');
    expect(inbound).toContain('if (body.version !== 1)');
    expect(inbound).toContain('res.status(400).json({ error: "version-mismatch" })');
    expect(inbound).toContain('records = await unwrapSecretsBundle(body, passphrase)');
    expect(inbound.indexOf('if (body.version !== 1)')).toBeLessThan(inbound.indexOf('records = await unwrapSecretsBundle(body, passphrase)'));
    expect(inbound).toContain('res.status(400).json({ error: "passphrase-not-configured" })');
  });

  it("pins inbound export auth + passphrase contract", () => {
    const inbound = readRouteFile("register-secrets-sync-inbound-routes.ts");
    expect(inbound).toContain('router.get("/secrets/sync-export"');
    expect(inbound).toContain('if (!authHeader || !authHeader.startsWith("Bearer "))');
    expect(inbound).toContain('if (passphrase === null)');
    expect(inbound).toContain('res.status(400).json({ error: "passphrase-not-configured" })');
    expect(inbound).toContain('const envelope = await wrapSecretsBundle(records, passphrase)');
  });
});
