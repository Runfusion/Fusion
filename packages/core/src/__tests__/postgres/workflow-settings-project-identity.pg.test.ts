/**
 * FNXC:CentralProjectIdentity 2026-07-13-22:40:
 * Regression coverage for the workflow-settings project-identity namespace bug.
 *
 * In backend (PostgreSQL) mode `store.db` is a SQLite stub whose
 * `getProjectIdentity()` throws, so the OLD `getWorkflowSettingsProjectId`
 * always fell through its catch to `store.rootDir` — an absolute filesystem
 * path. Every other backend-mode read/write partitions by the central-registry
 * project id (`asyncLayer.projectId`), so workflow settings landed under a
 * rootDir key nothing else could find (settings appeared "reset").
 *
 * These tests pin the invariant: when the async layer is BOUND to a central
 * project id, workflow settings + prompt overrides must be keyed by that id
 * (the `project_id` column), NOT by the rootDir path. An UNBOUND layer keeps
 * the legacy rootDir fallback.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import { getWorkflowSettingsProjectIdImpl } from "../../task-store/remaining-ops-6.js";
import { resolveEffectiveSettingsById } from "../../workflow-settings-resolver.js";
import type { TaskStore } from "../../store.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

/** Stand-in central-registry project id, matching the "proj_" shape used in prod. */
const BOUND_PROJECT_ID = "proj_wfsettings_identity_test";

pgTest("workflow-settings project identity keys by the central-registry id (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_wfsettings_identity",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /**
   * Build a project-bound clone of the shared harness layer. `createAsyncDataLayer`
   * returns an object literal whose transaction methods close over the shared
   * `db`, so spreading it and overriding `projectId` yields a layer that shares
   * the same PostgreSQL connection but reports a bound central id.
   */
  function boundLayer(): AsyncDataLayer {
    return { ...h.layer(), projectId: BOUND_PROJECT_ID };
  }

  async function boundStore(): Promise<TaskStore> {
    const { TaskStore: TaskStoreCtor } = await import("../../store.js");
    return new TaskStoreCtor(h.rootDir(), undefined, { asyncLayer: boundLayer() });
  }

  it("a projectId-BOUND backend store writes workflow_prompt_overrides under the central id, not rootDir", async () => {
    const store = await boundStore();
    const workflowId = "builtin:coding";

    const projectId = store.getWorkflowSettingsProjectId();
    expect(projectId).toBe(BOUND_PROJECT_ID);
    // Explicitly prove it is NOT the rootDir path the old code returned.
    expect(projectId).not.toBe(h.rootDir());

    await store.updateWorkflowPromptOverrides(workflowId, projectId, {
      "node-a": "override prose for node a",
    });

    const rows = (await h
      .adminDb()
      .execute(
        sql`SELECT project_id, workflow_id FROM project.workflow_prompt_overrides WHERE workflow_id = ${workflowId}`,
      )) as unknown as Array<{ project_id: string; workflow_id: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].project_id).toBe(BOUND_PROJECT_ID);
  });

  it("a projectId-BOUND backend store writes workflow_settings under the central id, not rootDir", async () => {
    const store = await boundStore();
    const workflowId = "builtin:coding";

    const projectId = store.getWorkflowSettingsProjectId();
    expect(projectId).toBe(BOUND_PROJECT_ID);

    // `workflowStepTimeoutMs` is a declared builtin workflow setting, so this
    // write passes declaration validation and persists a real row.
    await store.updateWorkflowSettingValues(workflowId, projectId, {
      workflowStepTimeoutMs: 600_000,
    });

    const rows = (await h
      .adminDb()
      .execute(
        sql`SELECT project_id FROM project.workflow_settings WHERE workflow_id = ${workflowId}`,
      )) as unknown as Array<{ project_id: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].project_id).toBe(BOUND_PROJECT_ID);
    expect(rows[0].project_id).not.toBe(h.rootDir());
  });

  it("preserves and resolves every workflow model lane across independent PostgreSQL patches", async () => {
    const store = await boundStore();
    const workflowId = "builtin:coding";

    /*
     * FNXC:WorkflowModelLanes 2026-07-14-16:26:
     * Migrated execution, planning, and validator model lanes (including their fallback lanes) must coexist in one workflow JSONB row. Saving a later lane must not erase an earlier lane, and runtime resolution must consume the PostgreSQL row rather than its synchronous empty fallback.
     */
    await store.updateWorkflowSettingValues(workflowId, BOUND_PROJECT_ID, {
      executionProvider: "openai-codex",
      executionModelId: "gpt-5.5",
    });
    await store.updateWorkflowSettingValues(workflowId, BOUND_PROJECT_ID, {
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-5",
      planningFallbackProvider: "openai-codex",
      planningFallbackModelId: "gpt-5.5",
    });
    await store.updateWorkflowSettingValues(workflowId, BOUND_PROJECT_ID, {
      validatorProvider: "xai",
      validatorModelId: "grok-code-fast-1",
      validatorFallbackProvider: "anthropic",
      validatorFallbackModelId: "claude-sonnet-5",
    });

    const expected = {
      executionProvider: "openai-codex",
      executionModelId: "gpt-5.5",
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-5",
      planningFallbackProvider: "openai-codex",
      planningFallbackModelId: "gpt-5.5",
      validatorProvider: "xai",
      validatorModelId: "grok-code-fast-1",
      validatorFallbackProvider: "anthropic",
      validatorFallbackModelId: "claude-sonnet-5",
    };
    expect(await store.getWorkflowSettingValuesAsync(workflowId, BOUND_PROJECT_ID)).toMatchObject(expected);
    expect(await resolveEffectiveSettingsById(store, workflowId, BOUND_PROJECT_ID)).toMatchObject(expected);
  });

  it("reads task workflow selections only from the bound project", async () => {
    const store = await boundStore();
    await h.adminDb().insert(schema.project.taskWorkflowSelection).values([
      {
        projectId: BOUND_PROJECT_ID,
        taskId: "FN-SHARED",
        workflowId: "builtin:brainstorming",
        stepIds: [],
        updatedAt: "2026-07-14T23:34:00.000Z",
      },
      {
        projectId: "proj_other",
        taskId: "FN-SHARED",
        workflowId: "builtin:coding",
        stepIds: [],
        updatedAt: "2026-07-14T23:34:00.000Z",
      },
    ]);

    expect(await store.getTaskWorkflowSelectionAsync("FN-SHARED")).toEqual({
      workflowId: "builtin:brainstorming",
      stepIds: [],
    });
  });

  it("an UNBOUND backend layer falls back to rootDir (legacy key), proving the bound path is what changed", () => {
    // The shared harness store uses an unbound layer (projectId undefined). The
    // SQLite stub throws in getProjectIdentity, so resolution falls to rootDir.
    const unboundStore = h.store();
    expect(unboundStore.asyncLayer?.projectId).toBeUndefined();
    expect(unboundStore.getWorkflowSettingsProjectId()).toBe(h.rootDir());
  });
});

