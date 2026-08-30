/*
FNXC:ErrorCauseChain 2026-08-26-08:14:
Drizzle reports a failed query as an error whose MESSAGE is the entire SQL statement and whose CAUSE
is the PostgresError that says what actually broke. A handler reading `error.message` alone therefore
shows an operator a wall of column names and nothing else — the exact shape of a real report from the
task chat, which could not be diagnosed from the report at all.

These tests pin both renderings: outer-to-inner for logs, cause-first for anything an operator reads.
*/
import { describe, expect, it } from "vitest";
import { describeErrorChain, summarizeErrorForOperator } from "../process/error-message.js";

/** The real shape: a giant SQL message wrapping the sentence that matters. */
function drizzleQueryError(): Error {
  const cause = new Error('column "memory_focus" does not exist');
  const sqlText = `select ${Array.from({ length: 40 }, (_, index) => `"column_${index}"`).join(", ")} from "project"."chat_sessions" where …`;
  return new Error(`Failed query: ${sqlText} params: active,task-planner:MULT-022`, { cause });
}

describe("error cause chains", () => {
  it("leads with the reason, not the statement, on an operator surface", () => {
    const summary = summarizeErrorForOperator(drizzleQueryError());

    expect(summary.startsWith('column "memory_focus" does not exist')).toBe(true);
    expect(summary).toContain("while running: Failed query:");
    // The frame is context, not the message: it must not drown the reason.
    expect(summary.length).toBeLessThan(320);
  });

  it("leaves an ordinary error untouched", () => {
    const plain = new Error("Task FN-1 not found");
    expect(summarizeErrorForOperator(plain)).toBe("Task FN-1 not found");
    expect(describeErrorChain(plain)).toBe("Task FN-1 not found");
  });

  it("renders logs outer-to-inner, and stops at a bounded depth", () => {
    const chained = new Error("outer", { cause: new Error("middle", { cause: new Error("root") }) });
    expect(describeErrorChain(chained)).toBe("outer ⇐ caused by: middle ⇐ caused by: root");

    let deep = new Error("depth-0");
    for (let index = 1; index <= 8; index += 1) deep = new Error(`depth-${index}`, { cause: deep });
    expect(describeErrorChain(deep).split("⇐ caused by:")).toHaveLength(5);
  });

  it("truncates a giant frame instead of emitting it whole", () => {
    const giant = new Error("x".repeat(5000), { cause: new Error("real reason") });
    const logged = describeErrorChain(giant, { maxMessageLength: 200 });

    expect(logged).toContain("[truncated]");
    expect(logged).toContain("real reason");
    expect(logged.length).toBeLessThan(500);
  });

  /*
  An application message is deliberate prose someone wrote for an operator, and the API boundary
  reports it while the full chain goes to the log. Only the machine-generated query wrapper is
  inverted — the rule is keyed on that known shape, never on guessing which message reads better.
  */
  it("leaves an application-authored frame in front of its cause", () => {
    const wrapped = new Error("task detail load failed", { cause: new Error("store read failed") });
    expect(summarizeErrorForOperator(wrapped)).toBe("task detail load failed");
  });

  it("does not invent a cause when the chain repeats one message", () => {
    const repeated = new Error("same", { cause: new Error("same") });
    expect(summarizeErrorForOperator(repeated)).toBe("same");
  });

  it("survives a non-Error cause", () => {
    const weird = new Error("Failed query: select 1", { cause: "connection terminated unexpectedly" });
    expect(summarizeErrorForOperator(weird)).toContain("connection terminated unexpectedly");
  });
});
