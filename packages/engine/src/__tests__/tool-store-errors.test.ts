import { describe, expect, it } from "vitest";
import { describeStoreQueryFailure, storeErrorResult, storeWriteFailure } from "../tool-store-errors.js";

/*
FNXC:StoreQueryFailureAttribution 2026-10-16-04:30 (STAS-335):
The board-read failure an agent reported was the entire SELECT and no reason:
`Failed query: select "id","name",… from "project"."agents" where project_id = $1 order by …`.
Drizzle's wrapper keeps the structured facts (`query`, `cause.code`) but its message throws them away
and appends the bound parameters, which are user content. These tests pin both halves of the fix: the
attribution is recovered, and the parameters never reach an agent-visible string.

The fixture below mirrors drizzle-orm 0.45.2 `errors.js` exactly — `constructor(query, params, cause)`,
fields `query`/`params`/`cause`, and the message text that interpolates the parameters. It is a fixture
rather than the class because drizzle-orm is a core dependency and this package must not gain one to
build an error. `describeStoreQueryFailure` reads the fields structurally rather than by `instanceof`,
so the field set is the whole contract, and the last test below pins the fixture's message against the
leak shape it is meant to survive.
*/
class QueryFailureFixture extends Error {
  constructor(readonly query: string, readonly params: unknown[], override cause: unknown) {
    super(`Failed query: ${query}\nparams: ${JSON.stringify(params)}`);
    this.name = "DrizzleQueryError";
  }
}

/** The real wrapper shape, built the way drizzle builds it around a driver error. */
function drizzleFailure(params: unknown[] = ["proj-1", 50]): QueryFailureFixture {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint "agents_pkey"'), {
    code: "23505",
  });
  return new QueryFailureFixture(
    'select "id","name","state" from "project"."agents" where project_id = $1 limit $2',
    params,
    cause,
  );
}

describe("store query failures are attributed without repeating them (STAS-335)", () => {
  it("recovers table, statement and SQLSTATE from a real Drizzle query failure", () => {
    expect(describeStoreQueryFailure(drizzleFailure())).toEqual({
      table: "agents",
      statement: "select",
      sqlState: "23505",
    });
  });

  it("attributes an unqualified statement too, since not every query names a schema", () => {
    const cause = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const failure = new QueryFailureFixture('select "id" from "tasks" where id = $1', ["FN-1"], cause);

    expect(describeStoreQueryFailure(failure)).toEqual({
      table: "tasks",
      statement: "select",
      sqlState: "42P01",
    });
  });

  it("reports nothing for an error that never reached a query", () => {
    expect(describeStoreQueryFailure(new Error("TaskStore boot timed out after 30000ms"))).toEqual({});
  });

  it("keeps the fixture faithful to the wrapper message that leaks parameters", () => {
    /* If this assertion ever breaks, the fixture above no longer models the real error and every
       credential test in this file stops proving anything. */
    expect(drizzleFailure(["proj-1", "leak-canary"]).message).toBe(
      'Failed query: select "id","name","state" from "project"."agents" where project_id = $1 limit $2\n' +
        'params: ["proj-1","leak-canary"]',
    );
  });

  it("names a write's target table and statement", () => {
    const cause = Object.assign(new Error(" deadlock detected"), { code: "40P01" });
    const failure = new QueryFailureFixture(
      'update "project"."tasks" set "status" = $1 where "id" = $2',
      ["in-progress", "FN-9"],
      cause,
    );

    expect(describeStoreQueryFailure(failure)).toEqual({
      table: "tasks",
      statement: "update",
      sqlState: "40P01",
    });
  });
});

describe("a store failure never carries bound parameter values to an agent (STAS-335)", () => {
  /* The parameters are the user's own content — a task description, a token a task stored. The
     wrapper message interpolates them, so credential safety here is a property of what WE print,
     and it has to hold for both the readable text and the structured details. */
  const SECRET = "sk-owner-token-leak-canary";

  it("keeps parameters out of the result text and details", () => {
    const result = storeErrorResult("Task update", drizzleFailure(["proj-1", SECRET]));
    const text = String(result.content[0]?.text);

    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(result.details)).not.toContain(SECRET);
  });

  it("keeps parameters out of the write path as well", () => {
    const result = storeWriteFailure("Task update", drizzleFailure([SECRET]));

    expect(String(result.content[0]?.text)).not.toContain(SECRET);
    expect(JSON.stringify(result.details)).not.toContain(SECRET);
  });

  it("adds the attribution without widening what the message repeats", () => {
    const result = storeErrorResult("Board read", drizzleFailure());
    const text = String(result.content[0]?.text);

    /* The failure keeps its first line — the statement is diagnostics, not a credential — while the
       structured attribution is what makes it sayable which table and which failure class. The
       parameters on the wrapper's second line are the part that must never appear. */
    expect(text).toContain("table=agents");
    expect(text).toContain("sqlState=23505");
    expect(text.split("\n").length).toBe(1);
  });
});

describe("a read failure is distinguishable from a write failure (STAS-335)", () => {
  it("labels a read as a read", () => {
    const result = storeErrorResult("Board read", new Error("connection terminated"));

    expect(result.details).toMatchObject({ code: "STORE_UNAVAILABLE", operation: "read" });
  });

  it("labels a write as a write, so an agent knows the board did not change", () => {
    const result = storeWriteFailure("Task update", new Error("connection terminated"));

    expect(result.details).toMatchObject({ code: "STORE_UNAVAILABLE", operation: "write" });
  });

  it("carries the recovered attribution into details for machine handling", () => {
    const result = storeWriteFailure("Task update", drizzleFailure());

    expect(result.details).toMatchObject({ operation: "write", table: "agents", sqlState: "23505" });
  });
});
