/**
 * U14 (KTD-15) — code node: esbuild compile, child-process execution, the
 * harness contract, result→graph mapping, and failure modes.
 *
 * The child-process spawning tests use tiny inline sources and the real node
 * binary; they are kept to a small focused set (happy/throw/timeout) so the
 * suite stays fast. The result-mapping and customFields/contextPatch/instance
 * scenarios use the injected `spawnRunner` seam (no spawn) for speed + hermetic
 * determinism.
 */
import { describe, expect, it, vi } from "vitest";
import type { CustomFieldRejection, TaskDetail, WorkflowIrNode } from "@fusion/core";

import {
  runCodeNode,
  createCodeNodeRunner,
  compileCodeNodeSource,
  validateCodeNodeSources,
  resolveCodeNodeTimeout,
  CodeNodeError,
  CODE_NODE_MAX_SOURCE_BYTES,
  CODE_NODE_OUTPUT_CAP_BYTES,
  type CodeNodeResult,
} from "../execution/code-node-runner.js";
import { FOREACH_ACTIVE_CONTEXT_KEY } from "../workflows/workflow-node-handlers.js";

const RESULT_BEGIN = "__FUSION_CODE_NODE_RESULT_BEGIN__";
const RESULT_END = "__FUSION_CODE_NODE_RESULT_END__";

function task(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-CODE",
    title: "T",
    description: "d",
    column: "work",
    steps: [],
    customFields: {},
    ...over,
  } as unknown as TaskDetail;
}

function codeNode(source: string, timeoutMs?: number): WorkflowIrNode {
  return { id: "code1", kind: "code", config: { source, ...(timeoutMs ? { timeoutMs } : {}) } };
}

/** A spawnRunner that frames a fixed result, so mapping logic is testable
 *  without spawning a child. */
function fakeSpawn(result: unknown, stderr = "") {
  return async () => ({
    stdout: `${RESULT_BEGIN}${JSON.stringify(result)}${RESULT_END}`,
    stderr,
  });
}

function runnerDeps(over: Partial<Parameters<typeof createCodeNodeRunner>[0]> = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const audits: Array<{ reason: string; detail: string }> = [];
  const deps = {
    resolveCwd: () => process.cwd(),
    readArtifacts: () => ({ "PROMPT.md": "hello" }),
    writeCustomFields: async (_t: TaskDetail, patch: Record<string, unknown>) => {
      writes.push(patch);
      return { ok: true as const };
    },
    audit: (reason: string, detail: string) => audits.push({ reason, detail }),
    ...over,
  };
  return { deps, writes, audits };
}

describe("compileCodeNodeSource (U14)", () => {
  it("compiles valid TS", async () => {
    const out = await compileCodeNodeSource("export default async (ctx: any) => ({ value: ctx.task.id });");
    expect(out).toContain("default");
  });

  it("throws compile-error on a syntax error", async () => {
    await expect(compileCodeNodeSource("export default async (ctx => {")).rejects.toMatchObject({
      reason: "compile-error",
    });
  });

  it("rejects an over-size source defensively", async () => {
    const huge = `export default async () => ({});//${"x".repeat(CODE_NODE_MAX_SOURCE_BYTES)}`;
    await expect(compileCodeNodeSource(huge)).rejects.toMatchObject({ reason: "source-too-large" });
  });
});

describe("resolveCodeNodeTimeout (U14)", () => {
  it("defaults and clamps", () => {
    expect(resolveCodeNodeTimeout(undefined)).toBe(30_000);
    expect(resolveCodeNodeTimeout(500)).toBe(1000);
    expect(resolveCodeNodeTimeout(999_999)).toBe(300_000);
    expect(resolveCodeNodeTimeout(45_000)).toBe(45_000);
  });
});

