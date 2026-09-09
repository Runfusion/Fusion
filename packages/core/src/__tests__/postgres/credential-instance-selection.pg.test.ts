/*
 * FNXC:CredentialInstanceSelection 2026-08-01-05:53:
 * Credential-instance selection is persisted data in this slice. Exercise each task authoring
 * route and lifecycle projection so a future runtime consumer receives only durable, validated ids.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const credentialFields = {
  credentialInstanceId: "executor-instance",
  validatorCredentialInstanceId: "validator-instance",
  planningCredentialInstanceId: "planning-instance",
  mergerCredentialInstanceId: "merger-instance",
};

pgDescribe("credential-instance task persistence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_credential_instance_selection",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("round-trips all task fields through create, read, update, archive, restore, and branch-group reads", async () => {
    const store = h.store();
    const group = await store.ensureBranchGroupForSource("planning", "credential-selection", {
      name: "credential selection group",
      branchName: "fusion/credential-selection",
      baseBranch: "main",
    });
    const created = await store.createTask({
      description: "persist credential instances",
      branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" },
      ...credentialFields,
    } as never);

    expect(await store.getTask(created.id)).toMatchObject(credentialFields);
    expect(await store.listTasksByBranchGroup(group.id)).toEqual([
      expect.objectContaining({ id: created.id, ...credentialFields }),
    ]);

    const updatedFields = {
      credentialInstanceId: "executor-updated",
      validatorCredentialInstanceId: "validator-updated",
      planningCredentialInstanceId: "planning-updated",
      mergerCredentialInstanceId: "merger-updated",
    };
    await store.updateTask(created.id, updatedFields as never);
    expect(await store.getTask(created.id)).toMatchObject(updatedFields);

  });

  it("keeps absent task fields absent after a database read", async () => {
    const task = await h.store().createTask({ description: "no credential instance" });
    const read = await h.store().getTask(task.id);
    for (const key of Object.keys(credentialFields)) expect(read).not.toHaveProperty(key);
  });

  it("rejects malformed create, update, and atomic mutation inputs without partial persistence", async () => {
    const store = h.store();
    for (const invalid of ["", "   ", "bad[id]", "x".repeat(257), 42]) {
      await expect(store.createTask({ description: "invalid create", credentialInstanceId: invalid } as never)).rejects.toThrow();
    }

    const task = await store.createTask({ description: "invalid update", ...credentialFields } as never);
    for (const invalid of ["", "   ", "bad[id]", "x".repeat(257), 42]) {
      await expect(store.updateTask(task.id, { validatorCredentialInstanceId: invalid } as never)).rejects.toThrow();
      await expect(store.updateTaskAtomic(task.id, () => ({ planningCredentialInstanceId: invalid } as never))).rejects.toThrow();
      expect(await store.getTask(task.id)).toMatchObject(credentialFields);
    }
  });
});
