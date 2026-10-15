import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerMemoryBackend,
  __resetPerTurnRecallDedupForTests,
  type Agent,
  type AgentRatingSummary,
  type AgentStore,
  type MemorySearchResult,
  type Settings,
} from "@fusion/core";
import {
  buildPromptLayers,
  collapsePromptLayers,
  buildRequestVolatileContext,
  withRequestVolatileContext,
  SESSION_CONTEXT_HEADING,
} from "../execution/prompt-layers.js";
import {
  resolveAgentInstructionParts,
  resolveAgentInstructionPartsWithRatings,
  buildAgentChatPromptParts,
} from "../agents/agent-instructions.js";
import { getExecutorSystemPrompt, getWithheldFollowUpToolGuidance } from "../executor/system-prompt.js";
import { buildTriagePromptContext, resolveTriagePlannerInstructions } from "../triage.js";

/*
FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
Acceptance contract for RUFU-267. Providers only reuse a cached prefix while it is byte-identical, so a
system prompt that diverges at byte N forfeits the cache for everything before it. Each lane test composes
the SAME role's prompt twice through the lane's real composition seam with runtime-mutable state changed
in between and requires `expect(second).toBe(first)` on the serialized system prompt. A lane whose head is
stable only because nothing volatile was wired would pass vacuously, so every lane also asserts the
volatile payload still reaches that turn's request.

Measured before this change (two consecutive same-role builds, volatile state changed): heartbeat
divergence at byte 2774, triage at 2769, executor at 2807, reviewer at 1612, chat at 797.
*/

const AGENT_ID = "agent-stability";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "stability-agent",
    role: "executor",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  } as Agent;
}

function makeRatingSummary(score: number): AgentRatingSummary {
  return {
    agentId: AGENT_ID,
    averageScore: score,
    totalRatings: 3,
    categoryAverages: {},
    recentRatings: [],
    trend: "stable",
  } as unknown as AgentRatingSummary;
}

/** Store fake whose only relevant surface is the runtime rating fetch. */
function storeWithRatings(score: number): AgentStore {
  return { getRatingSummary: async () => makeRatingSummary(score) } as unknown as AgentStore;
}

const settings = {} as Settings;

async function writeAgentMemory(rootDir: string, body: string): Promise<void> {
  await mkdir(join(rootDir, ".fusion", "agent-memory", AGENT_ID), { recursive: true });
  await writeFile(join(rootDir, ".fusion", "agent-memory", AGENT_ID, "MEMORY.md"), body, "utf-8");
}

async function writeProjectMemory(rootDir: string, body: string): Promise<void> {
  await mkdir(join(rootDir, ".fusion", "memory"), { recursive: true });
  await writeFile(join(rootDir, ".fusion", "memory", "MEMORY.md"), body, "utf-8");
}

