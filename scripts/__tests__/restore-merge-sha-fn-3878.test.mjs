import test from "node:test";
import assert from "node:assert/strict";

import { runRestoration } from "../restore-merge-sha-fn-3878.mjs";

function createStore(task) {
  const state = { ...task, mergeDetails: { ...(task.mergeDetails ?? {}) } };
  const calls = { updateTask: 0, logEntry: 0 };
  return {
    calls,
    state,
    async getTask(id) {
      assert.equal(id, state.id);
      return { ...state, mergeDetails: { ...state.mergeDetails } };
    },
    async updateTask(id, updates) {
      assert.equal(id, state.id);
      calls.updateTask += 1;
      state.mergeDetails = { ...updates.mergeDetails };
      return { ...state };
    },
    async logEntry(id, action, outcome) {
      assert.equal(id, state.id);
      assert.equal(action, "FN-3878 restore commitSha");
      assert.match(outcome, /→/);
      calls.logEntry += 1;
      return { ...state };
    },
  };
}

function createGit({ ancestor = true, owned = true } = {}) {
  return {
    isAncestorOfMain() {
      return ancestor;
    },
    getCommitSubject() {
      return owned ? "fix(FN-3794): canonical" : "fix: unrelated";
    },
    getCommitBody() {
      return owned ? "Body\n\nFusion-Task-Id: FN-3794" : "Body without trailer";
    },
    getCommitAuthorDateIso() {
      return "2026-05-09T00:50:47-07:00";
    },
    getShortstat() {
      return { filesChanged: 3, insertions: 20, deletions: 5 };
    },
  };
}

const restoration = [{ id: "FN-3794", canonicalSha: "7d20a348d82320bc57310169aaa2d3b3f0d5a946" }];

function baseTask() {
  return {
    id: "FN-3794",
    column: "done",
    mergeDetails: {
      commitSha: "oldoldoldoldoldoldoldoldoldoldoldoldoldoldold1",
      mergeConfirmed: true,
      branch: "ignored",
      resolutionStrategy: "ai",
      resolutionMethod: "ai",
      attemptsMade: 2,
      autoResolvedCount: 4,
    },
  };
}

test("FN-3878: dry-run by default — no DB writes", async () => {
  const store = createStore(baseTask());
  const result = await runRestoration({
    store,
    git: createGit(),
    restorations: restoration,
    dryRun: true,
  });

  assert.equal(result.hadValidationErrors, false);
  assert.equal(store.calls.updateTask, 0);
  assert.equal(store.calls.logEntry, 0);
  assert.equal(store.state.mergeDetails.commitSha, "oldoldoldoldoldoldoldoldoldoldoldoldoldoldold1");
  assert.equal(result.results[0].action, "updated");
  assert.equal(result.results[0].reason, "dry-run");
});

test("FN-3878: --apply rewrites commitSha and preserves mergeConfirmed + strategy metadata", async () => {
  const store = createStore(baseTask());
  await runRestoration({
    store,
    git: createGit(),
    restorations: restoration,
    dryRun: false,
  });

  assert.equal(store.calls.updateTask, 1);
  assert.equal(store.calls.logEntry, 1);
  assert.equal(store.state.mergeDetails.commitSha, restoration[0].canonicalSha);
  assert.equal(store.state.mergeDetails.mergeCommitMessage, "fix(FN-3794): canonical");
  assert.equal(store.state.mergeDetails.filesChanged, 3);
  assert.equal(store.state.mergeDetails.insertions, 20);
  assert.equal(store.state.mergeDetails.deletions, 5);
  assert.equal(store.state.mergeDetails.mergedAt, "2026-05-09T00:50:47-07:00");
  assert.equal(store.state.mergeDetails.mergeConfirmed, true);
  assert.equal(store.state.mergeDetails.resolutionStrategy, "ai");
  assert.equal(store.state.mergeDetails.resolutionMethod, "ai");
  assert.equal(store.state.mergeDetails.attemptsMade, 2);
  assert.equal(store.state.mergeDetails.autoResolvedCount, 4);
});

test("FN-3878: idempotent — re-running with --apply is a no-op", async () => {
  const store = createStore(baseTask());
  await runRestoration({ store, git: createGit(), restorations: restoration, dryRun: false });
  const second = await runRestoration({ store, git: createGit(), restorations: restoration, dryRun: false });

  assert.equal(store.calls.updateTask, 1);
  assert.equal(second.results[0].action, "already-canonical");
});

test("FN-3878: refuses to update if canonical SHA is unreachable or untrailered", async () => {
  const storeUnreachable = createStore(baseTask());
  const unreachable = await runRestoration({
    store: storeUnreachable,
    git: createGit({ ancestor: false }),
    restorations: restoration,
    dryRun: false,
  });
  assert.equal(unreachable.hadValidationErrors, true);
  assert.equal(storeUnreachable.calls.updateTask, 0);

  const storeUnowned = createStore(baseTask());
  const unowned = await runRestoration({
    store: storeUnowned,
    git: createGit({ owned: false }),
    restorations: restoration,
    dryRun: false,
  });
  assert.equal(unowned.hadValidationErrors, true);
  assert.equal(storeUnowned.calls.updateTask, 0);
});

test("FN-3878: refuses non-done or mergeConfirmed!==true tasks", async () => {
  const notDone = createStore({ ...baseTask(), column: "in-review" });
  const notDoneResult = await runRestoration({ store: notDone, git: createGit(), restorations: restoration, dryRun: false });
  assert.equal(notDone.calls.updateTask, 0);
  assert.equal(notDoneResult.results[0].reason, "task-not-done");

  const unconfirmed = createStore({ ...baseTask(), mergeDetails: { ...baseTask().mergeDetails, mergeConfirmed: false } });
  const unconfirmedResult = await runRestoration({ store: unconfirmed, git: createGit(), restorations: restoration, dryRun: false });
  assert.equal(unconfirmed.calls.updateTask, 0);
  assert.equal(unconfirmedResult.results[0].reason, "merge-not-confirmed");
});
