/**
 * RUFU-281 — per-tool proof of the cross-card write contract.
 *
 * FNXC:CrossCardWriteAuth 2026-09-23-22:56:
 * Every coordinator write tool must honour an explicit `task_id` or refuse it with a named reason and zero
 * bytes written; silently ignoring a supplied target is the defect (measured: `fn_task_log` with
 * `task_id:"RUFU-275"` reported success while writing the session-bound card). The pinned runtime forwards
 * undeclared arguments verbatim — `validateToolArguments` structured-clones the caller's object and
 * `Value.Convert` keeps unknown keys — so these tests hand `execute` the same shape the model actually
 * sends, declared target field or not. Each assertion is about bytes: which card a store write named, or
 * that no store call happened at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskStore } from "@fusion/core";

const { loadWorkspaceConfig } = vi.hoisted(() => ({ loadWorkspaceConfig: vi.fn() }));
import {
  createInstallWorktreeDependenciesTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskFileScopeAddTool,
  createTaskLogTool,
  createTaskLogToolWithContext,
  createTaskPromptWriteTool,
  createTaskUpdateTool,
} from "../agent-tools.js";
import { createTaskUpdateTool as createExecutorTaskUpdateTool } from "../executor/create-task-update-tool.js";
import { createTaskDoneTool } from "../executor/create-task-done-tool.js";
import { createReviewDisputeTool } from "../executor/create-review-dispute-tool.js";
import { createRunVerificationTool } from "../execution/run-verification-tool.js";
import { createReportBuildFailureTool } from "../merger.js";
import { deriveMergeDurableWriteCallSites } from "./_merge-durable-write-callsites.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), { loadWorkspaceConfig });
});

const BOUND = "RUFU-269";
const OTHER = "RUFU-275";

function storeFake(overrides: Record<string, unknown> = {}) {
  return {
    logEntry: vi.fn(async () => {}),
    upsertTaskDocument: vi.fn(async () => ({ id: "doc-1", taskId: BOUND, key: "plan", content: "c", revision: 1, contentHash: `sha256:${"a".repeat(64)}`, author: "agent", createdAt: "", updatedAt: "" })),
    getTaskDocuments: vi.fn(async () => []),
    getTask: vi.fn(async (id: string) => ({ id, prompt: "## File Scope\n- `a.ts`\n" })),
    updateTask: vi.fn(async (id: string) => ({ id })),
    updateTaskUnlocked: vi.fn(async (id: string) => ({ id })),
    updateStep: vi.fn(async (id: string) => ({ id })),
    updateTaskCustomFields: vi.fn(async () => ({ ok: true })),
    updateTaskAtomic: vi.fn(async () => ({})),
    isBackendMode: vi.fn(() => false),
    ...overrides,
  } as unknown as TaskStore & Record<string, ReturnType<typeof vi.fn>>;
}

async function run(tool: { execute?: (...args: any[]) => any }, params: unknown) {
  return tool.execute!("call-1", params as never);
}

function textOf(result: { content?: Array<{ text?: string }> }) {
  return (result?.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

describe("symptom: the RUFU-275 incident", () => {
  /*
  FNXC:CrossCardWriteAuth 2026-09-23-22:56:
  The reported failure, reproduced exactly: a session bound to one card called `fn_task_log` with
  `task_id:"RUFU-275"`, was reported success, and wrote the bound card's log — so the target card's history
  stayed empty while the agent believed it had written there. Both halves of the fix are asserted here: the
  named card receives the bytes, and the bound card receives none.
  */
  it("writes the card the call named and leaves the bound card's log untouched", async () => {
    const store = storeFake();
    const result = await run(createTaskLogTool(store, BOUND), { message: "incident note", task_id: OTHER });

    expect(result.isError).toBeFalsy();
    const writtenTargets = store.logEntry.mock.calls.map((call) => call[0]);
    expect(writtenTargets).toEqual([OTHER]);
    expect(writtenTargets).not.toContain(BOUND);
  });

  it("a refusing tool leaves every card's bytes untouched and says so", async () => {
    const store = storeFake();
    const result = await run(createTaskPromptWriteTool(store, BOUND), { content: "# Spec", task_id: OTHER });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`Nothing was written to ${OTHER}`);
    for (const key of ["logEntry", "updateTask", "updateTaskUnlocked", "upsertTaskDocument"] as const) {
      expect(store[key].mock.calls, `${key} must hold zero bytes after the refusal}`).toHaveLength(0);
    }
  });
});

