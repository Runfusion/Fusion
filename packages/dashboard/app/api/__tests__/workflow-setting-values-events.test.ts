import { afterEach, describe, expect, it, vi } from "vitest";
import { updateWorkflowSettingValues } from "../legacy";
import {
  __test_clearWorkflowSettingValuesRevisions,
  getWorkflowSettingValuesRevision,
} from "../../utils/workflowSettingValuesEvents";

function response(ok: boolean, body: unknown, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  __test_clearWorkflowSettingValuesRevisions();
});

describe("workflow setting value update invalidation", () => {
  it("advances the matching workflow revision after a successful write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(true, {
      stored: { plannerOversightLevel: "off" },
      effective: { plannerOversightLevel: "off" },
      orphaned: [],
    })));

    await updateWorkflowSettingValues("builtin:coding", { plannerOversightLevel: "off" }, "project-1");

    expect(getWorkflowSettingValuesRevision("builtin:coding", "project-1")).toBe(1);
    expect(getWorkflowSettingValuesRevision("builtin:coding", "project-2")).toBe(0);
  });

  it("does not invalidate cards when the workflow write fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(false, { error: "failed" })));

    await expect(updateWorkflowSettingValues("builtin:coding", { plannerOversightLevel: "off" }, "project-1")).rejects.toThrow();

    expect(getWorkflowSettingValuesRevision("builtin:coding", "project-1")).toBe(0);
  });

  it("does not blink oversight UI for a successful unrelated setting write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(true, {
      stored: { planningFallbackThinkingLevel: "high" },
      effective: { planningFallbackThinkingLevel: "high" },
      orphaned: [],
    })));

    await updateWorkflowSettingValues("builtin:coding", { planningFallbackThinkingLevel: "high" }, "project-1");

    expect(getWorkflowSettingValuesRevision("builtin:coding", "project-1")).toBe(0);
  });
});
