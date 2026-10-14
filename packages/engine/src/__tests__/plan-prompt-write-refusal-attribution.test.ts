/*
FNXC:PlanPromptWriteRefusal 2026-10-14-10:04 (RUFU-651):
`STUCK_LOOP_EXHAUSTED` cards ran many planner sessions, wrote no PROMPT.md, and their six attempts
each reported only "Planner did not update the authoritative PROMPT.md". The durable writer can be
the party that stopped the plan — a reset fence, malformed `### Step N:` dependencies, or a failed
read-back — and every one of those refusals used to be returned as `STORE_UNAVAILABLE` with retry
guidance, which is the lie `tool-store-errors.ts` records for STAS-251 ("telling an agent to retry a
refusal teaches them to retry it").

The invariant is two-sided, so both halves are asserted here: a refusal must be shape- and text-wise
a refusal AND a genuine store failure must keep the outage shape. Laundering either direction is what
made the cause unreadable. Asserted through the real tool body, not a mock of its conclusion.
*/
import { describe, expect, it } from "vitest";

import type { TaskStore } from "@fusion/core";
import {
  createTaskPromptWriteTool,
  type PlanPromptWriteRefusalReason,
} from "../agent-tools.js";
import { describeUnwrittenPlanArtifact } from "../triage.js";
import { STORE_RETRY_GUIDANCE } from "../tool-store-errors.js";

type ToolResult = {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

const STORE_UNAVAILABLE_TEXT = "did not reach the task store";

function call(tool: { execute: (id: string, params: unknown) => Promise<ToolResult> }, content: string): Promise<ToolResult> {
  return tool.execute("t1", { content });
}

/** The store is never reached on any refusal path, so an empty stub is the honest fake here. */
const unusedStore = {} as unknown as TaskStore;

describe("fn_task_prompt_write refusal attribution (RUFU-651)", () => {
  it("a superseded planning generation is returned as a refusal, never as a store outage", async () => {
    const refusals: PlanPromptWriteRefusalReason[] = [];
    const tool = createTaskPromptWriteTool(
      unusedStore,
      "FN-1",
      undefined,
      () => false,
      (info) => refusals.push(info.reason),
    );

    const result = await call(tool as never, "# Task\n\nPlain plan body with no step headings.\n");

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("PLAN_PROMPT_WRITE_REFUSED");
    expect(result.details.refusal).toBe("planning-reset-fenced");
    expect(result.content[0].text).toContain("planning-reset-fenced");
    // The old shape told the model the board recorded nothing and to retry — for something a retry
    // can never change, because a newer planning generation owns the spec now.
    expect(result.content[0].text).not.toContain(STORE_UNAVAILABLE_TEXT);
    expect(result.content[0].text).not.toContain(STORE_RETRY_GUIDANCE);
    expect(result.content[0].text).toContain("Do not retry");
    expect(refusals).toEqual(["planning-reset-fenced"]);
  });

  it("malformed step-dependency annotations are the writer's verdict, not an outage", async () => {
    const refusals: PlanPromptWriteRefusalReason[] = [];
    const tool = createTaskPromptWriteTool(unusedStore, "FN-1", undefined, undefined, (info) => refusals.push(info.reason));

    // Two `(depends:` annotations on one heading is the documented `malformed` coordinate.
    const result = await call(tool as never, "### Step 0 (depends: ): A (depends: ): B\n");

    expect(result.isError).toBe(true);
    expect(result.details.refusal).toBe("invalid-step-headings");
    expect(result.content[0].text).toContain("invalid-step-headings");
    expect(result.content[0].text).not.toContain(STORE_UNAVAILABLE_TEXT);
    expect(refusals).toEqual(["invalid-step-headings"]);
  });

  it("a real store failure still reports the outage shape — refusals did not swallow outages", async () => {
    const refusals: PlanPromptWriteRefusalReason[] = [];
    const throwingStore = {
      updateTask: async () => {
        throw new Error("connection refused");
      },
    } as unknown as TaskStore;
    const tool = createTaskPromptWriteTool(throwingStore, "FN-1", undefined, undefined, (info) => refusals.push(info.reason));

    const result = await call(tool as never, "# Task\n\nBody.\n");

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("STORE_UNAVAILABLE");
    expect(result.content[0].text).toContain(STORE_RETRY_GUIDANCE);
    expect(result.content[0].text).not.toContain("PLAN_PROMPT_WRITE_REFUSED");
    expect(refusals).toEqual([]);
  });
});

describe("describeUnwrittenPlanArtifact attributes the stopped plan correctly", () => {
  const SENTENCE = "Planner did not update the authoritative PROMPT.md during attempt FN-1:3";

  it("keeps the historical sentence verbatim when the writer never refused", () => {
    expect(describeUnwrittenPlanArtifact("FN-1:3")).toBe(SENTENCE);
    expect(describeUnwrittenPlanArtifact("FN-1:3", [])).toBe(SENTENCE);
  });

  it("names the writer and counts each refusal once the writer refused", () => {
    const text = describeUnwrittenPlanArtifact("FN-1:3", ["planning-reset-fenced", "planning-reset-fenced", "invalid-step-headings"]);
    expect(text).toContain(SENTENCE);
    expect(text).toContain("planning-reset-fenced x2");
    expect(text).toContain("invalid-step-headings x1");
    expect(text).toContain("not a planner that produced no plan");
  });
});
