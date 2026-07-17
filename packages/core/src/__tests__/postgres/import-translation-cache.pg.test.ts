/*
FNXC:GitHubImportTranslate 2026-07-16-23:30:
Import translations are a durable project-owned cache, not a dashboard-session
optimization. These PostgreSQL regressions reopen a TaskStore against the same
database to prove cache rows survive the restart boundary and preserve the
project partition used by RLS.
*/

import { expect, it } from "vitest";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { TaskStore } from "../../store.js";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../__test-utils__/pg-test-harness.js";

const key = {
  provider: "github",
  repoKey: "owner/repo",
  issueNumber: 42,
  targetLocale: "en",
  sourceHash: "original-source-hash",
};

const value = {
  translatedTitle: "Translated title",
  translatedBody: "Translated body",
  detectedLocale: "es",
};

async function reopenStore(harness: PgTestHarness, projectId?: string): Promise<{ store: TaskStore; layer: AsyncDataLayer }> {
  const backend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: harness.testUrl,
    migrationUrl: harness.testUrl,
    migrationUrlOverridden: false,
  };
  const connections = await createConnectionSetFromUrl(backend, {
    poolMax: 1,
    connectTimeoutSeconds: 5,
    ...(projectId ? { projectId, bypassProjectIsolation: false } : {}),
  });
  const layer = createAsyncDataLayer(connections, projectId ? { projectId } : undefined);
  const store = new TaskStore(harness.rootDir, undefined, { asyncLayer: layer });
  await store.init();
  return { store, layer };
}

pgDescribe("import translation cache persistence (PostgreSQL)", () => {
  it("records then reads a translation from a fresh store against the same database", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_translation_cache" });
    let reopened: { store: TaskStore; layer: AsyncDataLayer } | null = null;
    try {
      await harness.store.recordImportTranslation(key, value, "2026-07-16T00:00:00.000Z");
      reopened = await reopenStore(harness);

      await expect(reopened.store.getImportTranslation(key)).resolves.toEqual({
        ...value,
        recordedAt: "2026-07-16T00:00:00.000Z",
      });
    } finally {
      await reopened?.store.close();
      await reopened?.layer.close();
      await harness.teardown();
    }
  });

  it("uses the same normalized legacy partition for blank compatibility stores", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_translation_legacy" });
    try {
      const blankLayer: AsyncDataLayer = { ...harness.layer, projectId: "" };
      const blankStore = new TaskStore(harness.rootDir, undefined, { asyncLayer: blankLayer });
      await blankStore.recordImportTranslation({ ...key, provider: "gitlab" }, value, "2026-07-16T00:00:00.000Z");

      await expect(blankStore.getImportTranslation({ ...key, provider: "gitlab" })).resolves.toMatchObject(value);
    } finally {
      await harness.teardown();
    }
  });

  it("prunes only closed rows in its own provider partition", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_translation_prune" });
    try {
      await harness.store.recordImportTranslation(key, value, "2026-07-16T00:00:00.000Z");
      await harness.store.recordImportTranslation({ ...key, provider: "gitlab" }, value, "2026-07-16T00:00:00.000Z");
      await harness.store.pruneImportTranslations("github", key.repoKey, [key.issueNumber]);

      await expect(harness.store.getImportTranslation(key)).resolves.toBeNull();
      await expect(harness.store.getImportTranslation({ ...key, provider: "gitlab" })).resolves.toMatchObject(value);
    } finally {
      await harness.teardown();
    }
  });

  it("keeps source hashes stable when an absent body is normalized to an empty string", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_translation_hash" });
    try {
      const emptyBodyKey = { ...key, issueNumber: 43, sourceHash: "title-and-empty-body" };
      await harness.store.recordImportTranslation(emptyBodyKey, value, "2026-07-16T00:00:00.000Z");

      await expect(harness.store.getImportTranslation(emptyBodyKey)).resolves.toMatchObject(value);
    } finally {
      await harness.teardown();
    }
  });
});
