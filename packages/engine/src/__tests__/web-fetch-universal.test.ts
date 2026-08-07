import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(file: string): string {
  return readFileSync(join(import.meta.dirname, "..", file), "utf8");
}

describe("fn_web_fetch universal registration", () => {
  it("executor registers fn_web_fetch", () => {
    expect(readSource("executor.ts")).toContain("createWebFetchTool()");
  });

  it("step-session executor registers fn_web_fetch", () => {
    expect(readSource("execution/step-session-executor.ts")).toContain("createWebFetchTool()");
  });

  it("reviewer registers fn_web_fetch", () => {
    // FNXC:WebFetchUniversal 2026-07-01-20:20:
    // FN-7293's inline-fix reviewer refactor extracted the reviewer custom-tool list
    // into a `reviewCustomTools` array (to conditionally append the prompt-write and
    // memory tools), so the old inline `customTools: [createWebFetchTool()` literal no
    // longer appears. The universal-registration invariant is unchanged: the reviewer
    // still registers fn_web_fetch as its first custom tool. Assert the current wiring —
    // createWebFetchTool() heads the reviewCustomTools array and that array is the
    // session's customTools — so this surface stays enumerated without pinning the literal.
    // FNXC:FullSuiteBookkeeping 2026-08-05-00:15: reviewer lives under execution/ after the engine source peel.
    const reviewerSrc = readSource("execution/reviewer.ts");
    expect(reviewerSrc).toMatch(/reviewCustomTools\s*=\s*\[\s*createWebFetchTool\(\),/);
    expect(reviewerSrc).toContain("customTools: reviewCustomTools");
  });

  it("merger registers fn_web_fetch", () => {
    expect(readSource("merger.ts")).toContain("customTools: [reportBuildFailureTool, createWebFetchTool()]");
  });

  it("triage registers fn_web_fetch", () => {
    expect(readSource("triage.ts")).toContain("createWebFetchTool(),");
  });

  it("heartbeat registers fn_web_fetch for task and no-task branches", () => {
    const source = readSource("agent-heartbeat.ts");
    expect(source).toContain("heartbeatTools.push(createWebFetchTool())");
    expect(source).toContain("if (taskId)");
    expect(source).toContain("else {");
  });
});
