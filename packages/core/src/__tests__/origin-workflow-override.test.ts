// @vitest-environment node
//
// FNXC:OriginWorkflowSelection 2026-07-26-19:40:
// Pins the resolver behind the project `taskCreateWorkflowId` / `refinementTaskWorkflowId`
// settings — the workflow chosen for the two task origins that have NO workflow picker in
// front of the operator: `fn task create` (CLI + the `fn_task_create` agent tool) and
// refinement tasks.
//
// The invariant under test is the full precedence ladder and its fallbacks, not one
// reported case:
//   pinned per-origin setting -> mirrored Board lane -> undefined (inherit today's default)
// plus the tolerance rules that keep a stale settings value from breaking task creation.
//
// `undefined` is load-bearing, not "nothing happened": every caller's no-override branch is
// its existing `materializeDefaultWorkflowSteps()` path, so returning `undefined` is how an
// unconfigured project keeps byte-identical pre-setting behavior.

import { describe, it, expect } from "vitest";
import {
  resolveOriginWorkflowOverrideIdImpl,
  type TaskOriginWorkflowKind,
} from "../task-store/task-store-helpers.js";
import type { TaskStore } from "../store.js";

interface FakeStoreOptions {
  settings?: Record<string, unknown>;
  /** Workflow ids that resolve, mapped to their kind. Anything else resolves to undefined. */
  workflows?: Record<string, "workflow" | "fragment">;
  settingsThrows?: boolean;
  lookupThrows?: boolean;
}

function makeStore(options: FakeStoreOptions = {}): TaskStore {
  const { settings = {}, workflows = {}, settingsThrows = false, lookupThrows = false } = options;
  return {
    async getSettingsFast() {
      if (settingsThrows) throw new Error("settings unavailable");
      return settings;
    },
    async getWorkflowDefinition(id: string) {
      if (lookupThrows) throw new Error("workflow lookup failed");
      const kind = workflows[id];
      return kind ? ({ id, kind } as unknown as Awaited<ReturnType<TaskStore["getWorkflowDefinition"]>>) : undefined;
    },
  } as unknown as TaskStore;
}

const ORIGINS: TaskOriginWorkflowKind[] = ["task-create", "refinement"];
const PINNED_KEY: Record<TaskOriginWorkflowKind, string> = {
  "task-create": "taskCreateWorkflowId",
  refinement: "refinementTaskWorkflowId",
};

describe("resolveOriginWorkflowOverrideId", () => {
  // Surface enumeration: BOTH origins must obey every rule, so each shared rule runs
  // against both rather than against whichever one a report happened to mention.
  for (const origin of ORIGINS) {
    describe(`origin: ${origin}`, () => {
      it("returns undefined when nothing is configured, so the caller keeps its default-workflow path", async () => {
        const store = makeStore({ settings: {} });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBeUndefined();
      });

      it("returns the pinned workflow for this origin", async () => {
        const store = makeStore({
          settings: { [PINNED_KEY[origin]]: "WF-007" },
          workflows: { "WF-007": "workflow" },
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBe("WF-007");
      });

      it('falls back to the mirrored Board lane — the "Selected workflow" option — when unpinned', async () => {
        const store = makeStore({
          settings: { boardSelectedWorkflowId: "WF-lane" },
          workflows: { "WF-lane": "workflow" },
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBe("WF-lane");
      });

      it("prefers the pinned workflow over the mirrored Board lane", async () => {
        const store = makeStore({
          settings: { [PINNED_KEY[origin]]: "WF-pinned", boardSelectedWorkflowId: "WF-lane" },
          workflows: { "WF-pinned": "workflow", "WF-lane": "workflow" },
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBe("WF-pinned");
      });

      // Blank/whitespace is the persisted shape of "Selected workflow" (the select's empty
      // option), so it must read as unpinned rather than as an id — otherwise the lane
      // fallback would be unreachable for anyone who ever picked and un-picked a workflow.
      it.each(["", "   "])("treats a blank pinned value (%j) as unpinned and falls through to the lane", async (blank) => {
        const store = makeStore({
          settings: { [PINNED_KEY[origin]]: blank, boardSelectedWorkflowId: "WF-lane" },
          workflows: { "WF-lane": "workflow" },
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBe("WF-lane");
      });

      it("trims a padded id rather than failing to resolve it", async () => {
        const store = makeStore({
          settings: { [PINNED_KEY[origin]]: "  WF-007  " },
          workflows: { "WF-007": "workflow" },
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBe("WF-007");
      });

      // Tolerance surfaces: a stale settings value must degrade to "inherit", never throw —
      // task creation is not allowed to be breakable by a misconfigured or since-deleted id.
      it("degrades a deleted/unknown workflow id to inherit", async () => {
        const store = makeStore({
          settings: { [PINNED_KEY[origin]]: "WF-gone" },
          workflows: {},
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBeUndefined();
      });

      it("degrades a fragment id to inherit (a fragment is never independently selectable)", async () => {
        const store = makeStore({
          settings: { [PINNED_KEY[origin]]: "WF-frag" },
          workflows: { "WF-frag": "fragment" },
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBeUndefined();
      });

      it("degrades a mirrored lane pointing at a deleted workflow to inherit", async () => {
        const store = makeStore({
          settings: { boardSelectedWorkflowId: "WF-gone" },
          workflows: {},
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBeUndefined();
      });

      it("degrades to inherit when settings cannot be read", async () => {
        const store = makeStore({ settingsThrows: true });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBeUndefined();
      });

      it("degrades to inherit when the workflow lookup throws", async () => {
        const store = makeStore({
          settings: { [PINNED_KEY[origin]]: "WF-007" },
          lookupThrows: true,
        });
        await expect(resolveOriginWorkflowOverrideIdImpl(store, origin)).resolves.toBeUndefined();
      });
    });
  }

  // The two settings are independent knobs; pinning one must not leak into the other.
  // A single shared field would silently couple CLI creation to refinement routing.
  it("keeps the two origins independent", async () => {
    const store = makeStore({
      settings: { taskCreateWorkflowId: "WF-create", refinementTaskWorkflowId: "WF-refine" },
      workflows: { "WF-create": "workflow", "WF-refine": "workflow" },
    });
    await expect(resolveOriginWorkflowOverrideIdImpl(store, "task-create")).resolves.toBe("WF-create");
    await expect(resolveOriginWorkflowOverrideIdImpl(store, "refinement")).resolves.toBe("WF-refine");
  });

  it("lets one origin be pinned while the other still follows the Board lane", async () => {
    const store = makeStore({
      settings: { taskCreateWorkflowId: "WF-create", boardSelectedWorkflowId: "WF-lane" },
      workflows: { "WF-create": "workflow", "WF-lane": "workflow" },
    });
    await expect(resolveOriginWorkflowOverrideIdImpl(store, "task-create")).resolves.toBe("WF-create");
    await expect(resolveOriginWorkflowOverrideIdImpl(store, "refinement")).resolves.toBe("WF-lane");
  });
});
