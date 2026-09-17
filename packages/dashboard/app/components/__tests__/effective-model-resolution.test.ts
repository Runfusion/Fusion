import { describe, expect, it } from "vitest";
import type { Agent, AgentLogEntry, Settings, Task } from "@fusion/core";
import {
  extractAssignedRuntimeModel,
  extractExecutorModelFromLog,
  extractPlanningModelFromLog,
  extractReviewerModelFromLog,
  extractThinkingLevelFromLog,
  parseRuntimeModelMarker,
  parseRuntimeModelMarkerThinkingLevel,
  resolveEffectiveExecutor,
  resolveEffectiveThinkingLevel,
  resolveEffectivePlanning,
  resolveEffectiveTaskChat,
  resolveEffectiveValidator,
} from "../effective-model-resolution";

const baseTask: Task = {
  id: "FN-7040",
  title: "Align models",
  status: "todo",
  column: "todo",
  createdAt: "2026-06-25T00:00:00Z",
  updatedAt: "2026-06-25T00:00:00Z",
  dependencies: [],
  outputBranch: null,
  prompt: "",
  baseBranch: null,
  assignee: null,
  labels: [],
  priority: "normal",
  autoMerge: false,
  autoMergeMode: "squash",
  paused: false,
  userPaused: false,
} as Task;

const settings: Settings = {
  executionProvider: "settings-executor",
  executionModelId: "settings-executor-model",
  validatorProvider: "settings-reviewer",
  validatorModelId: "settings-reviewer-model",
  planningProvider: "settings-planning",
  planningModelId: "settings-planning-model",
} as Settings;

function log(agent: AgentLogEntry["agent"], text: string): AgentLogEntry {
  return {
    timestamp: "2026-06-25T00:00:00Z",
    taskId: "FN-7040",
    agent,
    type: "text",
    text,
  };
}

function runtimeAgent(runtimeConfig?: Record<string, unknown>): Agent {
  return {
    id: "agent-1",
    name: "Executor",
    role: "executor",
    state: "running",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
    metadata: {},
    runtimeConfig,
  } as Agent;
}

