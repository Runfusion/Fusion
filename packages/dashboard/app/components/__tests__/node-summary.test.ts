import { describe, expect, it } from "vitest";

import { nodeConfigSummary } from "../nodes/node-summary";
import type { WorkflowFlowNodeData } from "../nodes/WorkflowNodeTypes";

describe("nodeConfigSummary", () => {
  it("summarizes notify nodes by event", () => {
    const data: WorkflowFlowNodeData = {
      kind: "notify",
      label: "Notify",
      config: { event: "custom-event" },
    };

    expect(nodeConfigSummary(data)).toBe("custom-event");
  });

  it("includes a truncated notify message preview", () => {
    const data: WorkflowFlowNodeData = {
      kind: "notify",
      label: "Notify",
      config: {
        event: "workflow-notify",
        message: "This message is intentionally long enough that the summary should truncate it cleanly.",
      },
    };

    expect(nodeConfigSummary(data)).toBe("workflow-notify · This message is intentionally long enou…");
  });

  // FN-7579
  it("summarizes an ask-user node by its question", () => {
    const data: WorkflowFlowNodeData = {
      kind: "ask-user",
      label: "Ask user question",
      config: { question: "Anything to refine before we finish?" },
    };

    expect(nodeConfigSummary(data)).toBe("Anything to refine before we finish?");
  });

  it("falls back to the default prompt summary when an ask-user node has no question", () => {
    const data: WorkflowFlowNodeData = { kind: "ask-user", label: "Ask user question", config: {} };

    expect(nodeConfigSummary(data)).toBe("Waits for user input");
  });

  it("summarizes an unconditional exit-gate", () => {
    const data: WorkflowFlowNodeData = { kind: "exit-gate", label: "Exit gate", config: {} };

    expect(nodeConfigSummary(data)).toBe("Always exits");
  });

  it("summarizes a conditional exit-gate (output-contains)", () => {
    const data: WorkflowFlowNodeData = {
      kind: "exit-gate",
      label: "Exit gate",
      config: { condition: { type: "output-contains", nodeId: "ask", value: "looks good" } },
    };

    expect(nodeConfigSummary(data)).toBe('Exits when contains "looks good"');
  });

  it("summarizes a conditional exit-gate (output-matches)", () => {
    const data: WorkflowFlowNodeData = {
      kind: "exit-gate",
      label: "Exit gate",
      config: { condition: { type: "output-matches", nodeId: "ask", pattern: "approve(d)?" } },
    };

    expect(nodeConfigSummary(data)).toBe("Exits when matches /approve(d)?/");
  });
});
