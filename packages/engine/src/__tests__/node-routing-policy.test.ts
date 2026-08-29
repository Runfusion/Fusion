import { describe, expect, it } from "vitest";
import type { EffectiveNode } from "../project/effective-node.js";
import type { NodeStatus, UnavailableNodePolicy } from "@fusion/core";
import { applyUnavailableNodePolicy } from "../project/node-routing-policy.js";

function effectiveNode(nodeId: string | undefined, source: EffectiveNode["source"]): EffectiveNode {
  return { nodeId, source };
}

describe("applyUnavailableNodePolicy", () => {
  it.each<[
    UnavailableNodePolicy | undefined,
    NodeStatus | undefined
  ]>([
    ["block", "online"],
    ["block", "offline"],
    ["block", "error"],
    ["block", "connecting"],
    ["block", undefined],
    ["fallback-local", "online"],
    ["fallback-local", "offline"],
    ["fallback-local", "error"],
    ["fallback-local", "connecting"],
    ["fallback-local", undefined],
    [undefined, "online"],
    [undefined, "offline"],
    [undefined, "error"],
    [undefined, "connecting"],
    [undefined, undefined],
  ])("always allows local execution (policy=%s, health=%s)", (policy, nodeHealth) => {
    const result = applyUnavailableNodePolicy({
      effectiveNode: effectiveNode(undefined, "local"),
      nodeHealth,
      policy,
    });

    expect(result).toEqual({ allowed: true, fallbackToLocal: false });
  });

  it.each<[NodeStatus | undefined, { allowed: boolean; fallbackToLocal?: boolean; reason?: string }]>([
    ["online", { allowed: true, fallbackToLocal: false }],
    ["offline", { allowed: false, reason: "Node node-1 is offline; policy is block" }],
    ["error", { allowed: false, reason: "Node node-1 is error; policy is block" }],
    ["connecting", { allowed: false, reason: "Node node-1 is connecting; policy is block" }],
    [undefined, { allowed: true, fallbackToLocal: false }],
  ])("applies block policy for status=%s", (nodeHealth, expected) => {
    const result = applyUnavailableNodePolicy({
      effectiveNode: effectiveNode("node-1", "task-override"),
      nodeHealth,
      policy: "block",
    });

    expect(result).toEqual(expected);
  });

  it.each<[NodeStatus | undefined, { allowed: boolean; fallbackToLocal: boolean; reason?: string }]>([
    ["online", { allowed: true, fallbackToLocal: false }],
    ["offline", { allowed: true, fallbackToLocal: true, reason: "Node node-1 is offline; falling back to local per policy" }],
    ["error", { allowed: true, fallbackToLocal: true, reason: "Node node-1 is error; falling back to local per policy" }],
    ["connecting", { allowed: true, fallbackToLocal: true, reason: "Node node-1 is connecting; falling back to local per policy" }],
    [undefined, { allowed: true, fallbackToLocal: false }],
  ])("applies fallback-local policy for status=%s", (nodeHealth, expected) => {
    const result = applyUnavailableNodePolicy({
      effectiveNode: effectiveNode("node-1", "project-default"),
      nodeHealth,
      policy: "fallback-local",
    });

    expect(result).toEqual(expected);
  });

  it.each<[NodeStatus | undefined, { allowed: boolean; fallbackToLocal?: boolean; reason?: string }]>([
    ["online", { allowed: true, fallbackToLocal: false }],
    ["offline", { allowed: false, reason: "Node node-1 is offline; policy is block" }],
    ["error", { allowed: false, reason: "Node node-1 is error; policy is block" }],
    ["connecting", { allowed: false, reason: "Node node-1 is connecting; policy is block" }],
    [undefined, { allowed: true, fallbackToLocal: false }],
  ])("treats undefined policy as block for status=%s", (nodeHealth, expected) => {
    const result = applyUnavailableNodePolicy({
      effectiveNode: effectiveNode("node-1", "task-override"),
      nodeHealth,
      policy: undefined as UnavailableNodePolicy | undefined,
    });

    expect(result).toEqual(expected);
  });
});
