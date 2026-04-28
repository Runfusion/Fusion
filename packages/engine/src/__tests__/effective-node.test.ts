import { describe, expect, it } from "vitest";
import { resolveEffectiveNode } from "../effective-node.js";

describe("resolveEffectiveNode", () => {
  it("uses task override when both task and project default are set", () => {
    expect(resolveEffectiveNode({ nodeId: "node-task" }, { defaultNodeId: "node-project" })).toEqual({
      nodeId: "node-task",
      source: "task-override",
    });
  });

  it("uses project default when task override is not set", () => {
    expect(resolveEffectiveNode({ nodeId: undefined }, { defaultNodeId: "node-project" })).toEqual({
      nodeId: "node-project",
      source: "project-default",
    });
  });

  it("uses local when neither task override nor project default is set", () => {
    expect(resolveEffectiveNode({ nodeId: undefined }, { defaultNodeId: undefined })).toEqual({
      nodeId: undefined,
      source: "local",
    });
  });

  it("treats empty task override as unset and falls through to project default", () => {
    expect(resolveEffectiveNode({ nodeId: "" }, { defaultNodeId: "node-project" })).toEqual({
      nodeId: "node-project",
      source: "project-default",
    });
  });

  it("treats null task nodeId as unset", () => {
    expect(resolveEffectiveNode({ nodeId: null as unknown as string }, { defaultNodeId: "node-project" })).toEqual({
      nodeId: "node-project",
      source: "project-default",
    });
  });

  it("treats empty project default as unset and falls through to local", () => {
    expect(resolveEffectiveNode({ nodeId: undefined }, { defaultNodeId: "" })).toEqual({
      nodeId: undefined,
      source: "local",
    });
  });

  it("treats null project default as unset", () => {
    expect(resolveEffectiveNode({ nodeId: undefined }, { defaultNodeId: null as unknown as string })).toEqual({
      nodeId: undefined,
      source: "local",
    });
  });

  it("uses local when both task and project values are empty", () => {
    expect(resolveEffectiveNode({ nodeId: "" }, { defaultNodeId: "" })).toEqual({
      nodeId: undefined,
      source: "local",
    });
  });

  it("uses task override when set even if project default is empty", () => {
    expect(resolveEffectiveNode({ nodeId: "node-task" }, { defaultNodeId: "" })).toEqual({
      nodeId: "node-task",
      source: "task-override",
    });
  });
});
