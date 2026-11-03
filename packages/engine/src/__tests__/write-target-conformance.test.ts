/**
 * RUFU-281 acceptance sweep — no coordinator write tool reports success for a target it did not write.
 *
 * FNXC:CrossCardWriteAuth 2026-09-23-22:56:
 * Every write tool in the sweep is called with `task_id` naming a foreign card, and each case must satisfy
 * one of two shapes: it REFUSED (isError + a write-target code, and its store write did not run), or it
 * HONOURED (its store write names the requested card). "Reported success, wrote the bound card" — the exact
 * RUFU-275 incident — is neither, and fails the sweep. The list is the full write-tool inventory, so a new
 * write tool added without a disposition shows up here as missing coverage rather than as a silent dropper.
 */
import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

const { loadWorkspaceConfig, promoteHeldTask } = vi.hoisted(() => ({
  loadWorkspaceConfig: vi.fn(),
  promoteHeldTask: vi.fn(),
}));
import {
  createChatArtifactTools,
  createTaskDocumentWriteTool,
  createTaskLogTool,
  createTaskLogToolWithContext,
  createTaskPromoteTool,
  createTaskPromptWriteTool,
  createTaskUpdateTool,
  createWorkflowSelectTool,
} from "../agent-tools.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), { loadWorkspaceConfig });
});

vi.mock("../execution/hold-release.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execution/hold-release.js")>();
  return { ...actual, promoteHeldTask };
});

const BOUND = "RUFU-269";
const OTHER = "RUFU-275";

function storeFake(overrides: Record<string, unknown> = {}) {
  return {
    logEntry: vi.fn(async () => {}),
    upsertTaskDocument: vi.fn(async () => ({ id: "d", taskId: BOUND, key: "k", content: "", revision: 1, contentHash: `sha256:${"a".repeat(64)}`, author: "agent", createdAt: "", updatedAt: "" })),
    updateTask: vi.fn(async (id: string) => ({ id })),
    updateStep: vi.fn(async (id: string) => ({ id })),
    selectTaskWorkflowAndReconcile: vi.fn(async (id: string) => ({ id, enabledWorkflowSteps: [], reconciliation: { rehomedFrom: null } })),
    getTaskWorkflowSelection: vi.fn(async () => undefined),
    registerArtifact: vi.fn(async (input: Record<string, unknown>) => ({ id: "ART-1", ...input })),
    ...overrides,
  } as unknown as TaskStore & Record<string, ReturnType<typeof vi.fn>>;
}

type Sweep = {
  /** What the sweep is checking, in the tool's own words. */
  label: string;
  build: (store: TaskStore) => { execute?: (...args: any[]) => any };
  params: Record<string, unknown>;
  /** Store mock that performs the real write, so "honoured" is provable. */
  write: (store: ReturnType<typeof storeFake>) => ReturnType<typeof vi.fn>;
  /**
   * Which card a recorded write named. Defaults to the first argument, the shape most store writers use;
   * a writer that carries the target elsewhere (a nested input object, a later argument) names it here so
   * the sweep asks the same question of every tool.
   */
  targetOf?: (call: unknown[]) => unknown;
  /** Expected disposition for this tool. */
  disposition: "honours" | "refuses";
};

const sweep: Sweep[] = [
  {
    label: "fn_task_log",
    build: (store) => createTaskLogTool(store, BOUND),
    params: { message: "m" },
    write: (store) => store.logEntry,
    disposition: "honours",
  },
  {
    label: "fn_task_log (run-context lane)",
    build: (store) => createTaskLogToolWithContext(store, BOUND, { runId: "run-1", nodeId: null }),
    params: { message: "m" },
    write: (store) => store.logEntry,
    disposition: "honours",
  },
  {
    label: "fn_task_document_write",
    build: (store) => createTaskDocumentWriteTool(store, BOUND),
    params: { key: "notes", content: "c" },
    write: (store) => store.upsertTaskDocument,
    disposition: "honours",
  },
  {
    label: "fn_task_prompt_write",
    build: (store) => createTaskPromptWriteTool(store, BOUND),
    params: { content: "# spec" },
    write: (store) => store.updateTask,
    disposition: "refuses",
  },
  {
    label: "fn_task_update (board lane)",
    build: (store) => createTaskUpdateTool(store, BOUND),
    params: { step: 0, status: "done", summary: "s" },
    write: (store) => store.updateStep,
    disposition: "refuses",
  },
  {
    label: "fn_workflow_select",
    build: (store) => createWorkflowSelectTool(store, BOUND),
    params: { workflow_id: "builtin:coding" },
    write: (store) => store.selectTaskWorkflowAndReconcile,
    disposition: "honours",
  },
  {
    label: "fn_task_promote",
    build: (store) => createTaskPromoteTool(store, BOUND),
    params: {},
    write: () => promoteHeldTask as ReturnType<typeof vi.fn>,
    targetOf: (call) => call[1],
    disposition: "honours",
  },
  {
    label: "fn_artifact_register (chat lane)",
    build: (store) => chatArtifactRegisterTool(store),
    params: { type: "document", title: "t", content: "body", mimeType: "text/markdown" },
    write: (store) => store.registerArtifact,
    targetOf: (call) => (call[0] as { taskId?: string })?.taskId,
    disposition: "honours",
  },
];

