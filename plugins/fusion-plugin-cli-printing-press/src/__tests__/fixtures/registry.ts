import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@fusion/core";
import { createCliPressStore } from "../../store/cli-press-store.js";
import { encodeCredentialValue } from "../../store/credentials.js";

export async function makeFakeRegistry() {
  const rootDir = mkdtempSync(join(tmpdir(), "cli-printing-press-registry-"));
  const db = new Database(join(rootDir, ".fusion"), { inMemory: true });
  db.init();
  const store = createCliPressStore(db);

  const acme = await store.createService({
    slug: "acme",
    displayName: "Acme Service",
    description: "Acme CLI",
    baseUrl: "https://acme.example.com",
    sourceKind: "manual",
  });
  const acmeSpec = await store.createSpec({
    serviceId: acme.id,
    name: "acme-cli",
    version: "1.0.0",
    generatorVersion: "cli-printing-press",
    specJson: JSON.stringify({ id: acme.id, slug: acme.slug }),
    status: "generated",
    generatedAt: new Date().toISOString(),
    lastGenerationError: undefined,
  });
  const acmePath = `plugins/cli-printing-press/artifacts/${acme.id}/${acmeSpec.id}/acme`;
  const acmeAbsPath = join(rootDir, ".fusion", acmePath);
  mkdirSync(join(acmeAbsPath, ".."), { recursive: true });
  writeFileSync(acmeAbsPath, "#!/bin/sh\necho acme\n");
  await store.createArtifact({ cliSpecId: acmeSpec.id, kind: "script", path: acmePath, executable: true });
  await store.createCredential({
    serviceId: acme.id,
    name: "token",
    kind: "env_var",
    placement: { kind: "env_var", envVar: "ACME_TOKEN" },
    value: encodeCredentialValue("acme-secret"),
  });

  const beta = await store.createService({
    slug: "beta",
    displayName: "Beta Service",
    description: "Beta CLI",
    baseUrl: "https://beta.example.com",
    sourceKind: "manual",
  });
  const betaSpec = await store.createSpec({
    serviceId: beta.id,
    name: "beta-cli",
    version: "1.0.0",
    generatorVersion: "cli-printing-press",
    specJson: JSON.stringify({ id: beta.id, slug: beta.slug, unbuilt: true }),
    status: "draft",
    generatedAt: undefined,
    lastGenerationError: undefined,
  });
  await store.createCredential({
    serviceId: beta.id,
    name: "header-token",
    kind: "header",
    placement: { kind: "header", header: "X-Beta-Token" },
    value: encodeCredentialValue("beta-secret"),
  });

  const cleanup = () => {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  };

  return {
    rootDir,
    db,
    store,
    services: { acme, beta },
    specs: { acme: acmeSpec, beta: betaSpec },
    cleanup,
  };
}
