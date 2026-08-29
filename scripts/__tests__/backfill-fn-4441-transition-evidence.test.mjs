import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
import { composeTransitionEvidence } from "../backfill-fn-4441-transition-evidence.mjs";

async function loadBackendFactory() {
  const moduleUrl = new globalThis.URL("../../packages/core/src/postgres/startup-factory.ts", import.meta.url).href;
  const mod = await tsImport(moduleUrl, import.meta.url);
  return mod.createTaskStoreForBackend;
}

test("composeTransitionEvidence includes required evidence fields", () => {
  const content = composeTransitionEvidence({
    mergeRetries: undefined,
    branchTip: {
      short: "f57f70165",
      full: "f57f70165ac154f1ca79e68510990bc61916660e",
    },
    mainSHAs: [
      {
        sha: "00c8739d5",
        title: "feat(FN-4441): complete Step 1 — add node_modules cache layer",
        ancestorStatus: 0,
        ancestorOutput: "ancestor",
      },
      {
        sha: "41070475b",
        title: "feat(FN-4441): complete Step 2 — verify cache-hit integrity",
        ancestorStatus: 0,
        ancestorOutput: "ancestor",
      },
    ],
    lastMergeError: "The previous cherry-pick is now empty",
    resolutionTaskId: "FN-4450",
    postState: {
      column: "done",
      branchDisposition: "deleted",
    },
  });

  assert.match(content, /f57f70165/);
  assert.match(content, /00c8739d5/);
  assert.match(content, /41070475b/);
  assert.match(content, /FN-4450/);
  assert.match(content, /mergeRetries:/i);
  assert.match(content, /last merge error:/i);
});

test("TaskStore upsertTaskDocument increments revision and round-trips latest content", async () => {
  const createTaskStoreForBackend = await loadBackendFactory();
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "fn-4441-transition-evidence-"));
  /* FNXC:PostgresOperationalScriptTests 2026-07-14-18:44: Script integration coverage must exercise the same authoritative PostgreSQL bootstrap as the backfill instead of constructing the removed in-memory SQLite store. */
  const boot = await createTaskStoreForBackend({
    rootDir: projectRoot,
    embeddedDataDir: path.join(projectRoot, ".embedded-pg"),
  });
  const store = boot.taskStore;

  try {
    await store.createTaskWithReservedId({ description: "seed" }, { taskId: "FN-4441" });

    const first = await store.upsertTaskDocument("FN-4441", {
      key: "transition-evidence",
      content: "first",
      author: "test",
    });
    const second = await store.upsertTaskDocument("FN-4441", {
      key: "transition-evidence",
      content: "second",
      author: "test",
    });

    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);

    const doc = await store.getTaskDocument("FN-4441", "transition-evidence");
    assert.equal(doc?.revision, 2);
    assert.equal(doc?.content, "second");
  } finally {
    await boot.shutdown();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
