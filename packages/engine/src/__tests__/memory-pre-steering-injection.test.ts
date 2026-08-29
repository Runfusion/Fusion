import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_PRE_STEERING_MARKER } from "@fusion/core";
import { buildAgentChatPrompt, resolveAgentInstructions } from "../agents/agent-instructions.js";
import { HEARTBEAT_NO_TASK_SYSTEM_PROMPT, HEARTBEAT_SYSTEM_PROMPT, renderHeartbeatNoTaskSystemPrompt } from "../agents/agent-heartbeat-prompts.js";
import { buildExecutionPrompt } from "../executor.js";

const agent = {
  id: "memory-agent",
  name: "Memory Agent",
  role: "executor",
  roles: ["executor"],
  state: "idle",
  memory: "Remember the repository convention.",
  runtimeConfig: {},
} as any;
const task = { id: "FN-8934", title: "Memory steering", description: "Test task", steps: [], dependencies: [] } as any;

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath.replace("packages/engine/", "")), "utf8");
}

describe("memory pre-steering injection inventory", () => {
  it("injects full/index agent instructions and suppresses them off", async () => {
    await expect(resolveAgentInstructions(agent, process.cwd(), undefined, "full")).resolves.toContain(MEMORY_PRE_STEERING_MARKER);
    await expect(resolveAgentInstructions(agent, process.cwd(), undefined, "index")).resolves.toContain(MEMORY_PRE_STEERING_MARKER);
    await expect(resolveAgentInstructions(agent, process.cwd(), undefined, "off")).resolves.not.toContain(MEMORY_PRE_STEERING_MARKER);
  });

  it("carries the nudge through chat and execution prompt assembly", async () => {
    await expect(buildAgentChatPrompt({ agent, rootDir: process.cwd(), basePrompt: "Base" })).resolves.toContain(MEMORY_PRE_STEERING_MARKER);
    expect(buildExecutionPrompt(task, process.cwd(), { agentMemoryInclusionMode: "full" } as any)).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(buildExecutionPrompt(task, process.cwd(), { agentMemoryInclusionMode: "index" } as any)).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(buildExecutionPrompt(task, process.cwd(), { agentMemoryInclusionMode: "off" } as any)).not.toContain(MEMORY_PRE_STEERING_MARKER);
  });

  it("keeps both static heartbeat variants and patrol rendering memory-first", () => {
    expect(HEARTBEAT_SYSTEM_PROMPT).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(renderHeartbeatNoTaskSystemPrompt({ plannerHeartbeatPatrolEnabled: false })).toContain(MEMORY_PRE_STEERING_MARKER);
  });

  it("threads mode-aware steering through heartbeat, triage, and reviewer assemblers", () => {
    expect(source("packages/engine/src/agent-heartbeat.ts")).toContain('buildMemoryPreSteeringNudge("index")');
    expect(source("packages/engine/src/triage.ts")).toContain('buildTriageMemoryInstructions("", settings, undefined, memoryMode)');
    expect(source("packages/engine/src/execution/reviewer.ts")).toContain('buildReviewerMemoryInstructions(options.rootDir, effectiveSettings, undefined, reviewerMemoryMode)');
    expect(source("packages/engine/src/merger.ts")).toContain('resolveAgentInstructions(agent, rootDir, undefined, memoryMode)');
  });
});
