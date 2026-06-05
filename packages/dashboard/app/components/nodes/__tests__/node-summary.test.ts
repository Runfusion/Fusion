import { describe, expect, it } from "vitest";
import { nodeConfigSummary, type NodeSummaryCatalogs } from "../node-summary";
import type { WorkflowFlowNodeData, WorkflowEditorNodeKind } from "../WorkflowNodeTypes";

function node(kind: WorkflowEditorNodeKind, config: Record<string, unknown> = {}): WorkflowFlowNodeData {
  return { kind, label: kind, config };
}

describe("nodeConfigSummary", () => {
  it("model executor → provider/modelId when not in catalog", () => {
    const summary = nodeConfigSummary(
      node("prompt", { executor: "model", modelProvider: "anthropic", modelId: "claude-3" }),
    );
    expect(summary).toBe("anthropic/claude-3");
  });

  it("model executor → display name when resolvable from catalog", () => {
    const catalogs: NodeSummaryCatalogs = {
      models: [{ provider: "anthropic", id: "claude-3", name: "Claude 3 Opus" }],
    };
    const summary = nodeConfigSummary(
      node("prompt", { executor: "model", modelProvider: "anthropic", modelId: "claude-3" }),
      catalogs,
    );
    expect(summary).toBe("Claude 3 Opus");
  });

  it("model executor defaults when executor unset", () => {
    const summary = nodeConfigSummary(node("prompt", { modelProvider: "openai", modelId: "gpt-4" }));
    expect(summary).toBe("openai/gpt-4");
  });

  it("agent executor with catalog → agent name", () => {
    const catalogs: NodeSummaryCatalogs = { agents: [{ id: "a1", name: "Reviewer" }] };
    const summary = nodeConfigSummary(node("prompt", { executor: "agent", agentId: "a1" }), catalogs);
    expect(summary).toBe("Reviewer");
  });

  it("agent executor without catalog → raw id", () => {
    const summary = nodeConfigSummary(node("prompt", { executor: "agent", agentId: "a1" }));
    expect(summary).toBe("a1");
  });

  it("skill executor with catalog → skill name", () => {
    const catalogs: NodeSummaryCatalogs = { skills: [{ id: "s1", name: "deep-research" }] };
    const summary = nodeConfigSummary(
      node("prompt", { executor: "skill", skillName: "deep-research" }),
      catalogs,
    );
    expect(summary).toBe("deep-research");
  });

  it("cli command executor → truncated command", () => {
    const long = "npm run test -- --runInBand --reporter verbose --bail --watch=false";
    const summary = nodeConfigSummary(node("prompt", { executor: "cli", cliMode: "command", cliCommand: long }));
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(40);
    expect(summary.startsWith("npm run test")).toBe(true);
  });

  it("cli command executor → short command untruncated", () => {
    const summary = nodeConfigSummary(node("prompt", { executor: "cli", cliMode: "command", cliCommand: "make build" }));
    expect(summary).toBe("make build");
  });

  it("cli script executor → script name", () => {
    const summary = nodeConfigSummary(node("prompt", { executor: "cli", cliMode: "script", scriptName: "deploy" }));
    expect(summary).toBe("deploy");
  });

  it("prompt with awaitInput → waits for user input", () => {
    const summary = nodeConfigSummary(node("prompt", { awaitInput: true }));
    expect(summary).toBe("Waits for user input");
  });

  it("unconfigured prompt → Not configured", () => {
    const summary = nodeConfigSummary(node("prompt", {}));
    expect(summary).toBe("Not configured");
  });

  it("script node → scriptName", () => {
    const summary = nodeConfigSummary(node("script", { scriptName: "lint" }));
    expect(summary).toBe("lint");
  });

  it("gate node → prompt snippet", () => {
    const summary = nodeConfigSummary(node("gate", { prompt: "Has the PR been reviewed?" }));
    expect(summary).toBe("Has the PR been reviewed?");
  });

  it("gate node without prompt → gate-mode text", () => {
    expect(nodeConfigSummary(node("gate", { gateMode: "gate" }))).toBe("Gate (blocks)");
    expect(nodeConfigSummary(node("gate", { gateMode: "advisory" }))).toBe("Advisory");
  });

  it("hold node → release condition", () => {
    const summary = nodeConfigSummary(node("hold", { release: "timer" }));
    expect(summary).toBe("Release: timer");
  });

  it("join node → quorum mode", () => {
    const summary = nodeConfigSummary(node("join", { mode: { quorum: 3 } }));
    expect(summary).toBe("quorum(3)");
  });

  it("join node → all/any mode", () => {
    expect(nodeConfigSummary(node("join", { mode: "any" }))).toBe("any");
    expect(nodeConfigSummary(node("join", {}))).toBe("all");
  });

  it("foreach node → mode + isolation", () => {
    expect(nodeConfigSummary(node("foreach", { mode: "parallel" }))).toBe("parallel · worktree");
    expect(nodeConfigSummary(node("foreach", { mode: "sequential" }))).toBe("sequential · shared");
  });

  it("step-review node → review type", () => {
    const summary = nodeConfigSummary(node("step-review", { type: "design" }));
    expect(summary).toBe("design review");
  });

  it("parse-steps node → parser + artifact", () => {
    const summary = nodeConfigSummary(node("parse-steps", { parser: "json-steps", artifact: "PLAN.md" }));
    expect(summary).toBe("json-steps · PLAN.md");
  });

  it("code node → first line of source", () => {
    const summary = nodeConfigSummary(node("code", { source: "const x = 1;\nconst y = 2;" }));
    expect(summary).toBe("const x = 1;");
  });

  it("code node without source → TypeScript", () => {
    expect(nodeConfigSummary(node("code", {}))).toBe("TypeScript");
  });

  it("structural nodes → empty summary (no row)", () => {
    for (const kind of ["start", "end", "split", "merge"] as WorkflowEditorNodeKind[]) {
      expect(nodeConfigSummary(node(kind))).toBe("");
    }
  });

  it("uses the provided translate function for structural phrases", () => {
    const t = (key: string) => `T:${key}`;
    expect(nodeConfigSummary(node("prompt", {}), {}, t)).toBe("T:workflowNodes.summaryNotConfigured");
  });
});