describe("validateCodeNodeSources (U14, save-time helper)", () => {
  it("returns failures for uncompilable code nodes incl. inside foreach templates", async () => {
    const innerBad: WorkflowIrNode = { id: "inner-bad", kind: "code", config: { source: "syntax ( error" } };
    const ir = {
      nodes: [
        { id: "ok", kind: "code", config: { source: "export default async () => ({});" } } as WorkflowIrNode,
        { id: "fe", kind: "foreach", config: { template: { nodes: [innerBad], edges: [] } } } as WorkflowIrNode,
      ],
    };
    const failures = await validateCodeNodeSources(ir);
    expect(failures).toHaveLength(1);
    expect(failures[0].nodeId).toBe("inner-bad");
  });

  it("returns empty for all-valid code", async () => {
    const ir = { nodes: [codeNode("export default async () => ({ outcome: 'ok' });")] };
    expect(await validateCodeNodeSources(ir)).toEqual([]);
  });

  it("does not crash on a malformed foreach template.nodes (non-array)", async () => {
    const ir = {
      nodes: [
        // `nodes` is an object, not an array — a truthy-but-malformed config.
        { id: "fe", kind: "foreach", config: { template: { nodes: { bogus: true } } } } as unknown as WorkflowIrNode,
      ],
    };
    const failures = await validateCodeNodeSources(ir);
    expect(failures).toEqual([{ nodeId: "fe", error: "foreach template.nodes must be an array" }]);
  });

  it("ignores a foreach with no template nodes", async () => {
    const ir = {
      nodes: [{ id: "fe", kind: "foreach", config: { template: {} } } as unknown as WorkflowIrNode],
    };
    expect(await validateCodeNodeSources(ir)).toEqual([]);
  });
});

describe("createCodeNodeRunner result mapping (U14, seam-injected)", () => {
  it("happy path: returns value + routes success", async () => {
    const { deps } = runnerDeps({ spawnRunner: fakeSpawn({ value: "computed" }) });
    const runner = createCodeNodeRunner(deps);
    const result = await runner(codeNode("x"), task(), {});
    expect(result.outcome).toBe("success");
    expect(result.value).toBe("computed");
  });

  it("outcome string routes outcome:<value>", async () => {
    const { deps } = runnerDeps({ spawnRunner: fakeSpawn({ outcome: "needs-review" }) });
    const runner = createCodeNodeRunner(deps);
    const result = await runner(codeNode("x"), task(), {});
    expect(result.outcome).toBe("success");
    expect(result.value).toBe("needs-review");
  });

  it("contextPatch is merged into the result", async () => {
    const { deps } = runnerDeps({ spawnRunner: fakeSpawn({ contextPatch: { foo: 1, bar: "b" } }) });
    const runner = createCodeNodeRunner(deps);
    const result = await runner(codeNode("x"), task(), {});
    expect(result.contextPatch).toMatchObject({ foo: 1, bar: "b" });
  });

  it("customFields patch goes through the authority", async () => {
    const { deps, writes } = runnerDeps({ spawnRunner: fakeSpawn({ customFields: { priority: "high" } }) });
    const runner = createCodeNodeRunner(deps);
    const result = await runner(codeNode("x"), task(), {});
    expect(result.outcome).toBe("success");
    expect(writes).toEqual([{ priority: "high" }]);
  });

  it("customFields typed rejection → node failure surfacing the rejection", async () => {
    const rejection: CustomFieldRejection = {
      code: "type-mismatch",
      fieldId: "priority",
      detail: "expected number",
    };
    const { deps, audits } = runnerDeps({
      spawnRunner: fakeSpawn({ customFields: { priority: "nope" } }),
      writeCustomFields: async () => ({ ok: false as const, rejection }),
    });
    const runner = createCodeNodeRunner(deps);
    const result = await runner(codeNode("x"), task(), {});
    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("custom-field-rejected");
    expect(result.contextPatch?.["node:code1:rejection"]).toContain("type-mismatch");
    expect(audits.some((a) => a.reason === "custom-field-rejected")).toBe(true);
  });

  it("instance (foreach:active) is surfaced to the ctx assembly", async () => {
    let receivedCtx: unknown;
    const { deps } = runnerDeps({
      spawnRunner: async ({ stdin }) => {
        receivedCtx = JSON.parse(stdin);
        return { stdout: `${RESULT_BEGIN}{}${RESULT_END}`, stderr: "" };
      },
    });
    const runner = createCodeNodeRunner(deps);
    const active = { foreachNodeId: "fe", stepIndex: 2, instanceId: "fe#2" };
    await runner(codeNode("x"), task(), { [FOREACH_ACTIVE_CONTEXT_KEY]: active, other: "ctx" });
    expect((receivedCtx as { instance?: { stepIndex?: number } }).instance?.stepIndex).toBe(2);
    // The reserved key is stripped from the generic context snapshot.
    expect((receivedCtx as { context?: Record<string, unknown> }).context).toEqual({ other: "ctx" });
  });

  it("bad result (no sentinels) → failure", async () => {
    const { deps, audits } = runnerDeps({
      spawnRunner: async () => ({ stdout: "garbage", stderr: "" }),
    });
    const runner = createCodeNodeRunner(deps);
    const result = await runner(codeNode("x"), task(), {});
    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("bad-result");
    expect(audits.some((a) => a.reason === "bad-result")).toBe(true);
  });

  it("captures + caps stderr from a thrown child into the node result", async () => {
    const big = "E".repeat(CODE_NODE_OUTPUT_CAP_BYTES * 2);
    const { deps } = runnerDeps({
      spawnRunner: async () => {
        const err = Object.assign(new Error("child died"), { code: 7, stderr: big });
        throw err;
      },
    });
    const runner = createCodeNodeRunner(deps);
    const result = await runner(codeNode("x"), task(), {});
    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("runtime-throw");
    const captured = String(result.contextPatch?.["node:code1:stderr"]);
    expect(captured.length).toBeLessThan(big.length);
    expect(captured).toContain("[truncated]");
  });
});

