/**
 * FNXC:CodeOrganization 2026-08-03-21:50:
 * Unit tests for resolveTaskStepSource pure peel (KTD-12).
 */
import { describe, expect, it } from "vitest";
import { resolveTaskStepSource } from "../resolve-task-step-source.js";
import type { WorkflowIr } from "@fusion/core";

function ir(nodes: WorkflowIr["nodes"]): WorkflowIr {
  return { version: "v2", nodes, edges: [], name: "t", columns: [] } as unknown as WorkflowIr;
}

describe("resolveTaskStepSource", () => {
  it("returns undefined without IR or parse-steps node", () => {
    expect(resolveTaskStepSource(undefined)).toBeUndefined();
    expect(resolveTaskStepSource(ir([{ id: "code", kind: "code" } as any]))).toBeUndefined();
  });

  it("reads artifact+parser from the first parse-steps node", () => {
    expect(
      resolveTaskStepSource(
        ir([
          { id: "p", kind: "parse-steps", config: { artifact: "SPEC.md", parser: "markdown-h2" } } as any,
        ]),
      ),
    ).toEqual({ artifact: "SPEC.md", parser: "markdown-h2" });
  });

  it("defaults artifact to PROMPT.md when missing/blank", () => {
    expect(
      resolveTaskStepSource(ir([{ id: "p", kind: "parse-steps", config: { parser: "markdown-h2" } } as any])),
    ).toEqual({ artifact: "PROMPT.md", parser: "markdown-h2" });
    expect(
      resolveTaskStepSource(ir([{ id: "p", kind: "parse-steps", config: { artifact: "  ", parser: "markdown-h2" } } as any])),
    ).toEqual({ artifact: "PROMPT.md", parser: "markdown-h2" });
  });

  it("skips parse-steps nodes without a string parser", () => {
    expect(
      resolveTaskStepSource(ir([{ id: "p", kind: "parse-steps", config: { artifact: "X.md" } } as any])),
    ).toBeUndefined();
  });
});
