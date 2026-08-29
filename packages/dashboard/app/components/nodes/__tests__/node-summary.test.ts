import { BUILTIN_WORKFLOWS } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { bareSkillName, nodeConfigSummary, type NodeSummaryCatalogs } from "../node-summary";
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

  it("model executor with prompt and no pinned model → Default model", () => {
    const summary = nodeConfigSummary(node("prompt", { executor: "model", prompt: "Research prospects" }));
    expect(summary).toBe("Default model");
  });

  it("model executor with name, prompt, and no pinned model → Default model", () => {
    const summary = nodeConfigSummary(
      node("prompt", { executor: "model", name: "Source prospects", prompt: "Research prospects" }),
    );
    expect(summary).toBe("Default model");
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

  it("skill executor → resolves a plugin-namespaced skillName to the catalog's bare name", () => {
    const catalogs: NodeSummaryCatalogs = { skills: [{ id: "p::skills/ce-work/SKILL.md", name: "ce-work" }] };
    const summary = nodeConfigSummary(
      node("prompt", { executor: "skill", skillName: "compound-engineering:ce-work" }),
      catalogs,
    );
    expect(summary).toBe("ce-work");
  });

  it("skill executor → resolves a namespaced skillName against a two-segment catalog name", () => {
    const catalogs: NodeSummaryCatalogs = {
      skills: [{ id: "src::skills/ce-work/SKILL.md", name: "ce-work/SKILL.md" }],
    };
    const summary = nodeConfigSummary(
      node("prompt", { executor: "skill", skillName: "compound-engineering:ce-work" }),
      catalogs,
    );
    expect(summary).toBe("ce-work/SKILL.md");
  });

  it("skill executor → falls back to raw skillName when no catalog entry matches", () => {
    const catalogs: NodeSummaryCatalogs = { skills: [{ id: "s1", name: "something-else" }] };
    const summary = nodeConfigSummary(
      node("prompt", { executor: "skill", skillName: "compound-engineering:ce-work" }),
      catalogs,
    );
    expect(summary).toBe("compound-engineering:ce-work");
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

  it("prompt with seam=execute → Execute (engine)", () => {
    expect(nodeConfigSummary(node("prompt", { seam: "execute" }))).toBe("Execute (engine)");
  });

  it("prompt with seam=review → Review (engine)", () => {
    expect(nodeConfigSummary(node("prompt", { seam: "review" }))).toBe("Review (engine)");
  });

  it("prompt with seam=merge → Merge boundary", () => {
    expect(nodeConfigSummary(node("prompt", { seam: "merge" }))).toBe("Merge boundary");
  });

  it("prompt with seam=planning → Plan (engine)", () => {
    expect(nodeConfigSummary(node("prompt", { seam: "planning" }))).toBe("Plan (engine)");
  });

  it("prompt with seam=step-execute → Step execute (engine)", () => {
    expect(nodeConfigSummary(node("prompt", { seam: "step-execute" }))).toBe("Step execute (engine)");
  });

  it("prompt with unknown seam → Seam: <value>", () => {
    expect(nodeConfigSummary(node("prompt", { seam: "custom-seam" }))).toBe("Seam: custom-seam");
  });

  it("seam node ignores executor/model config — seam takes priority", () => {
    const summary = nodeConfigSummary(
      node("prompt", {
        seam: "execute",
        modelProvider: "openai",
        modelId: "gpt-4",
      }),
    );
    expect(summary).toBe("Execute (engine)");
  });

  it("prompt with awaitInput → waits for user input", () => {
    const summary = nodeConfigSummary(node("prompt", { awaitInput: true }));
    expect(summary).toBe("Waits for user input");
  });

  it("unconfigured prompt → Not configured", () => {
    const summary = nodeConfigSummary(node("prompt", {}));
    expect(summary).toBe("Not configured");
  });

  it("no built-in workflow prompt node summarizes as Not configured", () => {
    // Keep this invariant beside the shared helper because desktop cards and the
    // mobile graph both consume nodeConfigSummary(), so one direct assertion
    // covers both render paths without duplicating UI fixtures.
    const offenders = BUILTIN_WORKFLOWS.flatMap((workflow) =>
      workflow.ir.nodes
        .filter((workflowNode) => workflowNode.kind === "prompt")
        .map((workflowNode) => {
          const summary = nodeConfigSummary(
            node(workflowNode.kind as WorkflowEditorNodeKind, workflowNode.config ?? {}),
          );
          return { workflowId: workflow.id, nodeId: workflowNode.id, summary };
        })
        .filter((entry) => entry.summary === "Not configured"),
    );

    expect(offenders).toEqual([]);
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

  it("loop node → exit condition and iteration budget", () => {
    expect(
      nodeConfigSummary(node("loop", { exitWhen: { type: "output-contains", value: "DONE" }, maxIterations: 5 })),
    ).toBe('until contains "DONE" · 5x');
    expect(
      nodeConfigSummary(node("loop", { exitWhen: { type: "output-matches", pattern: "READY-\\d+" } })),
    ).toBe("until matches /READY-\\d+/ · 3x");
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

describe("bareSkillName", () => {
  it("reduces every skill-name form to the same bare token", () => {
    expect(bareSkillName("compound-engineering:ce-work")).toBe("ce-work");
    expect(bareSkillName("ce-work/SKILL.md")).toBe("ce-work");
    expect(bareSkillName("compound-engineering::skills/ce-work/SKILL.md")).toBe("ce-work");
    expect(bareSkillName("ce-work")).toBe("ce-work");
  });

  it("is case-insensitive and handles empty input", () => {
    expect(bareSkillName("Compound-Engineering:CE-Work")).toBe("ce-work");
    expect(bareSkillName("")).toBe("");
  });
});
