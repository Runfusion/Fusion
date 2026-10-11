import { describe, expect, it } from "vitest";
import { addSteeringCommentImpl, MAX_STEERING_COMMENTS } from "../task-store/task-artifacts-ops.js";

/*
FNXC:SteeringCommentRetention 2026-10-11-11:40:
The lifecycle planner-oversight seam wrote 7,840 of the 7,996 steering comments that existed on the
deployed board (one card carried 678), because it re-posts the same sentence every poll and only the
session-advisor path was deduped. `steering_comments` is shipped by every task list read, so that
array is a cost on every sweep of every in-process engine. These tests pin the two invariants: a
poll that re-raises the identical newest sentence writes nothing, and the array cannot grow past the
bound regardless of how many distinct entries arrive.
*/

interface FakeState { task: any }

function makeStore() {
  const state: FakeState = { task: { id: "RUFU-1", comments: [], steeringComments: [] } };
  const store: any = {
    isWatching: false,
    taskCache: new Map(),
    emitted: [] as string[],
    taskDir: () => "/tmp/steering-fake",
    readTaskJson: async () => structuredClone(state.task),
    atomicWriteTaskJson: async (_dir: string, task: any) => { state.task = structuredClone(task); },
    withTaskLock: async (_id: string, fn: () => Promise<any>) => fn(),
    emit: (event: string) => { store.emitted.push(event); },
    addComment: async (_id: string, text: string, author: string) => {
      state.task.comments.push({
        id: `c${state.task.comments.length + 1}`,
        text,
        author,
        createdAt: "2026-10-11T00:00:00.000Z",
      });
      return structuredClone(state.task);
    },
  };
  return { store, state };
}

describe("addSteeringCommentImpl retention", () => {
  it("writes nothing when the identical sentence is already the newest steering comment", async () => {
    const { store, state } = makeStore();
    await addSteeringCommentImpl(store, "RUFU-1", '[planner-oversight] Stage "executor" signal "stuck"', "agent");
    const commentsAfterFirst = state.task.comments.length;
    const steeringAfterFirst = state.task.steeringComments.length;

    const again = await addSteeringCommentImpl(store, "RUFU-1", '[planner-oversight] Stage "executor" signal "stuck"', "agent");

    expect(state.task.comments).toHaveLength(commentsAfterFirst);
    expect(state.task.steeringComments).toHaveLength(steeringAfterFirst);
    expect(again.steeringComments).toHaveLength(steeringAfterFirst);
  });

  it("still writes a genuinely different instruction", async () => {
    const { store, state } = makeStore();
    await addSteeringCommentImpl(store, "RUFU-1", "first guidance", "agent");
    await addSteeringCommentImpl(store, "RUFU-1", "second guidance", "agent");
    expect(state.task.steeringComments.map((c: any) => c.text)).toEqual(["first guidance", "second guidance"]);
    expect(state.task.comments).toHaveLength(2);
  });

  it("keeps only the newest entries once the bound is passed", async () => {
    const { store, state } = makeStore();
    for (let i = 0; i < MAX_STEERING_COMMENTS + 50; i++) {
      await addSteeringCommentImpl(store, "RUFU-1", `guidance ${i}`, "agent");
    }
    expect(state.task.steeringComments).toHaveLength(MAX_STEERING_COMMENTS);
    expect(state.task.steeringComments[state.task.steeringComments.length - 1].text)
      .toBe(`guidance ${MAX_STEERING_COMMENTS + 49}`);
    expect(state.task.steeringComments[0].text).toBe(`guidance 50`);
  });

  it("treats an identical entry that is not the newest as new information", async () => {
    const { store, state } = makeStore();
    await addSteeringCommentImpl(store, "RUFU-1", "alpha", "agent");
    await addSteeringCommentImpl(store, "RUFU-1", "beta", "agent");
    await addSteeringCommentImpl(store, "RUFU-1", "alpha", "agent");
    expect(state.task.steeringComments.map((c: any) => c.text)).toEqual(["alpha", "beta", "alpha"]);
  });
});
