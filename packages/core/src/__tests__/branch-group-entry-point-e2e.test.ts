import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskStore } from "../store.js";
import { isBranchGroupComplete } from "../branch-group-completion.js";

/**
 * U8 (R9): entry-point half of the end-to-end single managed-PR flow.
 *
 * Composition choice (stated honestly): a single test that drives planning →
 * engine → GitHub across the dashboard↔engine↔core package boundaries is
 * impractical. So the flow is composed:
 *   - This core test proves the ENTRY-POINT contract with REAL core objects
 *     (TaskStore + MissionStore) and a real temp-dir SQLite store: mission triage
 *     stamps the real `BG-` group id into `branchContext.groupId`, members never
 *     take the shared branch as their own working branch, and
 *     `listTasksByBranchGroup(group.id)` enumerates exactly those members — which
 *     is what completion gating and PR rollup depend on.
 *   - The engine half (land on shared branch → ONE PR → sync/idempotency/abandon
 *     → safe self-heal routing) is proven with real git + real merger/coordinator
 *     in `packages/engine/src/__tests__/reliability-interactions/branch-group-single-pr-e2e.test.ts`,
 *     using a group created the same way (same sourceType/branchName shape).
 *   - The planning route entry point's group + branchContext shape is proven by
 *     the route-level planning tests; this file covers the mission entry point at
 *     the core level (where mission triage lives).
 *
 * No network and no GitHub: PR creation is the engine-side concern; here we only
 * assert the membership identity the PR flow consumes.
 *
 * ## Surface Enumeration
 * Surfaces this regression spec asserts the membership-identity invariant across:
 * - Providers / execution paths: mission triage entry point (MissionStore →
 *   TaskStore) stamping the real `BG-` group id into `branchContext.groupId`;
 *   `listTasksByBranchGroup(group.id)` membership enumeration consumed by
 *   completion gating and PR rollup. The dashboard planning-route entry point is
 *   covered by the route-level planning tests; the engine land→PR→sync→abandon
 *   half is covered by branch-group-single-pr-e2e.test.ts.
 * - Data states: members that have/have not landed (drives
 *   `isBranchGroupComplete`), and the empty-group case before triage.
 * - Shared modules/helpers reusing the logic: `branchContext.groupId`
 *   propagation, `filterTasksByBranchGroup` semantics behind
 *   `listTasksByBranchGroup`, and per-task working-branch derivation (members
 *   never adopt the shared branch as their own working branch).
 * - Breakpoints/platforms: N/A — this is a core/persistence invariant with no UI.
 */

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fusion-bg-entry-e2e-"));
}

describe("U8 entry-point E2E: mission triage → shared group membership identity", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"));
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("creates a shared group with a real BG- id and enumerates triaged members by group.id", async () => {
    const missionStore = store.getMissionStore();
    const mission = missionStore.createMission({
      title: "Launch billing",
      description: "Mission entry-point e2e",
      baseBranch: "main",
    });
    const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
    const slice = missionStore.addSlice(milestone.id, { title: "S1" });
    const featureA = missionStore.addFeature(slice.id, { title: "Billing backend", description: "backend" });
    const featureB = missionStore.addFeature(slice.id, { title: "Billing UI", description: "ui" });

    // Triage both features in shared mode (the default mission branch strategy) —
    // the same entry point the dashboard/mission flow uses.
    await missionStore.triageFeature(featureA.id, undefined, undefined, { branch: "fusion/groups/billing", assignmentMode: "shared" });
    await missionStore.triageFeature(featureB.id, undefined, undefined, { branch: "fusion/groups/billing", assignmentMode: "shared" });

    // A real BranchGroup row exists for this mission with a BG- id (not synthetic).
    const group = store.getBranchGroupBySource("mission", mission.id);
    expect(group).not.toBeNull();
    expect(group!.id.startsWith("BG-")).toBe(true);
    expect(group!.branchName).toBe("fusion/groups/billing");

    // Both triaged tasks carry the REAL group id in branchContext (U1), not the
    // legacy synthetic `mission:<id>` form.
    const linkedA = missionStore.getFeature(featureA.id)!.taskId!;
    const linkedB = missionStore.getFeature(featureB.id)!.taskId!;
    const taskA = (await store.getTask(linkedA))!;
    const taskB = (await store.getTask(linkedB))!;
    expect(taskA.branchContext?.groupId).toBe(group!.id);
    expect(taskB.branchContext?.groupId).toBe(group!.id);
    expect(taskA.branchContext?.groupId).not.toBe(`mission:${mission.id}`);
    expect(taskA.branchContext?.source).toBe("mission");
    expect(taskA.branchContext?.assignmentMode).toBe("shared");

    // No member uses the shared branch as its own working branch (per-task working
    // branches are derived from the shared branch base).
    expect(taskA.branch).not.toBe(group!.branchName);
    expect(taskB.branch).not.toBe(group!.branchName);
    expect(taskA.branch).not.toBe(taskB.branch);

    // Enumeration by the real group id returns exactly the triaged members — the
    // query completion gating and PR rollup depend on.
    const members = await store.listTasksByBranchGroup(group!.id);
    expect(members.map((m) => m.id).sort()).toEqual([linkedA, linkedB].sort());

    // Before either lands, the group is not complete (canonical predicate).
    expect(isBranchGroupComplete(members, group!)).toBe(false);

    // Simulate both members landing on the group branch (mergeConfirmed + matching
    // target) — the canonical completion gate then reports complete.
    for (const id of [linkedA, linkedB]) {
      await store.updateTask(id, {
        column: "done",
        mergeDetails: {
          mergeConfirmed: true,
          mergeTargetSource: "branch-group-integration",
          mergeTargetBranch: group!.branchName,
        },
      } as never);
    }
    // Read members fresh via getTask: listTasksByBranchGroup's slim-list path has
    // a short startup memo (2.5s) that can return a pre-landing snapshot within
    // the same fast test; enumeration identity is already asserted above, so here
    // we evaluate the canonical completion gate against the authoritative rows.
    const landedMembers = await Promise.all([linkedA, linkedB].map((id) => store.getTask(id)));
    expect(isBranchGroupComplete(landedMembers.filter(Boolean) as never[], group!)).toBe(true);
  });

  it("returns [] for a group with no members (empty group is not an error, not complete)", async () => {
    const group = store.createBranchGroup({ sourceType: "mission", sourceId: "M-empty", branchName: "fusion/groups/empty" });
    const members = await store.listTasksByBranchGroup(group.id);
    expect(members).toEqual([]);
    expect(isBranchGroupComplete(members, group)).toBe(false);
  });
});
