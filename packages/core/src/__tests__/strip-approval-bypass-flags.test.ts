import { describe, it, expect } from "vitest";
import { stripApprovalBypassFlags } from "../workflow-ir.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

/**
 * P0 security helper: removes the CLI-approval-bypass flags
 * (`cliSkipApproval`/`autoApprove`) from every node config, recursing into
 * foreach `config.template.nodes` at any nesting depth.
 */
describe("stripApprovalBypassFlags", () => {
  it("removes both flags from a top-level node config and reports stripped:true", () => {
    const ir = {
      version: "v1",
      name: "wf",
      nodes: [{ id: "n1", kind: "prompt", config: { cliSkipApproval: true, autoApprove: true, name: "x" } }],
      edges: [],
    } as unknown as WorkflowIr;
    const { ir: out, stripped } = stripApprovalBypassFlags(ir);
    expect(stripped).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (out as any).nodes[0].config;
    expect(cfg.cliSkipApproval).toBeUndefined();
    expect(cfg.autoApprove).toBeUndefined();
    expect(cfg.name).toBe("x"); // unrelated config preserved
  });

  it("strips nested foreach-in-foreach template nodes (arbitrary depth)", () => {
    const ir = {
      version: "v1",
      name: "wf",
      nodes: [
        {
          id: "outer",
          kind: "foreach",
          config: {
            template: {
              nodes: [
                {
                  id: "inner-foreach",
                  kind: "foreach",
                  config: {
                    template: {
                      nodes: [
                        { id: "deep", kind: "step-execute", config: { autoApprove: true } },
                      ],
                      edges: [],
                    },
                  },
                },
              ],
              edges: [],
            },
          },
        },
      ],
      edges: [],
    } as unknown as WorkflowIr;
    const { stripped } = stripApprovalBypassFlags(ir);
    expect(stripped).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deep = (ir as any).nodes[0].config.template.nodes[0].config.template.nodes[0];
    expect(deep.config.autoApprove).toBeUndefined();
  });

  it("returns stripped:false when no flags present", () => {
    const ir = {
      version: "v1",
      name: "wf",
      nodes: [{ id: "n1", kind: "prompt", config: { name: "x" } }],
      edges: [],
    } as unknown as WorkflowIr;
    expect(stripApprovalBypassFlags(ir).stripped).toBe(false);
  });

  it("tolerates a non-array nodes field", () => {
    const ir = { version: "v1", name: "wf" } as unknown as WorkflowIr;
    expect(stripApprovalBypassFlags(ir).stripped).toBe(false);
  });

  it("tolerates non-object entries in nodes (untrusted input)", () => {
    const ir = {
      version: "v1",
      name: "wf",
      nodes: [null, "bogus", 42, { id: "n1", kind: "prompt", config: { cliSkipApproval: true } }],
      edges: [],
    } as unknown as WorkflowIr;
    const { ir: out, stripped } = stripApprovalBypassFlags(ir);
    expect(stripped).toBe(true);
    expect((out as any).nodes[3].config.cliSkipApproval).toBeUndefined();
  });

  it("tolerates non-object entries in nested template.nodes", () => {
    const ir = {
      version: "v1",
      name: "wf",
      nodes: [
        {
          id: "fe",
          kind: "foreach",
          config: {
            template: { nodes: [null, 0, "x", { id: "inner", kind: "prompt", config: { autoApprove: true } }] },
          },
        },
      ],
      edges: [],
    } as unknown as WorkflowIr;
    const { ir: out, stripped } = stripApprovalBypassFlags(ir);
    expect(stripped).toBe(true);
    expect((out as any).nodes[0].config.template.nodes[3].config.autoApprove).toBeUndefined();
  });
});
