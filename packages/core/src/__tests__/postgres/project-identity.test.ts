/**
 * FNXC:MigrateProjectIdentity 2026-06-26-10:00:
 * PostgreSQL integration tests for the backend-mode project-identity helpers.
 *
 * The sync readProjectIdentity/writeProjectIdentity operate on a local
 * `.fusion/fusion.db` SQLite stamp (the legacy/recovery path that binds a
 * directory to a projectId). These tests cover the async variants that read/
 * write the same `projectId`/`projectCreatedAt` keys from the PostgreSQL
 * `project.__meta` table via the AsyncDataLayer — the path the running backend
 * store uses so it never touches SQLite.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import {
  createTaskStoreForTest,
  PG_AVAILABLE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  readProjectIdentityAsync,
  writeProjectIdentityAsync,
  ProjectIdentityMismatchError,
} from "../../central/project-identity.js";

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

pgDescribe("project-identity async (PostgreSQL integration)", () => {
  let h: PgTestHarness | null = null;

  afterEach(async () => {
    if (h) {
      await h.teardown();
      h = null;
    }
  });

  it("returns null when no identity is stored", async () => {
    h = await createTaskStoreForTest({ prefix: "pid_async" });
    const identity = await readProjectIdentityAsync(h.layer);
    expect(identity).toBeNull();
  });

  it("writes and reads identity via PG __meta", async () => {
    h = await createTaskStoreForTest({ prefix: "pid_async" });
    const written = { id: "proj_0123456789abcdef", createdAt: "2026-01-01T00:00:00.000Z" };
    await writeProjectIdentityAsync(h.layer, written);
    const read = await readProjectIdentityAsync(h.layer);
    expect(read).toEqual(written);

    // Verify the rows landed in project.__meta (not SQLite).
    const rows = await h.adminDb
      .select()
      .from(schema.project.projectMeta);
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(["projectCreatedAt", "projectId"]);
  });

  it("overwrites the same id idempotently", async () => {
    h = await createTaskStoreForTest({ prefix: "pid_async" });
    const identity = { id: "proj_0123456789abcdef", createdAt: "2026-01-01T00:00:00.000Z" };
    await writeProjectIdentityAsync(h.layer, identity);
    // Re-write the same id — should not throw.
    await writeProjectIdentityAsync(h.layer, identity);
    const read = await readProjectIdentityAsync(h.layer);
    expect(read?.id).toBe(identity.id);
  });

  it("throws ProjectIdentityMismatchError on different id", async () => {
    h = await createTaskStoreForTest({ prefix: "pid_async" });
    await writeProjectIdentityAsync(h.layer, {
      id: "proj_0123456789abcdef",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      writeProjectIdentityAsync(h.layer, {
        id: "proj_fedcba9876543210",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(ProjectIdentityMismatchError);
  });

  it("rejects malformed id on write", async () => {
    h = await createTaskStoreForTest({ prefix: "pid_async" });
    await expect(
      writeProjectIdentityAsync(h.layer, { id: "bad", createdAt: "x" }),
    ).rejects.toThrow(TypeError);
  });

  it("returns null and logs for malformed stored id", async () => {
    h = await createTaskStoreForTest({ prefix: "pid_async" });
    await writeProjectIdentityAsync(h.layer, {
      id: "proj_0123456789abcdef",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Corrupt the stored projectId directly.
    await h.adminDb
      .update(schema.project.projectMeta)
      .set({ value: "bad" })
      .where(eq(schema.project.projectMeta.key, "projectId"));
    const warn = await import("vitest").then(({ vi }) =>
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    );
    try {
      const identity = await readProjectIdentityAsync(h.layer);
      expect(identity).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