/** The chat lane has no ambient card, so its artifact tool requires the target in its schema. */
function chatArtifactRegisterTool(store: TaskStore) {
  const tool = createChatArtifactTools(store).find((entry) => entry.name === "fn_artifact_register");
  if (!tool) throw new Error("chat lane no longer registers fn_artifact_register");
  return tool;
}

describe("write-target conformance sweep", () => {
  for (const entry of sweep) {
    it(`${entry.label} ${entry.disposition === "refuses" ? "refuses" : "writes"} the foreign target, never the bound card silently`, async () => {
      const store = storeFake();
      if (entry.label === "fn_task_promote") {
        promoteHeldTask.mockResolvedValueOnce({ released: true, toColumn: "todo" });
      }
      const result = await entry.build(store).execute!("call", { ...entry.params, task_id: OTHER });
      const targetOf = entry.targetOf ?? ((call: unknown[]) => call[0]);
      const writes = entry.write(store).mock.calls.map((call) => targetOf(call));

      if (entry.disposition === "refuses") {
        expect(result.isError, `${entry.label} must refuse a foreign target`).toBe(true);
        expect(result.details).toMatchObject({ writeTarget: "refused", requestedTaskId: OTHER });
        expect(writes, `${entry.label} wrote after refusing`).not.toContain(OTHER);
        expect(writes, `${entry.label} wrote the bound card after refusing`).not.toContain(BOUND);
      } else {
        expect(result.isError, `${entry.label} unexpectedly errored on a valid cross-card target`).toBeFalsy();
        expect(writes, `${entry.label} never wrote the target it named`).toContain(OTHER);
        expect(writes, `${entry.label} also wrote the bound card`).not.toContain(BOUND);
      }
    });
  }

  it("the artifact lane writes the card named in its required task_id", async () => {
    const store = storeFake();
    const result = await chatArtifactRegisterTool(store).execute!("call", { type: "document", title: "t", content: "body", mimeType: "text/markdown", task_id: OTHER });
    expect(result.isError).toBeFalsy();
    expect(store.registerArtifact.mock.calls[0]![0]).toMatchObject({ taskId: OTHER });
  });

  /*
  FNXC:CrossCardWriteAuth 2026-09-24-00:45:
  The COMPLIANT set is pinned on BOTH branches. RUFU-281 did not change these tools' behavior, so the risk a
  future edit introduces is a widened default — a card that silently releases or re-pipelines the session's own
  card when the caller meant a named sibling. Each case below omits `task_id` and asserts the write still names
  the bound card only. (The artifact-register default branch is pinned in `agent-artifact-tools.test.ts`
  → "…with inferred mimeType and default task", and its explicit-override branch in "prefers an explicit taskId
  over the defaultTaskId"; the HONOURS default branch is pinned in `agent-tools-write-target.test.ts`.)
  */
  const defaultTargetSweep = [
    {
      label: "fn_task_promote",
      build: (store: TaskStore) => createTaskPromoteTool(store, BOUND),
      params: {},
      write: (store: ReturnType<typeof storeFake>) => promoteHeldTask as ReturnType<typeof vi.fn>,
      targetOf: (call: unknown[]) => call[1],
    },
    {
      label: "fn_workflow_select",
      build: (store: TaskStore) => createWorkflowSelectTool(store, BOUND),
      params: { workflow_id: "builtin:coding" },
      write: (store: ReturnType<typeof storeFake>) => store.selectTaskWorkflowAndReconcile,
    },
  ];

  for (const entry of defaultTargetSweep) {
    it(`${entry.label} with no named target still resolves to the bound card only`, async () => {
      const store = storeFake();
      if (entry.label === "fn_task_promote") {
        // promoteHeldTask is a module-level mock shared with the explicit-target sweep above; this case
        // must observe only its own call, so drop the recorded cross-card write first.
        promoteHeldTask.mockClear();
        promoteHeldTask.mockResolvedValueOnce({ released: true, toColumn: "todo" });
      }
      const targetOf = entry.targetOf ?? ((call: unknown[]) => call[0]);
      const result = await entry.build(store).execute!("call", { ...entry.params });
      const writes = entry.write(store).mock.calls.map((call) => targetOf(call));
      expect(result.isError).toBeFalsy();
      expect(writes, `${entry.label} stopped honouring its bound-card default`).toEqual([BOUND]);
      expect(writes, `${entry.label} reached a card nobody named`).not.toContain(OTHER);
    });
  }
});
