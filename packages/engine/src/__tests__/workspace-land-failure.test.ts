/*
 * FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-23:05 (RUFU-451):
 * `landFailure` is a display-only breadcrumb, and RUFU-451's source-free card is the shape that proves why the
 * clear needs its own seam: three merge-lane failure sites plus the partial-land sweep write it, and a card that
 * then closed on an ABSENCE proof kept reporting each repository as broken forever — a closed card still red in
 * the per-repository status surface. These cases pin the two properties that make the clear safe: it goes through
 * the advisory-locked per-entry merge (never a reconstructed map), and it is a no-op where no entry exists, so
 * clearing a breadcrumb can never manufacture the acquisition record it did not have.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { clearWorkspaceRepoLandFailure, persistWorkspaceRepoLandFailure } from "../merge/workspace-land-failure.js";

type MergeCall = { taskId: string; repoRel: string; patch: Record<string, unknown>; options?: { requireExistingEntry?: boolean } };

function storeWithEntry(entry: Record<string, unknown> | undefined) {
  const calls: MergeCall[] = [];
  const task = { id: "RUFU-451", workspaceWorktrees: entry ? { "lager-manager": entry } : {} } as Task;
  const store = {
    getTask: vi.fn(async () => task),
    mergeWorkspaceWorktreeEntry: vi.fn(async (taskId: string, repoRel: string, patch: Record<string, unknown>, options?: { requireExistingEntry?: boolean }) => {
      // Resolve a function patch the way the store would, so the assertion sees the resolved object.
      const resolved = typeof patch === "function" ? await patch(task) : patch;
      calls.push({ taskId, repoRel, patch: resolved, options });
      return task;
    }),
  } as unknown as TaskStore;
  return { store, calls };
}

describe("workspace per-repository land-failure breadcrumb", () => {
  it("clears the breadcrumb through the per-entry merge, keyed to the one repository", async () => {
    const { store, calls } = storeWithEntry({ branch: "fusion/rufu-451", landFailure: { step: "land", message: "boom", category: "internal-technical" } });

    await clearWorkspaceRepoLandFailure(store, "RUFU-451", "lager-manager");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      taskId: "RUFU-451",
      repoRel: "lager-manager",
      options: { requireExistingEntry: true },
    });
    // `undefined` is the removal: the store's jsonb write drops the key, so a reader never has to tell
    // "cleared" apart from "failed with no details".
    expect(calls[0].patch).toEqual({ landFailure: undefined });
    expect("landFailure" in calls[0].patch).toBe(true);
  });

  it("never writes an entry the card does not have", async () => {
    const { store } = storeWithEntry(undefined);
    // A repository the card never acquired has no entry; `requireExistingEntry` makes the store's own merge a
    // no-op instead of creating acquisition evidence to hold a deletion.
    await clearWorkspaceRepoLandFailure(store, "RUFU-451", "saneca");
    const [, , patch, options] = (store.mergeWorkspaceWorktreeEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options).toEqual({ requireExistingEntry: true });
    expect(patch).toEqual({ landFailure: undefined });
  });

  it("keeps writing failures with an explicit category, so the clear is the only removal", async () => {
    const { store, calls } = storeWithEntry({ branch: "fusion/rufu-451" });
    await persistWorkspaceRepoLandFailure(store, "RUFU-451", "lager-manager", { step: "land", message: "no branch" });
    expect(calls[0].patch).toEqual({ landFailure: { step: "land", message: "no branch", category: "internal-technical" } });
  });
});