describe("effective model resolution", () => {
  it("extracts the latest role-specific model marker from Planning and legacy Triage agent logs", () => {
    const entries = [
      log("executor", "Executor using model: old-provider/old-model"),
      log("reviewer", "Reviewer using model: reviewer-provider/reviewer-model (thinking effort: high)"),
      log("triage", "Triage using model: legacy-planning/legacy-planning-model"),
      log("triage", "Planning using model: planning-provider/planning-model (thinking effort: low)"),
      log("executor", "Executor using model: new-provider/new-model (thinking effort: high)"),
    ];

    expect(extractExecutorModelFromLog(entries)).toEqual({ provider: "new-provider", modelId: "new-model" });
    expect(extractReviewerModelFromLog(entries)).toEqual({ provider: "reviewer-provider", modelId: "reviewer-model" });
    expect(extractPlanningModelFromLog(entries)).toEqual({ provider: "planning-provider", modelId: "planning-model" });
  });

  /*
  FNXC:TaskLogModelThinking 2026-07-15-11:20:
  Engine lanes now write the "using model" markers as standalone `status` rows so they are not
  glued together like streamed deltas. Resolution must read BOTH types: `status` for new rows,
  `text` for the markers already persisted in every existing task's log. Accepting only one type
  silently blanks the provider icons / effective-model headers on one side of that cutover.
  */
  it("resolves model markers from both new status rows and legacy text rows", () => {
    const statusEntries = [
      { ...log("executor", "Executor using model: status-provider/status-model"), type: "status" as const },
      { ...log("reviewer", "Reviewer using model: status-reviewer/status-reviewer-model"), type: "status" as const },
      { ...log("triage", "Planning using model: status-planning/status-planning-model"), type: "status" as const },
    ];
    expect(extractExecutorModelFromLog(statusEntries)).toEqual({ provider: "status-provider", modelId: "status-model" });
    expect(extractReviewerModelFromLog(statusEntries)).toEqual({ provider: "status-reviewer", modelId: "status-reviewer-model" });
    expect(extractPlanningModelFromLog(statusEntries)).toEqual({ provider: "status-planning", modelId: "status-planning-model" });

    // Legacy text rows, including the former Triage planning prefix, still resolve.
    const legacyEntries = [log("executor", "Executor using model: legacy-provider/legacy-model")];
    const legacyPlanningEntries = [log("triage", "Triage using model: legacy-planning/legacy-planning-model")];
    expect(extractExecutorModelFromLog(legacyEntries)).toEqual({ provider: "legacy-provider", modelId: "legacy-model" });
    expect(extractPlanningModelFromLog(legacyPlanningEntries)).toEqual({ provider: "legacy-planning", modelId: "legacy-planning-model" });

    // A tool row is still never a model marker, whatever its text says.
    const toolEntries = [{ ...log("executor", "Executor using model: tool-provider/tool-model"), type: "tool" as const }];
    expect(extractExecutorModelFromLog(toolEntries)).toBeNull();
  });

  it("parses runtime model markers for all roles while ignoring parenthesized diagnostics", () => {
    expect(parseRuntimeModelMarker("Planning using model: google/gemini-pro (thinking effort: low)", "Planning")).toEqual({ provider: "google", modelId: "gemini-pro" });
    expect(parseRuntimeModelMarker("Triage using model: google/gemini-pro", "Planning")).toEqual({ provider: "google", modelId: "gemini-pro" });
    expect(parseRuntimeModelMarker("Planning using model: google/gemini-pro", "Triage")).toEqual({ provider: "google", modelId: "gemini-pro" });
    expect(parseRuntimeModelMarker("Executor using model: openai/gpt-4o (thinking effort: high)", "Executor")).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(parseRuntimeModelMarker("Reviewer using model: anthropic/claude-sonnet-4-5 (thinking effort: high) (fallback after timeout)", "Reviewer")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(parseRuntimeModelMarker("Executor using model: openai/gpt-4o (thinking effort: high)", "Reviewer")).toBeNull();
    expect(parseRuntimeModelMarker("Planning using model: google/gemini-pro", "Executor")).toBeNull();
    expect(parseRuntimeModelMarker("Executor using model: unknown model", "Executor")).toBeNull();
  });

  it("parses assigned-agent runtime models from combined or split fields", () => {
    expect(extractAssignedRuntimeModel(runtimeAgent({ model: "runtime-provider/runtime-model" }))).toEqual({ provider: "runtime-provider", modelId: "runtime-model" });
    expect(extractAssignedRuntimeModel(runtimeAgent({ modelProvider: "split-provider", modelId: "split-model" }))).toEqual({ provider: "split-provider", modelId: "split-model" });
    expect(extractAssignedRuntimeModel(runtimeAgent({ model: "malformed" }))).toEqual({ provider: undefined, modelId: undefined });
    expect(extractAssignedRuntimeModel(null)).toEqual({ provider: undefined, modelId: undefined });
  });

  it("resolves executor from log marker before assigned runtime, task override, and settings fallback", () => {
    const task = { ...baseTask, status: "executing", column: "in-progress", modelProvider: "task-provider", modelId: "task-model" } as Task;

    expect(resolveEffectiveExecutor(task, [log("executor", "Executor using model: log-provider/log-model")], runtimeAgent({ model: "runtime-provider/runtime-model" }), settings)).toEqual({ provider: "log-provider", modelId: "log-model" });
    expect(resolveEffectiveExecutor(task, [], runtimeAgent({ model: "runtime-provider/runtime-model" }), settings)).toEqual({ provider: "runtime-provider", modelId: "runtime-model" });
    expect(resolveEffectiveExecutor({ ...task, status: "todo", column: "todo" } as Task, [], runtimeAgent({ model: "runtime-provider/runtime-model" }), settings)).toEqual({ provider: "task-provider", modelId: "task-model" });
    expect(resolveEffectiveExecutor({ ...baseTask, modelProvider: null, modelId: null } as Task, [], null, settings)).toEqual({ provider: "settings-executor", modelId: "settings-executor-model" });
  });

  it("resolves validator from reviewer log marker before assigned runtime, task override, and settings fallback", () => {
    const task = { ...baseTask, status: "executing", column: "in-progress", validatorModelProvider: "task-reviewer", validatorModelId: "task-reviewer-model" } as Task;

    expect(resolveEffectiveValidator(task, [log("reviewer", "Reviewer using model: log-reviewer/log-reviewer-model")], runtimeAgent({ model: "runtime-provider/runtime-model" }), settings)).toEqual({ provider: "log-reviewer", modelId: "log-reviewer-model" });
    expect(resolveEffectiveValidator(task, [], runtimeAgent({ model: "runtime-provider/runtime-model" }), settings)).toEqual({ provider: "runtime-provider", modelId: "runtime-model" });
    expect(resolveEffectiveValidator({ ...task, status: "done", column: "done" } as Task, [], runtimeAgent({ model: "runtime-provider/runtime-model" }), settings)).toEqual({ provider: "task-reviewer", modelId: "task-reviewer-model" });
    expect(resolveEffectiveValidator({ ...baseTask, validatorModelProvider: null, validatorModelId: null } as Task, [], null, settings)).toEqual({ provider: "settings-reviewer", modelId: "settings-reviewer-model" });
  });

  it("resolves planning from task override before triage log marker and settings fallback", () => {
    const task = { ...baseTask, planningModelProvider: "task-planning", planningModelId: "task-planning-model" } as Task;

    expect(resolveEffectivePlanning(task, [log("triage", "Planning using model: log-planning/log-planning-model")], settings)).toEqual({ provider: "task-planning", modelId: "task-planning-model" });
    expect(resolveEffectivePlanning({ ...baseTask, planningModelProvider: null, planningModelId: null } as Task, [log("triage", "Planning using model: log-planning/log-planning-model")], settings)).toEqual({ provider: "log-planning", modelId: "log-planning-model" });
    expect(resolveEffectivePlanning({ ...baseTask, planningModelProvider: null, planningModelId: null } as Task, [], settings)).toEqual({ provider: "settings-planning", modelId: "settings-planning-model" });
  });

  it("resolves task Chat from the complete Direct Chat model and thinking target", () => {
    expect(resolveEffectiveTaskChat({
      ...settings,
      chatDefaultKind: "model",
      chatDefaultModelProvider: "openai",
      chatDefaultModelId: "gpt-direct",
      chatDefaultThinkingLevel: "high",
      planningProvider: "anthropic",
      planningModelId: "claude-planner",
    } as Settings)).toEqual({ provider: "openai", modelId: "gpt-direct", thinkingLevel: "high" });
  });

  it("falls back from incomplete or agent Direct Chat defaults to the effective project model", () => {
    expect(resolveEffectiveTaskChat({
      ...settings,
      chatDefaultKind: "model",
      chatDefaultModelProvider: "openai",
      chatDefaultModelId: undefined,
      defaultProviderOverride: "google",
      defaultModelIdOverride: "gemini-direct",
      chatDefaultThinkingLevel: "medium",
    } as Settings)).toEqual({ provider: "google", modelId: "gemini-direct", thinkingLevel: "medium" });
    expect(resolveEffectiveTaskChat({
      ...settings,
      chatDefaultKind: "agent",
      chatDefaultAgentId: "agent-direct",
      defaultProvider: "mock",
      defaultModelId: "ignored",
    } as Settings)).toEqual({ provider: "mock", modelId: "scripted" });
  });
});

/*
FNXC:TaskLogModelThinking 2026-09-15-08:46:
FN-410: Activity Live shows the thinking effort that actually ran. These cases pin the two halves of
that promise: the engine's marker annotation is read wherever it sits among the parenthesized
suffixes, and when no marker exists the displayed value follows the same lane precedence the engine
applies — never an invented level.
*/
describe("effective thinking level resolution", () => {
  it("extracts the thinking effort annotation from a runtime marker", () => {
    expect(parseRuntimeModelMarkerThinkingLevel("Executor using model: openai/gpt-4o (thinking effort: high)", "Executor")).toBe("high");
  });

  it("finds the annotation among multiple parenthesized suffixes in any order", () => {
    expect(
      parseRuntimeModelMarkerThinkingLevel(
        "Executor using model: openai/gpt-4o (thinking effort: xhigh) (fallback after timeout)",
        "Executor",
      ),
    ).toBe("xhigh");
    expect(
      parseRuntimeModelMarkerThinkingLevel(
        "Executor using model: openai/gpt-4o (workflow step override) (thinking effort: minimal)",
        "Executor",
      ),
    ).toBe("minimal");
  });

  it("returns undefined for a marker without the annotation and for a non-matching role", () => {
    expect(parseRuntimeModelMarkerThinkingLevel("Executor using model: openai/gpt-4o", "Executor")).toBeUndefined();
    expect(parseRuntimeModelMarkerThinkingLevel("Reviewer using model: openai/gpt-4o (thinking effort: high)", "Executor")).toBeUndefined();
    expect(parseRuntimeModelMarkerThinkingLevel("some unrelated line (thinking effort: high)", "Executor")).toBeUndefined();
  });

  it("treats Planning and Triage markers as one planning lane and keeps the latest value", () => {
    const entries = [
      log("triage", "Triage using model: legacy/legacy-model (thinking effort: low)"),
      log("triage", "Planning using model: planning/planning-model (thinking effort: medium)"),
    ];
    expect(extractThinkingLevelFromLog(entries, "planning")).toBe("medium");
    expect(extractThinkingLevelFromLog([entries[0]], "planning")).toBe("low");
  });

  it("accepts both status and text marker rows and ignores other agents", () => {
    const entries = [
      { ...log("executor", "Executor using model: openai/gpt-4o (thinking effort: high)"), type: "status" as const },
      log("reviewer", "Reviewer using model: openai/o3 (thinking effort: max)"),
    ];
    expect(extractThinkingLevelFromLog(entries, "execution")).toBe("high");
    expect(extractThinkingLevelFromLog(entries, "validation")).toBe("max");
    expect(extractThinkingLevelFromLog(entries, "merger")).toBeUndefined();
  });

  it("prefers the runtime marker over every configured lane value", () => {
    const entries = [log("executor", "Executor using model: openai/gpt-4o (thinking effort: minimal)")];
    const task = { ...baseTask, thinkingLevel: "max" } as Task;
    expect(
      resolveEffectiveThinkingLevel(task, entries, "execution", { ...settings, executionThinkingLevel: "high" } as Settings),
    ).toBe("minimal");
  });

  it("falls back to task override, then project lane, global lane, and default levels", () => {
    const full = {
      ...settings,
      executionThinkingLevel: "high",
      executionGlobalThinkingLevel: "medium",
      defaultThinkingLevelOverride: "low",
      defaultThinkingLevel: "minimal",
    } as Settings;

    expect(resolveEffectiveThinkingLevel({ ...baseTask, thinkingLevel: "max" } as Task, [], "execution", full)).toBe("max");
    expect(resolveEffectiveThinkingLevel(baseTask, [], "execution", full)).toBe("high");
    expect(
      resolveEffectiveThinkingLevel(baseTask, [], "execution", {
        ...full,
        executionThinkingLevel: undefined,
      } as Settings),
    ).toBe("medium");
    expect(
      resolveEffectiveThinkingLevel(baseTask, [], "execution", {
        ...full,
        executionThinkingLevel: undefined,
        executionGlobalThinkingLevel: undefined,
      } as Settings),
    ).toBe("low");
    expect(
      resolveEffectiveThinkingLevel(baseTask, [], "execution", {
        ...full,
        executionThinkingLevel: undefined,
        executionGlobalThinkingLevel: undefined,
        defaultThinkingLevelOverride: undefined,
      } as Settings),
    ).toBe("minimal");
  });

  it("applies the per-lane task overrides the engine applies for every phase", () => {
    const task = {
      ...baseTask,
      thinkingLevel: "medium",
      planningThinkingLevel: "high",
      validatorThinkingLevel: "low",
      mergerThinkingLevel: "xhigh",
    } as Task;

    expect(resolveEffectiveThinkingLevel(task, [], "planning", settings)).toBe("high");
    expect(resolveEffectiveThinkingLevel(task, [], "execution", settings)).toBe("medium");
    expect(resolveEffectiveThinkingLevel(task, [], "validation", settings)).toBe("low");
    expect(resolveEffectiveThinkingLevel(task, [], "merger", settings)).toBe("xhigh");

    // Planning and validation inherit the shared task level when their own override is unset;
    // merger is independent and does NOT inherit it, matching merger.ts.
    const shared = { ...baseTask, thinkingLevel: "medium" } as Task;
    expect(resolveEffectiveThinkingLevel(shared, [], "planning", settings)).toBe("medium");
    expect(resolveEffectiveThinkingLevel(shared, [], "validation", settings)).toBe("medium");
    expect(resolveEffectiveThinkingLevel(shared, [], "merger", settings)).toBeUndefined();
  });

  it("returns undefined when no marker and no setting provides a level", () => {
    for (const phase of ["planning", "execution", "validation", "merger"] as const) {
      expect(resolveEffectiveThinkingLevel(baseTask, [], phase, settings)).toBeUndefined();
      expect(resolveEffectiveThinkingLevel(baseTask, [], phase, undefined)).toBeUndefined();
    }
  });
});
