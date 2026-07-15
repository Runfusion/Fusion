/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Integration test proving CliPressStore works in backend mode (PostgreSQL via
 * AsyncDataLayer/Drizzle). Exercises every async method against real
 * PostgreSQL, including cascade deletes and the boolean `executable` column.
 * Auto-skipped via `pgDescribe` when PG is unreachable.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { AsyncDataLayer } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../../packages/core/src/__test-utils__/pg-test-harness.ts";
import { createCliPressStore } from "../store/cli-press-store.ts";
import { encodeCredentialValue } from "../store/credentials.ts";

function projectLayer(layer: AsyncDataLayer, projectId = "cli-press-project-a"): AsyncDataLayer {
  return { ...layer, projectId };
}

pgDescribe("CliPressStore (PostgreSQL / backend mode)", () => {
  it("materializes all five cli_press_* tables via the schema-init hook", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_clipress_schema" });
    try {
      const rows = (await h.adminDb.execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'project'
          AND table_name IN (
            'cli_press_services',
            'cli_press_cli_specs',
            'cli_press_artifacts',
            'cli_press_credentials',
            'cli_press_service_settings'
          )
        ORDER BY table_name
      `)) as unknown as Array<{ table_name: string }>;
      const names = rows.map((r) => r.table_name);
      expect(names).toEqual([
        "cli_press_artifacts",
        "cli_press_cli_specs",
        "cli_press_credentials",
        "cli_press_service_settings",
        "cli_press_services",
      ]);
    } finally {
      await h.teardown();
    }
  });

  it("createService + getService + listServices round-trip", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_clipress_svc" });
    try {
      const store = createCliPressStore(null, projectLayer(h.layer));
      const created = await store.createService({
        slug: "acme",
        displayName: "Acme Service",
        description: "Acme CLI",
        baseUrl: "https://acme.example.com",
        sourceKind: "manual",
        sourceRef: undefined,
      });
      expect(created.id).toMatch(/^svc_/);
      expect(created.slug).toBe("acme");

      const fetched = await store.getService(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.displayName).toBe("Acme Service");
      expect(fetched!.sourceKind).toBe("manual");

      const listed = await store.listServices();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(created.id);
    } finally {
      await h.teardown();
    }
  });

  it("isolates service definitions and credentials between two bound projects", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_clipress_isolation" });
    try {
      const projectA = createCliPressStore(null, projectLayer(h.layer, "cli-press-project-a"));
      const projectB = createCliPressStore(null, projectLayer(h.layer, "cli-press-project-b"));
      const serviceA = await projectA.createService({ slug: "shared", displayName: "A", baseUrl: "https://a.example", sourceKind: "manual" });
      const serviceB = await projectB.createService({ slug: "shared", displayName: "B", baseUrl: "https://b.example", sourceKind: "manual" });
      await projectA.createCredential({
        serviceId: serviceA.id,
        name: "token",
        kind: "env_var",
        placement: { kind: "env_var", envVar: "TOKEN" },
        value: encodeCredentialValue("project-a-secret"),
      });

      expect((await projectA.listServices()).map((service) => service.id)).toEqual([serviceA.id]);
      expect((await projectB.listServices()).map((service) => service.id)).toEqual([serviceB.id]);
      expect(await projectB.listCredentials(serviceA.id)).toEqual([]);
      await expect(projectB.createCredential({
        serviceId: serviceA.id,
        name: "stolen",
        kind: "env_var",
        placement: { kind: "env_var", envVar: "STOLEN" },
        value: encodeCredentialValue("nope"),
      })).rejects.toThrow();
    } finally {
      await h.teardown();
    }
  });

  it("updateService mutates only the allowed fields", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_clipress_svc_upd" });
    try {
      const store = createCliPressStore(null, projectLayer(h.layer));
      const created = await store.createService({
        slug: "beta",
        displayName: "Beta",
        description: undefined,
        baseUrl: "https://beta.example.com",
        sourceKind: "manual",
      });
      const updated = await store.updateService(created.id, {
        displayName: "Beta Renamed",
        description: "Now with a description",
        baseUrl: "https://beta-v2.example.com",
      });
      expect(updated.displayName).toBe("Beta Renamed");
      expect(updated.slug).toBe("beta"); // slug is immutable
      expect(updated.baseUrl).toBe("https://beta-v2.example.com");

      const refetched = await store.getService(created.id);
      expect(refetched!.description).toBe("Now with a description");
    } finally {
      await h.teardown();
    }
  });

  it("spec, artifact, and setting CRUD round-trip with boolean executable", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_clipress_spec" });
    try {
      const store = createCliPressStore(null, projectLayer(h.layer));
      const service = await store.createService({
        slug: "gamma",
        displayName: "Gamma",
        description: undefined,
        baseUrl: "https://gamma.example.com",
        sourceKind: "manual",
      });

      const spec = await store.createSpec({
        serviceId: service.id,
        name: "gamma-cli",
        version: "1.0.0",
        generatorVersion: "cli-printing-press",
        specJson: JSON.stringify({ id: service.id }),
        status: "draft",
        generatedAt: undefined,
        lastGenerationError: undefined,
      });
      expect(spec.id).toMatch(/^cli_/);

      const artifact = await store.createArtifact({
        cliSpecId: spec.id,
        kind: "script",
        path: "plugins/cli-printing-press/artifacts/gamma/bin",
        executable: true,
        checksum: undefined,
        sizeBytes: undefined,
      });
      expect(artifact.executable).toBe(true); // native PG boolean round-trips

      const fetchedArtifact = (await store.listArtifacts(spec.id))[0];
      expect(fetchedArtifact.executable).toBe(true);
      expect(fetchedArtifact.kind).toBe("script");

      await store.setSetting({
        serviceId: service.id,
        key: "endpoints",
        value: JSON.stringify([{ id: "ep1" }]),
        scope: "wizard",
      });
      const settings = await store.listSettings(service.id);
      expect(settings).toHaveLength(1);
      expect(settings[0].key).toBe("endpoints");

      // Re-setting the same (serviceId, key, scope) upserts rather than dupes.
      await store.setSetting({
        serviceId: service.id,
        key: "endpoints",
        value: JSON.stringify([{ id: "ep2" }]),
        scope: "wizard",
      });
      const settingsAfterUpsert = await store.listSettings(service.id);
      expect(settingsAfterUpsert).toHaveLength(1);
    } finally {
      await h.teardown();
    }
  });

  it("credential value/placement JSON round-trips and rejects oauth", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_clipress_cred" });
    try {
      const store = createCliPressStore(null, projectLayer(h.layer));
      const service = await store.createService({
        slug: "delta",
        displayName: "Delta",
        description: undefined,
        baseUrl: "https://delta.example.com",
        sourceKind: "manual",
      });

      const cred = await store.createCredential({
        serviceId: service.id,
        name: "token",
        kind: "env_var",
        placement: { kind: "env_var", envVar: "DELTA_TOKEN" },
        value: encodeCredentialValue("delta-secret"),
      });
      expect(cred.id).toMatch(/^cred_/);

      const fetched = (await store.listCredentials(service.id))[0];
      expect(fetched.kind).toBe("env_var");
      expect(fetched.placement).toEqual({ kind: "env_var", envVar: "DELTA_TOKEN" });
      expect(fetched.value.encoding).toBe("base64");

      // oauth kinds are rejected at create time.
      await expect(
        store.createCredential({
          serviceId: service.id,
          name: "oauth-cred",
          kind: "oauth2",
          placement: { kind: "header", header: "Authorization" },
          value: encodeCredentialValue("ignored"),
        }),
      ).rejects.toThrow();

      // updating keeps the immutable kind and applies the new value.
      const updated = await store.updateCredential(cred.id, {
        name: "token-renamed",
        value: encodeCredentialValue("rotated-secret"),
      });
      expect(updated.name).toBe("token-renamed");
      expect(updated.kind).toBe("env_var");
    } finally {
      await h.teardown();
    }
  });

  it("deleteService cascades to child specs, artifacts, credentials, and settings", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_clipress_cascade" });
    try {
      const store = createCliPressStore(null, projectLayer(h.layer));
      const service = await store.createService({
        slug: "epsilon",
        displayName: "Epsilon",
        description: undefined,
        baseUrl: "https://epsilon.example.com",
        sourceKind: "manual",
      });
      const spec = await store.createSpec({
        serviceId: service.id,
        name: "epsilon-cli",
        version: "1.0.0",
        generatorVersion: "cli-printing-press",
        specJson: "{}",
        status: "draft",
        generatedAt: undefined,
        lastGenerationError: undefined,
      });
      await store.createArtifact({
        cliSpecId: spec.id,
        kind: "script",
        path: "epsilon/bin",
        executable: false,
        checksum: undefined,
        sizeBytes: undefined,
      });
      await store.createCredential({
        serviceId: service.id,
        name: "tok",
        kind: "header",
        placement: { kind: "header", header: "X-Epsilon" },
        value: encodeCredentialValue("secret"),
      });
      await store.setSetting({
        serviceId: service.id,
        key: "region",
        value: "us-east-1",
        scope: "runtime",
      });

      await store.deleteService(service.id);

      // Children must be gone (FK ON DELETE CASCADE).
      expect(await store.listSpecs(service.id)).toHaveLength(0);
      expect(await store.listArtifacts(spec.id)).toHaveLength(0);
      expect(await store.listCredentials(service.id)).toHaveLength(0);
      expect(await store.listSettings(service.id)).toHaveLength(0);
      expect(await store.getService(service.id)).toBeUndefined();
    } finally {
      await h.teardown();
    }
  });

  it("updateSpec and deleteSpec operate on the spec row", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_clipress_spec_mut" });
    try {
      const store = createCliPressStore(null, projectLayer(h.layer));
      const service = await store.createService({
        slug: "zeta",
        displayName: "Zeta",
        description: undefined,
        baseUrl: "https://zeta.example.com",
        sourceKind: "manual",
      });
      const spec = await store.createSpec({
        serviceId: service.id,
        name: "zeta-cli",
        version: "1.0.0",
        generatorVersion: "cli-printing-press",
        specJson: "{}",
        status: "draft",
        generatedAt: undefined,
        lastGenerationError: undefined,
      });
      const updated = await store.updateSpec(spec.id, { status: "generated", generatedAt: "2026-07-04T00:00:00.000Z" });
      expect(updated.status).toBe("generated");
      expect(updated.generatedAt).toBe("2026-07-04T00:00:00.000Z");

      await store.deleteSpec(spec.id);
      expect(await store.getSpec(spec.id)).toBeUndefined();
    } finally {
      await h.teardown();
    }
  });
});
