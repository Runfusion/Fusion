import {describe, expect, it} from "vitest";
import {shouldInvalidateEffectiveRoute} from "../mesh/effective-route-invalidation.js";

const route = {
  currentNodeId: "node-old",
  nextNodeId: "node-new",
  currentEffectiveNodeId: "node-old",
  currentEffectiveNodeSource: "task-override",
  checkedOutOnRead: false,
  checkoutBeingSet: false,
  explicitEffectiveNodeIdSupplied: false,
  explicitEffectiveNodeSourceSupplied: false,
};

const noInvalidation = {invalidateNodeId: false, invalidateNodeSource: false};
const bothInvalidated = {
  invalidateNodeId: true,
  invalidateNodeSource: true,
  reason: "node-override-changed",
};

describe("shouldInvalidateEffectiveRoute", () => {
  it("invalidates both fields after a non-checked-out override change", () => {
    expect(shouldInvalidateEffectiveRoute(route)).toEqual(bothInvalidated);
  });

  it("does nothing for unchanged or omitted overrides, including a partial route payload", () => {
    expect(shouldInvalidateEffectiveRoute({...route, nextNodeId: "node-old"})).toEqual(noInvalidation);
    expect(shouldInvalidateEffectiveRoute({...route, nextNodeId: undefined})).toEqual(noInvalidation);
    expect(shouldInvalidateEffectiveRoute({
      ...route,
      nextNodeId: undefined,
      explicitEffectiveNodeSourceSupplied: true,
    })).toEqual(noInvalidation);
  });

  it("normalizes clear, empty, and whitespace overrides like resolveEffectiveNode", () => {
    expect(shouldInvalidateEffectiveRoute({...route, nextNodeId: null})).toEqual(bothInvalidated);
    expect(shouldInvalidateEffectiveRoute({...route, nextNodeId: ""})).toEqual(bothInvalidated);
    expect(shouldInvalidateEffectiveRoute({...route, nextNodeId: "  "})).toEqual(bothInvalidated);
    expect(shouldInvalidateEffectiveRoute({
      ...route,
      currentNodeId: undefined,
      nextNodeId: "   ",
    })).toEqual(noInvalidation);
  });

  it("does not invalidate when no snapshot exists or checkout ownership applies", () => {
    expect(shouldInvalidateEffectiveRoute({
      ...route,
      currentEffectiveNodeId: undefined,
      currentEffectiveNodeSource: undefined,
    })).toEqual(noInvalidation);
    expect(shouldInvalidateEffectiveRoute({...route, checkedOutOnRead: true})).toEqual(noInvalidation);
    expect(shouldInvalidateEffectiveRoute({...route, checkoutBeingSet: true})).toEqual(noInvalidation);
  });

  it("invalidates project-default and local snapshots identically", () => {
    for (const currentEffectiveNodeSource of ["project-default", "local"]) {
      expect(shouldInvalidateEffectiveRoute({...route, currentEffectiveNodeSource})).toEqual(bothInvalidated);
    }
  });

  it("honors complete explicit replacements", () => {
    expect(shouldInvalidateEffectiveRoute({
      ...route,
      explicitEffectiveNodeIdSupplied: true,
      explicitEffectiveNodeSourceSupplied: true,
    })).toEqual(noInvalidation);
  });

  it("invalidates only the unsupplied half of partial replacements", () => {
    expect(shouldInvalidateEffectiveRoute({
      ...route,
      explicitEffectiveNodeIdSupplied: true,
    })).toEqual({
      invalidateNodeId: false,
      invalidateNodeSource: true,
      reason: "node-override-changed",
    });
    expect(shouldInvalidateEffectiveRoute({
      ...route,
      explicitEffectiveNodeSourceSupplied: true,
    })).toEqual({
      invalidateNodeId: true,
      invalidateNodeSource: false,
      reason: "node-override-changed",
    });
  });

  it("treats an explicit null field clear as supplied", () => {
    expect(shouldInvalidateEffectiveRoute({
      ...route,
      explicitEffectiveNodeIdSupplied: true,
    })).toEqual({
      invalidateNodeId: false,
      invalidateNodeSource: true,
      reason: "node-override-changed",
    });
  });
});