describe("runCodeNode real child process (U14, hermetic)", () => {
  it("happy path executes the harness and returns the parsed result", async () => {
    const result: CodeNodeResult = await runCodeNode({
      source: "export default async (ctx) => ({ value: ctx.task.id, outcome: undefined });",
      cwd: process.cwd(),
      ctx: { task: { id: "FN-CODE", title: "T", steps: [], customFields: {} }, context: {}, artifacts: {} },
    });
    expect(result.value).toBe("FN-CODE");
  });

  it("artifacts.read(key) returns pre-read content", async () => {
    const result = await runCodeNode({
      source: "export default async (ctx) => ({ value: ctx.artifacts.read('PROMPT.md') });",
      cwd: process.cwd(),
      ctx: {
        task: { id: "x", title: "T", steps: [], customFields: {} },
        context: {},
        artifacts: { "PROMPT.md": "the-prompt" },
      },
    });
    expect(result.value).toBe("the-prompt");
  });

  it("a runtime throw fails with stderr captured", async () => {
    await expect(
      runCodeNode({
        source: "export default async () => { throw new Error('boom-runtime'); };",
        cwd: process.cwd(),
        ctx: { task: { id: "x", title: "T", steps: [], customFields: {} }, context: {}, artifacts: {} },
      }),
    ).rejects.toMatchObject({ reason: "runtime-throw" });
  });

  it("timeout kills the child and fails with reason timeout", async () => {
    await expect(
      runCodeNode({
        source: "export default async () => { while (true) {} };",
        timeoutMs: 1000,
        cwd: process.cwd(),
        ctx: { task: { id: "x", title: "T", steps: [], customFields: {} }, context: {}, artifacts: {} },
      }),
    ).rejects.toMatchObject({ reason: "timeout" });
  }, 10_000);
});
