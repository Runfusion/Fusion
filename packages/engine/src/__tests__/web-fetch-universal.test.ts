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
    expect(readSource("step-session-executor.ts")).toContain("createWebFetchTool()");
  });

  it("reviewer registers fn_web_fetch", () => {
    expect(readSource("reviewer.ts")).toContain("customTools: [createWebFetchTool()");
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