describe("prompt byte stability across lanes (RUFU-267)", () => {
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "fusion-byte-stability-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("heartbeat lane", () => {
    const HEAD = "You are the persistent heartbeat agent. Read your heartbeat file and act.";

    const composeHead = (configTime: string) =>
      collapsePromptLayers(buildPromptLayers({
        basePrompt: HEAD,
        memoryInstructions: "## Agent Memory\n\nQuery memory before re-reading raw sources.",
        agentInstructions: configTime,
        pluginContributions: "## Plugin: audit\n\nRecord notable actions.",
        operatorLanguageDirective: "## Operator Language\n\nWrite operator-facing prose in Slovak.",
      }));

    it("keeps the serialized system prompt byte-identical while agent memory and ratings change", async () => {
      const agent = makeAgent({ role: "custom", instructionsText: "Act on the heartbeat file.", soul: "Steady and cautious." });

      await writeAgentMemory(testDir, "Durable note: never force push.");
      const firstParts = await resolveAgentInstructionPartsWithRatings(agent, testDir, storeWithRatings(4.2), "full");
      const firstHead = composeHead(firstParts.configTime);
      const firstTail = buildRequestVolatileContext({
        memorySection: firstParts.memorySection,
        performanceFeedback: firstParts.performanceFeedback,
        selfImprovePrompt: "## Self-Improvement\n\nReview yesterday's mistakes.",
      });

      await writeAgentMemory(testDir, "Durable note: never force push.\n\n## New\n\nA note added between heartbeats.");
      const secondParts = await resolveAgentInstructionPartsWithRatings(agent, testDir, storeWithRatings(3.1), "full");
      const secondHead = composeHead(secondParts.configTime);
      const secondTail = buildRequestVolatileContext({
        memorySection: secondParts.memorySection,
        performanceFeedback: secondParts.performanceFeedback,
        selfImprovePrompt: "## Self-Improvement\n\nReview yesterday's mistakes.",
      });

      expect(secondHead).toBe(firstHead);
      // Non-vacuity: the memory and rating deltas really changed and really reach the model.
      expect(secondParts.memorySection).not.toBe(firstParts.memorySection);
      expect(secondTail).toContain("A note added between heartbeats");
      expect(secondTail).not.toBe(firstTail);
      expect(secondHead).not.toContain("A note added between heartbeats");
      expect(secondHead).not.toContain(SESSION_CONTEXT_HEADING);
    });

    it("leaves the heartbeat head untouched by a memory write when inclusion is off", async () => {
      const agent = makeAgent({ role: "custom", instructionsText: "Act on the heartbeat file." });

      await writeAgentMemory(testDir, "Note one.");
      const before = composeHead((await resolveAgentInstructionParts(agent, testDir, undefined, "off")).configTime);

      await writeAgentMemory(testDir, "Note one.\nNote two added by a capture pass.");
      const after = composeHead((await resolveAgentInstructionParts(agent, testDir, undefined, "off")).configTime);

      expect(after).toBe(before);
    });
  });

  describe("triage/planning lane", () => {
    /*
    FNXC:PromptByteStability 2026-09-24-06:40 (RUFU-267 code-review remediation):
    The first version of this lane passed a literal `plannerInstructions` string straight into the head
    builder, so it only re-typed what a correct caller would do: the planning lane was still resolving the
    planner's live memory bodies and store-read rating summary through the COLLAPSED instruction helpers and
    shipping them in the system prompt, and this test stayed green over that leak. It now drives the
    production seam pair — `resolveTriagePlannerInstructions` (memory-mode resolution, parts split, rating
    fetch) and `buildTriagePromptContext` (head + tail) — with a planner whose memory file AND rating summary
    change between dispatch N and N+1, so a regression that re-merges the volatile halves into the head fails
    here instead of silently passing.
    */
    const plannerInputs = {
      basePrompt: "You are the Fusion planning agent.",
      pluginContributions: "## Plugin: board\n\nSummarize the board.",
    };

    /** One planning dispatch through the production seams: resolve the agent's bytes, then compose head + tail. */
    async function dispatchPlanning(memoryBody: string, averageScore: number, goalContext: string) {
      const planner = makeAgent({
        role: "triage",
        soul: "Methodical.",
        instructionsText: "Plan each card into scoped steps with acceptance criteria.",
      });
      await writeAgentMemory(testDir, memoryBody);
      const resolved = await resolveTriagePlannerInstructions({
        agent: planner,
        rootDir: testDir,
        settings,
        includeRatings: true,
        agentStore: storeWithRatings(averageScore),
      });
      return buildTriagePromptContext({
        ...plannerInputs,
        settings,
        plannerInstructions: resolved.plannerInstructions,
        instructionVolatile: resolved.instructionVolatile,
        goalContext,
        identitySection: `## Identity\n\nYou are the Planner (agent ID: ${AGENT_ID}, role: triage).`,
        policySections: "## Do not duplicate existing capabilities — search for an equivalent first.",
      });
    }

    it("keeps the planning system prompt byte-identical while the planner's memory, ratings, goals and policy change", async () => {
      const first = await dispatchPlanning(
        "Planning note: prefer narrow file scopes.",
        4.6,
        "## Active Goals\n\n- Ship RUFU-267",
      );
      const second = await dispatchPlanning(
        "Planning note: prefer narrow file scopes.\n\nNew: cite the reviewer's reasoning trail before fixing.",
        3.1,
        "## Active Goals\n\n- Ship RUFU-267\n- Land the volatility guard (goal created between cards)",
      );

      // The contract: same role, same config-time bytes => a byte-identical serialized system prompt.
      expect(second.systemPrompt).toBe(first.systemPrompt);
      expect(second.layers.stable).toBe(first.layers.stable);
      expect(second.layers.dynamic).toBe(first.layers.dynamic);
      // Non-vacuity in the other direction: the head is stable because it is config-time, not because the
      // planner's own instructions were dropped on the floor.
      expect(second.systemPrompt).toContain("Plan each card into scoped steps");
      expect(second.systemPrompt).toContain("Methodical");
      expect(second.systemPrompt).toContain("Summarize the board");
      // None of the runtime-mutable halves may appear in the serialized head.
      expect(second.systemPrompt).not.toContain("prefer narrow file scopes");
      expect(second.systemPrompt).not.toContain("Average score");
      expect(second.systemPrompt).not.toContain("Active Goals");
      expect(second.systemPrompt).not.toContain(SESSION_CONTEXT_HEADING);
      // …and they are still delivered, on this dispatch's request tail.
      expect(second.requestVolatileContext).toContain(SESSION_CONTEXT_HEADING);
      expect(first.requestVolatileContext).toContain("prefer narrow file scopes");
      expect(first.requestVolatileContext).toContain("Average score: 4.6");
      expect(first.requestVolatileContext).toContain("Ship RUFU-267");
      expect(second.requestVolatileContext).toContain("cite the reviewer's reasoning trail");
      expect(second.requestVolatileContext).toContain("Average score: 3.1");
      expect(second.requestVolatileContext).toContain("Land the volatility guard");
      expect(second.requestVolatileContext).not.toBe(first.requestVolatileContext);
    });

    it("keeps the role-scan planner head stable and rating-free, matching the pre-split lane", async () => {
      // The no-assigned-agent fallback scans triage-role agents WITHOUT a rating fetch; the split must keep
      // that behavior (ratings absent) instead of silently widening it to every triage agent.
      const planner = makeAgent({ role: "triage", instructionsText: "Plan the card into steps and acceptance criteria." });
      const store = storeWithRatings(4.9);
      const scanRatings = vi.fn(store.getRatingSummary);
      const scanStore = { getRatingSummary: scanRatings } as unknown as AgentStore;

      await writeAgentMemory(testDir, "Fallback memory: keep specs reproducible.");
      const first = await resolveTriagePlannerInstructions({ agent: planner, rootDir: testDir, settings, agentStore: scanStore });
      await writeAgentMemory(testDir, "Fallback memory: keep specs reproducible.\n\nNew: cite the surface checklist.");
      const second = await resolveTriagePlannerInstructions({ agent: planner, rootDir: testDir, settings, agentStore: scanStore });

      expect(second.plannerInstructions).toBe(first.plannerInstructions);
      expect(scanRatings).not.toHaveBeenCalled();
      expect(second.instructionVolatile.performanceFeedback).toBe("");
      expect(second.instructionVolatile.memorySection).not.toBe(first.instructionVolatile.memorySection);
      expect(second.instructionVolatile.memorySection).toContain("cite the surface checklist");
    });
  });

  describe("executor lane", () => {
    it("keeps the executor system prompt byte-identical while withheld-tool policy flips", () => {
      const executorSettings = { taskRecommendationCapture: false } as unknown as Settings;
      const before = getExecutorSystemPrompt(executorSettings);
      const tailBefore = getWithheldFollowUpToolGuidance(executorSettings, { taskCreateWithheld: false, delegateWithheld: false });

      const after = getExecutorSystemPrompt(executorSettings);
      const tailAfter = getWithheldFollowUpToolGuidance(executorSettings, { taskCreateWithheld: true, delegateWithheld: true });

      expect(after).toBe(before);
      expect(before).not.toContain("Follow-up task creation is disabled");
      expect(tailAfter).toContain("Follow-up task creation is disabled");
      expect(tailAfter).not.toBe(tailBefore);
    });

    it("keeps the executor head byte-identical while memory, goals, and the per-card persona change", async () => {
      const agent = makeAgent();
      const composeHead = (configTime: string) =>
        collapsePromptLayers(buildPromptLayers({
          basePrompt: getExecutorSystemPrompt(settings),
          agentInstructions: configTime,
          pluginContributions: "## Plugin: lint\n\nRun the linter.",
          operatorLanguageDirective: "## Operator Language\n\nWrite operator-facing prose in Slovak.",
        }));

      await writeAgentMemory(testDir, "Executor note: keep the gate green.");
      const firstParts = await resolveAgentInstructionParts(agent, testDir, undefined, "full");
      const firstHead = composeHead(firstParts.configTime);

      await writeAgentMemory(testDir, "Executor note: keep the gate green.\n\nSecond note written mid-run.");
      const secondParts = await resolveAgentInstructionParts(agent, testDir, undefined, "full");
      const secondHead = composeHead(secondParts.configTime);
      const secondTail = buildRequestVolatileContext({
        memorySection: secondParts.memorySection,
        goalContext: "## Active Goals\n\n- RUFU-267",
        identitySection: `## Identity\n\nYou are Card Owner (agent ID: ${AGENT_ID}, role: executor).`,
        performanceFeedback: secondParts.performanceFeedback,
        policySections: [getWithheldFollowUpToolGuidance(settings, { taskCreateWithheld: true, delegateWithheld: false })],
      });

      expect(secondHead).toBe(firstHead);
      expect(secondHead).not.toContain("Second note written mid-run");
      expect(secondHead).not.toContain("Card Owner");
      expect(secondTail).toContain("Second note written mid-run");
      expect(secondTail).toContain("Card Owner");
      expect(secondTail).toContain("Active Goals");
    });
  });

  describe("reviewer lane", () => {
    it("keeps the reviewer system prompt byte-identical while memory and ratings change", async () => {
      const agent = makeAgent({ role: "reviewer" });
      const composeHead = (configTime: string) =>
        collapsePromptLayers(buildPromptLayers({
          basePrompt: "You are a code reviewer. Review the diff, not the author.",
          agentInstructions: configTime,
          pluginContributions: "## Plugin: security\n\nFlag secret leaks.",
          operatorLanguageDirective: "## Operator Language\n\nWrite findings in Slovak.",
        }));

      await writeAgentMemory(testDir, "Reviewer memory: check migration reversibility.");
      const firstParts = await resolveAgentInstructionPartsWithRatings(agent, testDir, storeWithRatings(4.8), "full");
      const firstHead = composeHead(firstParts.configTime);

      await writeAgentMemory(testDir, "Reviewer memory: check migration reversibility.\n\nNew: check index rebuild cost.");
      const secondParts = await resolveAgentInstructionPartsWithRatings(agent, testDir, storeWithRatings(2.4), "full");
      const secondHead = composeHead(secondParts.configTime);
      const secondTail = buildRequestVolatileContext({
        memorySection: secondParts.memorySection,
        performanceFeedback: secondParts.performanceFeedback,
        taskReviewPolicy: "## Workflow Review Policy\n\nThe selected workflow IR is authoritative.",
      });

      expect(secondHead).toBe(firstHead);
      expect(secondHead).not.toContain("index rebuild cost");
      expect(secondTail).toContain("index rebuild cost");
      expect(secondTail).toContain("Workflow Review Policy");
    });

    it("carries the authoritative workflow IR review policy on the request, not in the head", () => {
      const withoutPolicy = withRequestVolatileContext("Review this diff.", {});
      const withPolicy = withRequestVolatileContext("Review this diff.", {
        taskReviewPolicy: "## Workflow Review Policy\n\nReview against the IR-defined steps.",
      });

      expect(withoutPolicy).toBe("Review this diff.");
      expect(withPolicy).toContain("Workflow Review Policy");
      expect(withPolicy.startsWith("Review this diff.\n\n")).toBe(true);
    });
  });

  describe("chat lane", () => {
    const baseCapabilities = {
      read: true,
      write: true,
      search: true,
      structuredFilters: false,
      semanticSimilarity: false,
      temporalQueries: false,
      incrementalIndexing: false,
      autoExtraction: false,
    } as const;

    let searchCall = 0;

    beforeEach(() => {
      searchCall = 0;
      __resetPerTurnRecallDedupForTests();
      registerMemoryBackend({
        type: "stability-fake",
        name: "Byte-stability fake backend",
        capabilities: baseCapabilities,
        read: async () => ({ content: "", exists: false, backend: "stability-fake" }),
        write: async () => {
          throw new Error("read-only fake");
        },
        search: async (_rootDir, opts): Promise<MemorySearchResult[]> => {
          searchCall += 1;
          return [{
            path: `.fusion/memory/${searchCall}.md`,
            lineStart: 1,
            lineEnd: 3,
            score: 7,
            backend: "stability-fake",
            snippet: `RECALL-${searchCall} for query ${opts.query}`,
          }];
        },
      });
    });

    afterEach(() => {
      __resetPerTurnRecallDedupForTests();
    });

    it("keeps the chat system prompt byte-identical while memory, recall, and ratings change", async () => {
      const agent = makeAgent({ name: "Avery", role: "reviewer", instructionsText: "Answer from the codebase." });
      const chatSettings = {
        operatorLanguage: "sk",
        memoryEnabled: true,
        memoryBackendType: "stability-fake",
        memoryPerTurnRecallEnabled: true,
        memoryPerTurnRecallTopK: 3,
      } as unknown as Settings;
      const compose = (query: string, score: number) => buildAgentChatPromptParts({
        agent,
        rootDir: testDir,
        agentStore: storeWithRatings(score),
        basePrompt: "You are a chat assistant.",
        includeProjectMemory: true,
        settings: chatSettings,
        topic: query,
        sessionId: "session-stability",
      });

      await writeProjectMemory(testDir, "Project memory: avoid force pushes.");
      const first = await compose("volatility guard", 4.5);

      await writeProjectMemory(testDir, "Project memory: avoid force pushes.\n\nNew: prefix caching needs byte-identical heads.");
      const second = await compose("system prompt caching", 2.1);

      expect(second.systemPrompt).toBe(first.systemPrompt);
      // Non-vacuity: memory, recall, and the rating summary really moved this turn's request.
      expect(second.requestContext).toContain("prefix caching needs byte-identical heads");
      expect(first.requestContext).toContain("RECALL-");
      expect(second.requestContext).not.toBe(first.requestContext);
      expect(second.systemPrompt).not.toContain(SESSION_CONTEXT_HEADING);
      expect(second.systemPrompt).not.toContain("prefix caching needs");
      expect(second.systemPrompt).not.toContain("RECALL-");
    });

    it("keeps the chat head stable across a bounded-memory turn and an unbounded one", async () => {
      const agent = makeAgent({ name: "Avery", role: "reviewer" });
      await writeProjectMemory(testDir, "Project memory: small note.");

      const uncapped = await buildAgentChatPromptParts({
        agent,
        rootDir: testDir,
        basePrompt: "You are a chat assistant.",
        includeProjectMemory: true,
        settings,
      });
      const capped = await buildAgentChatPromptParts({
        agent,
        rootDir: testDir,
        basePrompt: "You are a chat assistant.",
        includeProjectMemory: true,
        settings,
        memoryCapChars: 4000,
      });

      expect(capped.systemPrompt).toBe(uncapped.systemPrompt);
      expect(capped.requestContext).toContain("small note");
    });
  });

  describe("workflow step lane", () => {
    it("keeps a step session's system prompt byte-identical while the step agent's memory differs", async () => {
      const agent = makeAgent({ role: "executor" });
      const composeHead = async () => {
        const parts = await resolveAgentInstructionParts(agent, testDir, undefined, "full");
        return collapsePromptLayers(buildPromptLayers({
          basePrompt: "You are a workflow step agent executing: code-review",
          agentInstructions: parts.configTime,
          operatorLanguageDirective: "## Operator Language\n\nWrite the step log in Slovak.",
        }));
      };

      await writeAgentMemory(testDir, "Step memory: pin the baseline SHA.");
      const first = await composeHead();
      await writeAgentMemory(testDir, "Step memory: pin the baseline SHA.\n\nRe-read the reviewer trail first.");
      const second = await composeHead();

      expect(second).toBe(first);
    });
  });
});

describe("request-tail seam shape", () => {
  it("leaves the request byte-identical when there is no volatile context", () => {
    const noop = vi.fn();
    expect(withRequestVolatileContext("unchanged request", {})).toBe("unchanged request");
    expect(noop).not.toHaveBeenCalled();
  });
});