describe("fn_task_log — honours an explicit target", () => {
  it("writes the named card", async () => {
    const store = storeFake();
    const result = await run(createTaskLogTool(store, BOUND), { message: "cross-card note", task_id: OTHER });
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith(OTHER, "cross-card note", undefined);
    expect(result.isError).toBeFalsy();
  });

  it("keeps writing the bound card when no target is named", async () => {
    const store = storeFake();
    await run(createTaskLogTool(store, BOUND), { message: "local note" });
    expect(store.logEntry).toHaveBeenCalledWith(BOUND, "local note", undefined);
  });

  it("refuses an id that cannot name a card and writes no log entry", async () => {
    const store = storeFake();
    const result = await run(createTaskLogTool(store, BOUND), { message: "x", task_id: `../${OTHER}` });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Nothing was written");
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("honours the target through the run-context variant too", async () => {
    const store = storeFake();
    const tool = createTaskLogToolWithContext(store, BOUND, { runId: "run-1", nodeId: null });
    await run(tool, { message: "ctx note", task_id: OTHER });
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(store.logEntry.mock.calls[0]![0]).toBe(OTHER);
  });
});

describe("fn_task_document_write / read — honour an explicit target", () => {
  it("writes and reads the named card", async () => {
    const store = storeFake();
    const write = await run(createTaskDocumentWriteTool(store, BOUND), { key: "notes", content: "hello", task_id: OTHER });
    expect(write.isError).toBeFalsy();
    expect(store.upsertTaskDocument.mock.calls[0]![0]).toBe(OTHER);

    await run(createTaskDocumentReadTool(store, BOUND), { task_id: OTHER });
    expect(store.getTaskDocuments.mock.calls[0]![0]).toBe(OTHER);
  });

  it("keeps the CAS preconditions on the honoured target", async () => {
    const store = storeFake();
    await run(createTaskDocumentWriteTool(store, BOUND), {
      key: "notes",
      content: "hello",
      task_id: OTHER,
      expected_revision: 4,
    });
    expect(store.upsertTaskDocument.mock.calls[0]![1]).toMatchObject({ expectedRevision: 4 });
  });

  it("refuses conflicting spellings without touching the store", async () => {
    const store = storeFake();
    const result = await run(createTaskDocumentWriteTool(store, BOUND), { key: "notes", content: "x", task_id: OTHER, id: "FN-1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("conflicting targets");
    expect(store.upsertTaskDocument).not.toHaveBeenCalled();
  });
});

describe("refusing tools write nothing for a foreign target", () => {
  const cases: Array<{ name: string; refusalTarget: string; build: (store: TaskStore) => { execute?: (...args: any[]) => any }; params: Record<string, unknown> }> = [
    {
      name: "fn_task_prompt_write",
      refusalTarget: "fn_task_prompt_write",
      build: (store) => createTaskPromptWriteTool(store, BOUND),
      params: { content: "# Replacement spec" },
    },
    {
      name: "fn_task_file_scope_add",
      refusalTarget: "fn_task_file_scope_add",
      build: (store) => createTaskFileScopeAddTool(store, BOUND),
      params: { files: ["packages/engine/src/x.ts"] },
    },
    {
      name: "fn_task_update (board lane)",
      refusalTarget: "fn_task_update",
      build: (store) => createTaskUpdateTool(store, BOUND),
      params: { step: 1, status: "done", summary: "did the thing" },
    },
    {
      name: "fn_install_worktree_dependencies",
      refusalTarget: "fn_install_worktree_dependencies",
      build: (store) => createInstallWorktreeDependenciesTool(store, BOUND, {
        rootDir: "/repo",
        runConfiguredCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
        getSettings: async () => ({}),
      }),
      params: { decision: "install", command: "pnpm install" },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} refuses a foreign task_id and performs no store call`, async () => {
      const store = storeFake();
      const result = await run(testCase.build(store), { ...testCase.params, task_id: OTHER });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(testCase.refusalTarget);
      expect(textOf(result)).toContain(`Nothing was written to ${OTHER}`);
      for (const key of ["logEntry", "upsertTaskDocument", "updateTask", "updateTaskUnlocked", "updateStep", "updateTaskCustomFields"]) {
        expect(store[key], `${key} must not run after a refused target`).not.toHaveBeenCalled();
      }
    });
  }

  it("still writes the bound card for the same calls with no target", async () => {
    const store = storeFake();
    await run(createTaskUpdateTool(store, BOUND), { step: 1, status: "done", summary: "did the thing" });
    expect(store.updateStep).toHaveBeenCalledTimes(1);
    expect(store.updateStep.mock.calls[0]![0]).toBe(BOUND);
  });

  it("names the bound card in the refusal so the caller can retry correctly", async () => {
    const store = storeFake();
    const result = await run(createTaskPromptWriteTool(store, BOUND), { content: "# Spec", task_id: OTHER });
    expect(textOf(result)).toContain(BOUND);
    expect(result.details).toMatchObject({ writeTarget: "refused", refusalCode: "cross-card-target", boundTaskId: BOUND, requestedTaskId: OTHER });
  });
});

describe("executor-lane write tools refuse a foreign target before any write", () => {
  it("fn_task_update (executor lane) leaves the step ledger untouched", async () => {
    const store = storeFake();
    const tool = createExecutorTaskUpdateTool(
      { store, resolveTaskCustomFieldDefs: async () => undefined, loopRecoveryState: new Map() },
      BOUND,
      new Map(),
      { current: null },
    );
    const result = await run(tool, { step: 1, status: "done", summary: "wrote another card's step", task_id: OTHER });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Nothing was written to OTHER".replace("OTHER", OTHER));
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("fn_task_done neither completes nor parks another card", async () => {
    const store = storeFake();
    const onDone = vi.fn();
    const tool = createTaskDoneTool(
      {
        store,
        getRunContextFor: () => undefined,
        workflowLifecycleMovesInFlight: new Set(),
        persistTokenUsage: async () => {},
        getTaskCompletionBlocker: async () => undefined,
        evaluateTaskVerdictProviders: async () => ({ ok: true }),
        verifyWorktreeInvariants: async () => ({ ok: true }),
      } as never,
      BOUND,
      "/repo",
      "# spec",
      new Map(),
      onDone,
    );
    const result = await run(tool, { outcome: "completed", summary: "done over there", task_id: OTHER });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(OTHER);
    expect(onDone).not.toHaveBeenCalled();
    for (const key of ["updateTask", "updateTaskUnlocked", "updateStep", "updateTaskAtomic", "logEntry"]) {
      expect(store[key], `${key} must not run after a refused target`).not.toHaveBeenCalled();
    }
  });

  it("fn_review_dispute does not annotate another card's review", async () => {
    const store = storeFake();
    const tool = createReviewDisputeTool({ store, getRunContextFor: () => undefined }, BOUND);
    const result = await run(tool, { findingId: "f-1", rationale: "not my card's finding", task_id: OTHER });
    expect(result.isError).toBe(true);
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });
});

describe("lane-local write tools refuse a foreign target", () => {
  let tempDir: string | undefined;
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("fn_run_verification refuses before executing the command", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "rufu281-verify-"));
    const marker = join(tempDir, "wrote-a-file");
    const tool = createRunVerificationTool({
      worktreePath: tempDir,
      rootDir: tempDir,
      taskId: BOUND,
      recordActivity: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await run(tool, { command: `touch ${marker}`, scope: "package", task_id: OTHER });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`Nothing was written to ${OTHER}`);
    expect(existsSync(marker)).toBe(false);
  });

  it("fn_run_verification still runs for the bound card", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "rufu281-verify-ok-"));
    const marker = join(tempDir, "ran");
    const tool = createRunVerificationTool({
      worktreePath: tempDir,
      rootDir: tempDir,
      taskId: BOUND,
      recordActivity: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const result = await run(tool, { command: `touch ${marker}`, scope: "package" });
    expect(result.details).toMatchObject({ success: true });
    expect(existsSync(marker)).toBe(true);
  });

  it("fn_report_build_failure refuses without flipping the merge verdict", async () => {
    const report = vi.fn();
    const tool = createReportBuildFailureTool(BOUND, report);

    const refused = await run(tool, { message: "build broke over there", task_id: OTHER });
    expect(refused.isError).toBe(true);
    expect(report).not.toHaveBeenCalled();

    const accepted = await run(tool, { message: "build broke here" });
    expect(accepted.isError).toBeFalsy();
    expect(report).toHaveBeenCalledWith("build broke here");
  });
});

/*
FNXC:CrossCardWriteAuth 2026-09-30-04:09:
The disposition inventory used to be a hand-kept table, so the mission's own promise — that a future
write tool skipping the resolver fails a test instead of shipping the defect — had no test behind it,
and `createTaskRetryTool` had already slipped through that gap. The inventory is now DERIVED: every
write-tool family the durable-write call-site scan attributes to the coordinator registry must be
classified here, and an entry naming a family that no longer writes is itself a failure.

The scan is the one `merge-orphan-durable-write-inventory-drift.test.ts` pins, deliberately: its own
rule says a hand-written writer list is a blind spot, so re-declining the writer surface by hand here
would reproduce the very defect class RUFU-281 is about.

`outOfScanClosure` marks the lanes the merge-reachability scan cannot see (the executor and
lane-local tool factories are not merge-reachable); each names the behavioural test that pins it
instead, so the whole write surface stays accounted for without pretending the scan covers it.
*/
type WriteTargetDisposition =
  | "honours"
  | "refuses"
  | "target-forced"
  | "declared-id-is-data"
  | "not-card-scoped"
  | "creates-new-card"
  | "read-surface";

interface WriteToolInventoryEntry {
  disposition: WriteTargetDisposition;
  reason: string;
}

const COORDINATOR_WRITE_MODULE = "packages/engine/src/agent-tools.ts";

/** Keyed by the tool-factory family the scan derives from `enclosingSymbolPath`. */
const COORDINATOR_WRITE_TOOL_DISPOSITIONS: Record<string, WriteToolInventoryEntry> = {
  createTaskLogTool: { disposition: "honours", reason: "session-bound default; resolveWriteTarget adopts the named card" },
  createTaskLogToolWithContext: { disposition: "honours", reason: "run-context variant of fn_task_log; same seam" },
  createTaskDocumentWriteTool: { disposition: "honours", reason: "CAS preconditions are re-anchored on the honoured target" },
  createTaskRetryTool: { disposition: "honours", reason: "declared `id` is validated by resolveWriteTarget, so a foreign target cannot move another card" },
  createTaskPromptWriteTool: { disposition: "refuses", reason: "guardBoundWriteTarget: the spec body belongs to the bound card only" },
  createTaskUpdateTool: { disposition: "refuses", reason: "step ledger is bound-card-only" },
  createTaskFileScopeAddTool: { disposition: "refuses", reason: "declared scope belongs to the executing card" },
  createInstallWorktreeDependenciesTool: { disposition: "refuses", reason: "planner lane re-anchors its note from its own jobId" },
  createTaskPauseTool: { disposition: "target-forced", reason: "required `id`, no ambient session default to silently ignore" },
  createTaskUnpauseTool: { disposition: "target-forced", reason: "required `id`, no ambient session default to silently ignore" },
  createTaskDeleteTool: { disposition: "target-forced", reason: "required `id` per the operator's cross-card authorization contract" },
  createTaskDuplicateTool: { disposition: "target-forced", reason: "required `id`; the copy is a new card, never the bound one" },
  createChatTaskDocumentTools: { disposition: "target-forced", reason: "chat lane declares task_id as required" },
  createTaskAddDepTool: { disposition: "declared-id-is-data", reason: "`task_id` names the card depended ON; the edited card stays the bound one" },
  createWorkflowSelectTool: { disposition: "honours", reason: "declared task_id wins, session card is the fallback" },
  createWorkflowCreateTool: { disposition: "not-card-scoped", reason: "writes workflow definitions, not a card" },
  createWorkflowUpdateTool: { disposition: "not-card-scoped", reason: "writes workflow definitions, not a card" },
  createWorkflowDeleteTool: { disposition: "not-card-scoped", reason: "writes workflow definitions, not a card" },
  createWorkflowSettingsTool: { disposition: "not-card-scoped", reason: "writes workflow-scoped setting values, not a card" },
  createHistoryReadTool: { disposition: "read-surface", reason: "listPatchnodeEntries is on the writer surface but mutates no card state" },
  createAgentTask: { disposition: "creates-new-card", reason: "mints a new card; there is no pre-existing target to override" },
  registerArtifactForAgent: { disposition: "honours", reason: "artifact lane writes the card named in its required task_id" },
};

/** Lanes the merge-reachability scan cannot see, so scan membership is not the proof for these. */
const OUT_OF_SCAN_CLOSURE_LANES: Record<string, string> = {
  "executor/create-task-update-tool.ts": "agent-tools-write-target.test.ts",
  "executor/create-task-done-tool.ts": "agent-tools-write-target.test.ts",
  "executor/create-review-dispute-tool.ts": "agent-tools-write-target.test.ts",
  "execution/run-verification-tool.ts": "agent-tools-write-target.test.ts",
  "merger.ts::createReportBuildFailureTool": "agent-tools-write-target.test.ts",
};

function derivedWriteToolFamilies(): Set<string> {
  const families = new Set<string>();
  for (const site of deriveMergeDurableWriteCallSites().callSites) {
    if (site.file !== COORDINATOR_WRITE_MODULE) continue;
    const family = site.enclosingSymbolPath.split(">")[0]?.split("::")[0] ?? "";
    if (!/^(create|register)[A-Z]/.test(family)) continue;
    families.add(family);
  }
  return families;
}

describe("coordinator write-tool inventory is derived, not hand-kept", () => {
  const families = derivedWriteToolFamilies();

  it("finds the write-tool families at all (a scan that sees none guards nothing)", () => {
    expect(families.size).toBeGreaterThan(10);
  });

  it("classifies every coordinator write tool the derived scan finds", () => {
    const unclassified = [...families]
      .filter((family) => !(family in COORDINATOR_WRITE_TOOL_DISPOSITIONS))
      .sort();
    expect(
      unclassified,
      "new card-writing tool in the coordinator registry with no declared write-target disposition: "
        + "RUFU-281 requires every one to honour a named target, refuse it by name, or state why neither applies",
    ).toEqual([]);
  });

  it("records no ghost disposition for a family that stopped writing", () => {
    const ghosts = Object.keys(COORDINATOR_WRITE_TOOL_DISPOSITIONS)
      .filter((family) => !families.has(family));
    expect(
      ghosts,
      "classified write tool no longer performs a durable card write: drop the entry, or it claims coverage that is gone",
    ).toEqual([]);
  });

  it("states a reason for every disposition so the audit can tell a carve-out from a bug", () => {
    const thin = Object.entries(COORDINATOR_WRITE_TOOL_DISPOSITIONS)
      .filter(([, entry]) => entry.reason.trim().length < 20)
      .map(([family]) => family);
    expect(thin).toEqual([]);
  });

  it("pins each out-of-closure lane with a test file that actually exists", () => {
    for (const [lane, testFile] of Object.entries(OUT_OF_SCAN_CLOSURE_LANES)) {
      const pinned = fileURLToPath(new URL(testFile, import.meta.url));
      expect(existsSync(pinned), `lane ${lane} claims coverage by ${testFile}`).toBe(true);
    }
  });
});
