import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  BUILTIN_PR_WORKFLOW_IR,
  BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
  DEFAULT_WORKFLOW_COLUMN_IDS,
  parseWorkflowIr,
  serializeWorkflowIr,
} from "../index.js";

const EXECUTE_NODE_MAX_RETRIES = 2;

function executeNodeConfig(ir = BUILTIN_CODING_WORKFLOW_IR): Record<string, unknown> {
  const executeNodes = ir.nodes.filter((node) => node.id === "execute" && node.config?.seam === "execute");
  expect(executeNodes).toHaveLength(1);
  const config = executeNodes[0].config;
  expect(config).toBeDefined();
  expect(Object.keys(config ?? {})).not.toHaveLength(0);
  return config ?? {};
}

describe("builtin coding workflow ir", () => {
  it("parses and round-trips", () => {
    const parsed = parseWorkflowIr(BUILTIN_CODING_WORKFLOW_IR);
    const reparsed = parseWorkflowIr(serializeWorkflowIr(parsed));
    expect(reparsed).toEqual(parsed);
    // The built-in default workflow is now a v2 graph (columns + placement).
    expect(parsed.version).toBe("v2");
  });

  it("contains exactly one start and one end node", () => {
    const nodes = BUILTIN_CODING_WORKFLOW_IR.nodes;
    expect(nodes.filter((node) => node.kind === "start")).toHaveLength(1);
    expect(nodes.filter((node) => node.kind === "end")).toHaveLength(1);
  });

  it("exposes coding lifecycle seams", () => {
    const seams = BUILTIN_CODING_WORKFLOW_IR.nodes
      .map((node) => String(node.config?.seam ?? ""))
      .filter((seam) => seam.length > 0);
    expect(seams).toEqual(expect.arrayContaining(["execute", "review"]));
    // U6: the `workflow-step` seam was replaced by the browser-verification
    // optional-group; no node declares the legacy seam anymore.
    expect(seams).not.toContain("workflow-step");
    expect(seams).not.toContain("merge");
    expect(seams).not.toContain("triage");
  });

  it("expresses pre-merge browser-verification as a default-off optional-group (U6)", () => {
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((n) => [n.id, n]));
    expect(byId.get("workflow-step")).toBeUndefined();
    const group = byId.get("browser-verification");
    expect(group?.kind).toBe("optional-group");
    expect(group?.config?.name).toBe("Browser Verification");
    expect(group?.config?.defaultOn).toBe(false);
    // execute → browser-verification → review on the success path; failure → end.
    expect(BUILTIN_CODING_WORKFLOW_IR.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "execute", to: "browser-verification", condition: "success" }),
        expect.objectContaining({ from: "browser-verification", to: "review", condition: "success" }),
        expect.objectContaining({ from: "browser-verification", to: "end", condition: "failure" }),
      ]),
    );
    // The legacy optionalSteps declaration is gone (the group replaces it).
    expect("optionalSteps" in BUILTIN_CODING_WORKFLOW_IR).toBe(false);
  });

  it("defines the six legacy columns in legacy order (KTD-1)", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    const ids = BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => c.id);
    expect(ids).toEqual([...DEFAULT_WORKFLOW_COLUMN_IDS]);
    expect(ids).toEqual(["triage", "todo", "in-progress", "in-review", "done", "archived"]);
  });

  it("maps default-workflow traits to columns verbatim (R12)", () => {
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => [c.id, c]));
    const traitsFor = (id: string) => byId.get(id)!.traits.map((t) => t.trait);
    expect(traitsFor("triage")).toEqual(["intake"]);
    expect(traitsFor("todo")).toEqual(["hold", "reset-on-entry"]);
    expect(traitsFor("in-progress")).toEqual(["wip", "abort-on-exit", "timing"]);
    expect(traitsFor("in-review")).toEqual(["merge-blocker", "human-review", "stall-detection", "merge"]);
    expect(traitsFor("done")).toEqual(["complete"]);
    expect(traitsFor("archived")).toEqual(["archived"]);
    // in-progress owns the legacy execution concurrency policy in workflow data:
    // the limit is supplied by the project maxConcurrent setting.
    const wip = byId.get("in-progress")!.traits.find((t) => t.trait === "wip");
    expect(wip?.config).toEqual({ limitSetting: "maxConcurrent", countPending: true });
    // todo's hold is capacity-released (legacy "pull from todo when a slot frees").
    const hold = byId.get("todo")!.traits.find((t) => t.trait === "hold");
    expect(hold?.config?.release).toBe("capacity");
  });

  it("places seam nodes in their columns", () => {
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((n) => [n.id, n]));
    expect(byId.get("execute")?.column).toBe("in-progress");
    // U6: browser-verification optional-group replaces the workflow-step seam.
    expect(byId.get("browser-verification")?.column).toBe("in-progress");
    expect(byId.get("review")?.column).toBe("in-review");
    expect(byId.get("merge-gate")?.column).toBe("in-review");
    expect(byId.get("merge-attempt")?.column).toBe("in-review");
  });

  it("assigns descriptive names to execute/review seam nodes and the browser-verification group", () => {
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((n) => [n.id, n]));
    expect(byId.get("execute")?.config?.name).toBe("Execute");
    expect(byId.get("browser-verification")?.config?.name).toBe("Browser Verification");
    expect(byId.get("review")?.config?.name).toBe("Review");
  });

  it("declares a bounded retry budget only on the execute seam", () => {
    const config = executeNodeConfig();
    expect(config.maxRetries).toBe(EXECUTE_NODE_MAX_RETRIES);
    expect(Number.isInteger(config.maxRetries)).toBe(true);
    expect(config.maxRetries).toBeGreaterThanOrEqual(1);
    expect(config.maxRetries).toBeLessThanOrEqual(10);

    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((n) => [n.id, n]));
    expect(byId.get("browser-verification")?.config?.name).toBe("Browser Verification");
    expect(byId.get("review")?.config?.name).toBe("Review");
    expect(byId.get("review")?.config?.maxRetries).toBeUndefined();
    expect(byId.get("merge-attempt")?.config?.maxReworkCycles).toBe(3);
  });

  it("preserves the execute retry declaration through parse/serialize round-trip", () => {
    const reparsed = parseWorkflowIr(serializeWorkflowIr(BUILTIN_CODING_WORKFLOW_IR));
    const config = executeNodeConfig(reparsed);
    expect(config.maxRetries).toBe(EXECUTE_NODE_MAX_RETRIES);
  });

  it("expresses default merge retry recovery and branch-group policy as built-in nodes", () => {
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((node) => [node.id, node]));
    expect(byId.get("merge-gate")?.kind).toBe("merge-gate");
    expect(byId.get("merge-retry")?.kind).toBe("retry-backoff");
    expect(byId.get("merge-manual-hold")?.kind).toBe("manual-merge-hold");
    expect(byId.get("branch-group-member-integration")?.kind).toBe("branch-group-member-integration");
    expect(byId.get("branch-group-promotion")?.kind).toBe("branch-group-promotion");
    expect(byId.get("merge-attempt")?.kind).toBe("merge-attempt");
    expect(byId.get("recovery-router")?.kind).toBe("recovery-router");
    expect(BUILTIN_CODING_WORKFLOW_IR.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "merge-gate", to: "branch-group-member-integration", condition: "outcome:auto-on" }),
        expect.objectContaining({ from: "merge-gate", to: "merge-manual-hold", condition: "outcome:auto-off" }),
        expect.objectContaining({ from: "merge-attempt", to: "merge-retry", condition: "outcome:transient-failure" }),
      ]),
    );
  });

  it("expresses merge policy regions in stepwise and PR built-ins", () => {
    expect(BUILTIN_STEPWISE_CODING_WORKFLOW_IR.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining([
        "merge-gate",
        "retry-backoff",
        "manual-merge-hold",
        "branch-group-member-integration",
        "branch-group-promotion",
        "merge-attempt",
        "recovery-router",
      ]),
    );
    expect(BUILTIN_PR_WORKFLOW_IR.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(["manual-merge-hold", "pr-merge"]));
    expect(BUILTIN_PR_WORKFLOW_IR.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "gate", to: "manual-merge-hold", condition: "outcome:auto-off" }),
        expect.objectContaining({ from: "manual-merge-hold", to: "pr-merge", condition: "success" }),
      ]),
    );
  });
});
