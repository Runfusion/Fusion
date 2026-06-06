import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, resolveEffectiveSettingsById, BUILTIN_WORKFLOW_SETTINGS } from "@fusion/core";
import {
  createWorkflowCreateTool,
  createWorkflowUpdateTool,
  createWorkflowSettingsTool,
} from "../agent-tools.js";

/**
 * U7 — agent-tool parity for workflow settings. These exercise the REAL store
 * (not a vi.fn mock) so that declarations pass through `parseWorkflowIr` exactly
 * as editor saves do, and value writes hit the same write authority
 * (`updateWorkflowSettingValues`) with the same typed-rejection contract.
 */
function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

const callCtx = [undefined, undefined, {} as never] as const;

describe("agent workflow-settings parity (U7)", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir("kb-engine-wf-settings-");
    globalDir = makeTmpDir("kb-engine-wf-settings-global-");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  // ── Declaration parity: create with settings ────────────────────────────
  it("creates a workflow with settings declarations, validated and persisted identically to editor saves", async () => {
    const create = createWorkflowCreateTool(store);
    const ir = {
      version: "v2",
      name: "QA",
      columns: [{ id: "intake", name: "Intake", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "intake" },
        { id: "end", kind: "end", column: "intake" },
      ],
      edges: [{ from: "start", to: "end" }],
      settings: [
        {
          id: "reviewHandoffPolicy",
          name: "Review handoff",
          type: "enum",
          default: "disabled",
          options: [
            { value: "disabled", label: "Disabled" },
            { value: "always", label: "Always" },
          ],
        },
        { id: "workflowStepTimeoutMs", name: "Step timeout", type: "number", default: 60000 },
      ],
    };
    const result = await create.execute("c", { name: "QA", ir } as never, ...callCtx);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const workflowId = (result.details as { workflowId: string }).workflowId;
    expect(workflowId).toBeTruthy();

    // Round-trips through the store's parse/persist path with the settings intact.
    const def = await store.getWorkflowDefinition(workflowId);
    const persisted = def?.ir as { settings?: Array<{ id: string }> };
    expect(persisted.settings?.map((s) => s.id)).toEqual(["reviewHandoffPolicy", "workflowStepTimeoutMs"]);
  });

  it("rejects an invalid settings declaration with the WorkflowIr validation error surfaced through the tool result", async () => {
    const create = createWorkflowCreateTool(store);
    const ir = {
      version: "v2",
      name: "Bad",
      columns: [{ id: "intake", name: "Intake", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "intake" },
        { id: "end", kind: "end", column: "intake" },
      ],
      edges: [{ from: "start", to: "end" }],
      // enum without options is invalid (parseWorkflowIr -> WorkflowIrError).
      settings: [{ id: "mode", name: "Mode", type: "enum" }],
    };
    const result = await create.execute("c", { name: "Bad", ir } as never, ...callCtx);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/must declare non-empty options/);
  });

  // ── Two-path contract: builtin VALUE write ok; builtin DECLARATION edit rejected ──
  it("accepts a value write for (builtin:coding, project)", async () => {
    const settingsTool = createWorkflowSettingsTool(store);
    const result = await settingsTool.execute(
      "c",
      { action: "set", workflow_id: "builtin:coding", values: { workflowStepTimeoutMs: 600000 } } as never,
      ...callCtx,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const projectId = store.getWorkflowSettingsProjectId();
    expect(store.getWorkflowSettingValues("builtin:coding", projectId)).toMatchObject({
      workflowStepTimeoutMs: 600000,
    });
  });

  it("rejects a builtin DECLARATION edit with the distinct built-in error (the other half of the two-path contract)", async () => {
    const update = createWorkflowUpdateTool(store);
    const ir = {
      version: "v2",
      name: "Coding",
      columns: [{ id: "intake", name: "Intake", traits: [] }],
      nodes: [],
      edges: [],
      settings: [{ id: "workflowStepTimeoutMs", name: "Step timeout", type: "number", default: 1 }],
    };
    const result = await update.execute(
      "c",
      { workflow_id: "builtin:coding", ir } as never,
      ...callCtx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/Built-in workflows cannot be edited/);
  });

  // ── Typed rejection surfaced through the tool result ────────────────────
  it("surfaces an enum-violation value write as a typed rejection list, persisting nothing", async () => {
    const settingsTool = createWorkflowSettingsTool(store);
    const result = await settingsTool.execute(
      "c",
      { action: "set", workflow_id: "builtin:coding", values: { reviewHandoffPolicy: "nope" } } as never,
      ...callCtx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    const rejections = (result.details as { rejections?: Array<{ code: string; settingId: string }> }).rejections;
    expect(rejections).toEqual([
      expect.objectContaining({ code: "enum-violation", settingId: "reviewHandoffPolicy" }),
    ]);
    // Write boundary: nothing persisted.
    const projectId = store.getWorkflowSettingsProjectId();
    expect(store.getWorkflowSettingValues("builtin:coding", projectId)).not.toHaveProperty("reviewHandoffPolicy");
  });

  it("rejects an unknown-setting value write with the typed code", async () => {
    const settingsTool = createWorkflowSettingsTool(store);
    const result = await settingsTool.execute(
      "c",
      { action: "set", workflow_id: "builtin:coding", values: { totallyUnknown: 1 } } as never,
      ...callCtx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    const rejections = (result.details as { rejections?: Array<{ code: string }> }).rejections;
    expect(rejections?.[0]?.code).toBe("unknown-setting");
  });

  // ── Read path returns { stored, effective } matching resolveEffectiveSettingsById ──
  it("read returns stored + effective values matching resolveEffectiveSettingsById", async () => {
    const settingsTool = createWorkflowSettingsTool(store);
    const projectId = store.getWorkflowSettingsProjectId();

    // Seed one override.
    await settingsTool.execute(
      "c",
      { action: "set", workflow_id: "builtin:coding", values: { workflowStepTimeoutMs: 123456 } } as never,
      ...callCtx,
    );

    const result = await settingsTool.execute(
      "c",
      { action: "get", workflow_id: "builtin:coding" } as never,
      ...callCtx,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const details = result.details as { stored: Record<string, unknown>; effective: Record<string, unknown> };
    expect(details.stored).toMatchObject({ workflowStepTimeoutMs: 123456 });

    const expectedEffective = await resolveEffectiveSettingsById(store, "builtin:coding", projectId);
    expect(details.effective).toEqual(expectedEffective);
    // The override is reflected in the effective map; an untouched declaration
    // default still resolves from BUILTIN_WORKFLOW_SETTINGS.
    expect(details.effective.workflowStepTimeoutMs).toBe(123456);
    const handoffDefault = BUILTIN_WORKFLOW_SETTINGS.find((s) => s.id === "reviewHandoffPolicy")?.default;
    expect(details.effective.reviewHandoffPolicy).toBe(handoffDefault);
  });

  it("set with an empty values map is a tool error", async () => {
    const settingsTool = createWorkflowSettingsTool(store);
    const result = await settingsTool.execute(
      "c",
      { action: "set", workflow_id: "builtin:coding", values: {} } as never,
      ...callCtx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/requires a non-empty `values` map/);
  });
});