/**
 * Focused unit coverage of the resolution order, independent of a live PG
 * connection. Runs unconditionally (not gated on PG availability).
 */
describe("getWorkflowSettingsProjectIdImpl resolution order (unit)", () => {
  it("prefers asyncLayer.projectId when the layer is bound", () => {
    const store = {
      asyncLayer: { projectId: "proj_central_id" },
      rootDir: "/tmp/root",
      db: {
        getProjectIdentity() {
          throw new Error("SQLite removed in backend mode");
        },
      },
    } as unknown as TaskStore;
    expect(getWorkflowSettingsProjectIdImpl(store)).toBe("proj_central_id");
  });

  it("falls back to the legacy SQLite identity id when no layer is bound", () => {
    const store = {
      asyncLayer: null,
      rootDir: "/tmp/root",
      db: {
        getProjectIdentity() {
          return { id: "legacy_identity_id" };
        },
      },
    } as unknown as TaskStore;
    expect(getWorkflowSettingsProjectIdImpl(store)).toBe("legacy_identity_id");
  });

  it("falls back to rootDir when the SQLite stub throws and no layer is bound (old backend behavior)", () => {
    const store = {
      asyncLayer: null,
      rootDir: "/tmp/root",
      db: {
        getProjectIdentity() {
          throw new Error("SQLite removed in backend mode");
        },
      },
    } as unknown as TaskStore;
    expect(getWorkflowSettingsProjectIdImpl(store)).toBe("/tmp/root");
  });

  it("an unbound layer object (projectId undefined) does not short-circuit the legacy path", () => {
    const store = {
      asyncLayer: { projectId: undefined },
      rootDir: "/tmp/root",
      db: {
        getProjectIdentity() {
          return { id: "legacy_identity_id" };
        },
      },
    } as unknown as TaskStore;
    expect(getWorkflowSettingsProjectIdImpl(store)).toBe("legacy_identity_id");
  });
});
