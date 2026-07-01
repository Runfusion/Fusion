import { describe, expect, it } from "vitest";
import type { Agent, AgentLogEntry, Settings, Task } from "@fusion/core";
import {
  extractAssignedRuntimeModel,
  extractExecutorModelFromLog,
  extractPlanningModelFromLog,
  extractReviewerModelFromLog,
  parseRuntimeModelMarker,
  resolveEffectiveExecutor,
  resolveEffectivePlanning,
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
  it("extracts the latest role-specific model marker from legacy and suffixed agent logs", () => {
    const entries = [
      log("executor", "Executor using model: old-provider/old-model"),
      log("reviewer", "Reviewer using model: reviewer-provider/reviewer-model (thinking effort: high)"),
      log("triage", "Triage using model: triage-provider/triage-model (thinking effort: low)"),
      log("executor", "Executor using model: new-provider/new-model (thinking effort: high)"),
    ];

    expect(extractExecutorModelFromLog(entries)).toEqual({ provider: "new-provider", modelId: "new-model" });
    expect(extractReviewerModelFromLog(entries)).toEqual({ provider: "reviewer-provider", modelId: "reviewer-model" });
    expect(extractPlanningModelFromLog(entries)).toEqual({ provider: "triage-provider", modelId: "triage-model" });
  });

  it("parses runtime model markers for all roles while ignoring parenthesized diagnostics", () => {
    expect(parseRuntimeModelMarker("Triage using model: google/gemini-pro", "Triage")).toEqual({ provider: "google", modelId: "gemini-pro" });
    expect(parseRuntimeModelMarker("Executor using model: openai/gpt-4o (thinking effort: high)", "Executor")).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(parseRuntimeModelMarker("Reviewer using model: anthropic/claude-sonnet-4-5 (thinking effort: high) (fallback after timeout)", "Reviewer")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(parseRuntimeModelMarker("Executor using model: openai/gpt-4o (thinking effort: high)", "Reviewer")).toBeNull();
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

    expect(resolveEffectivePlanning(task, [log("triage", "Triage using model: log-planning/log-planning-model")], settings)).toEqual({ provider: "task-planning", modelId: "task-planning-model" });
    expect(resolveEffectivePlanning({ ...baseTask, planningModelProvider: null, planningModelId: null } as Task, [log("triage", "Triage using model: log-planning/log-planning-model")], settings)).toEqual({ provider: "log-planning", modelId: "log-planning-model" });
    expect(resolveEffectivePlanning({ ...baseTask, planningModelProvider: null, planningModelId: null } as Task, [], settings)).toEqual({ provider: "settings-planning", modelId: "settings-planning-model" });
  });
});
