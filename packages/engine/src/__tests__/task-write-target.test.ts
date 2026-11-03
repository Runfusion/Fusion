/**
 * RUFU-281 — the shared write-target seam's contract.
 *
 * FNXC:CrossCardWriteAuth 2026-09-23-22:56:
 * Every coordinator write tool must honour an explicit `task_id` or refuse it with a named reason and
 * zero bytes written; silently ignoring a supplied target is the defect (measured: `fn_task_log` with
 * `task_id:"RUFU-275"` returned success and wrote to the session-bound card). These cases pin the two
 * dispositions and the three reason codes at the single seam every tool now routes through, so the
 * per-tool tests only have to prove the tool consults it and performs no store call on a refusal.
 */
import { describe, expect, it } from "vitest";
import { resolveWriteTarget, writeTargetErrorResult } from "../task-write-target.js";

const BOUND = "RUFU-269";
const OTHER = "RUFU-275";

function honour(params: unknown) {
  return resolveWriteTarget(BOUND, params, { toolName: "fn_task_log", disposition: "honours" });
}

function refuse(params: unknown) {
  return resolveWriteTarget(BOUND, params, { toolName: "fn_task_prompt_write", disposition: "refuses" });
}

function refusalOf(result: ReturnType<typeof honour>) {
  if (result.ok) throw new Error(`expected a refusal, resolved ${result.taskId}`);
  return result.refusal;
}

describe("resolveWriteTarget — honours disposition", () => {
  it("defaults to the bound card only when no target was named", () => {
    expect(honour({ message: "hi" })).toEqual({ ok: true, taskId: BOUND, explicit: false });
    expect(honour({ message: "hi", task_id: "   " })).toEqual({ ok: true, taskId: BOUND, explicit: false });
    expect(honour(undefined)).toEqual({ ok: true, taskId: BOUND, explicit: false });
  });

  it("writes the named card for task_id and for its id alias", () => {
    expect(honour({ message: "hi", task_id: OTHER })).toEqual({ ok: true, taskId: OTHER, explicit: true });
    expect(honour({ message: "hi", id: OTHER })).toEqual({ ok: true, taskId: OTHER, explicit: true });
    expect(honour({ message: "hi", task_id: `  ${OTHER}  ` })).toEqual({ ok: true, taskId: OTHER, explicit: true });
  });

  it("accepts a target that names the bound card and marks it explicit", () => {
    expect(honour({ task_id: BOUND })).toEqual({ ok: true, taskId: BOUND, explicit: true });
    expect(honour({ task_id: BOUND, id: BOUND })).toEqual({ ok: true, taskId: BOUND, explicit: true });
  });

  it("refuses a target spelled two ways that disagree instead of guessing", () => {
    const refusal = refusalOf(honour({ task_id: OTHER, id: "FN-1" }));
    expect(refusal.code).toBe("conflicting-targets");
    expect(refusal.message).toContain("conflicting targets");
    expect(refusal.message).toContain("Nothing was written");
  });

  it("refuses an id that cannot name a card before it can reach a path join", () => {
    for (const bad of ["../RUFU-275", "a/RUFU-275", "..", "FN\\-1", `FN-${"x".repeat(300)}`, "FN-\u00001"]) {
      const refusal = refusalOf(honour({ task_id: bad }));
      expect(refusal.code).toBe("unsafe-target-id");
      expect(refusal.message).toContain("Nothing was written");
    }
  });

  it("treats a supplied non-string target as a refusal, not as an absent target", () => {
    for (const bad of [123, { id: OTHER }, [OTHER], true]) {
      const refusal = refusalOf(honour({ task_id: bad }));
      expect(refusal.code).toBe("unsafe-target-id");
      expect(refusal.message).toContain("must be a string");
    }
  });
});

describe("resolveWriteTarget — refuses disposition", () => {
  it("keeps writing the bound card when no target is named", () => {
    expect(refuse({ content: "x" })).toEqual({ ok: true, taskId: BOUND, explicit: false });
  });

  it("refuses a foreign target named by task_id or by the id alias", () => {
    for (const params of [{ content: "x", task_id: OTHER }, { content: "x", id: OTHER }]) {
      const refusal = refusalOf(refuse(params));
      expect(refusal.code).toBe("cross-card-target");
      expect(refusal.requestedTaskId).toBe(OTHER);
      expect(refusal.boundTaskId).toBe(BOUND);
      expect(refusal.message).toContain("no cross-card write authority");
      expect(refusal.message).toContain(`Nothing was written to ${OTHER}`);
    }
  });

  it("allows a target that names this very card", () => {
    expect(refuse({ content: "x", task_id: BOUND })).toEqual({ ok: true, taskId: BOUND, explicit: true });
  });

  it("names the authority refusal when a foreign id is also path-unsafe", () => {
    expect(refusalOf(refuse({ task_id: "../RUFU-275" })).code).toBe("cross-card-target");
  });

  it("reports conflicting spellings before the cross-card decision", () => {
    expect(refusalOf(refuse({ task_id: OTHER, id: "FN-1" })).code).toBe("conflicting-targets");
  });

  it("fails closed on a supplied non-string target", () => {
    expect(refusalOf(refuse({ task_id: 42 })).code).toBe("unsafe-target-id");
  });
});

describe("writeTargetErrorResult", () => {
  it("fails the call closed with ids and a fixed code, never prose from the caller", () => {
    const refusal = refusalOf(refuse({ content: "x", task_id: OTHER }));
    const result = writeTargetErrorResult(refusal);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(refusal.message);
    expect(result.details).toEqual({
      writeTarget: "refused",
      refusalCode: "cross-card-target",
      toolName: "fn_task_prompt_write",
      boundTaskId: BOUND,
      requestedTaskId: OTHER,
    });
  });
});
