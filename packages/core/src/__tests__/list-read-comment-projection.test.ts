/*
FNXC:ListReadFieldDeclaration 2026-11-04-19:43 (RUFU-883):
The comment columns were the last heavy payload a list read could not declare away, and the 5 s
metrics sampler is the reader that proved the cost: 18 801 hydrated rows alive against 2 766 live
cards, because every tick re-parsed every card's comment history to read one column. This file is the
SQL-shape guard for the new `comments` member — it asserts the projection the READER SENDS (the
function `readLiveTaskRows` itself calls), not a locally rebuilt map, which is the same reason
`resolveLiveTaskRowProjection` is exported at all (RUFU-615).
*/
import { describe, expect, it } from "vitest";
import {
  resolveLiveTaskRowProjection,
  TASK_SLIM_PROJECTION,
} from "../task-store/async/async-persistence.js";

const COMMENT_COLUMNS = ["comments", "steeringComments"] as const;

/** RUFU-883's premise, stated as an assertion: the undeclared slim read DOES ship comment text. */
describe("undeclared list read (every existing caller, byte-identical)", () => {
  it("returns the shared slim projection object by reference when no fields are declared", () => {
    // Identity, not equality: a caller that does not declare must not receive a rebuilt shape.
    expect(resolveLiveTaskRowProjection({ excludeLog: true })).toBe(TASK_SLIM_PROJECTION);
  });

  it("still selects both comment columns, which is the payload RUFU-883 removes for declared reads", () => {
    const cols = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true }));
    for (const column of COMMENT_COLUMNS) expect(cols).toContain(column);
  });
});

describe("declared empty field set (the 5 s metrics sampler)", () => {
  it("drops both comment columns", () => {
    const cols = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: [] }));
    for (const column of COMMENT_COLUMNS) expect(cols).not.toContain(column);
  });

  it("keeps the narrow lane and identity columns the sampler and every board face need", () => {
    const cols = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: [] }));
    for (const column of ["id", "column", "status", "title", "updatedAt"]) {
      expect(cols).toContain(column);
    }
  });

  it("is a strict subset of the undeclared read — a declaration never invents a row", () => {
    const wide = new Set(Object.keys(TASK_SLIM_PROJECTION));
    const narrow = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: [] }));
    expect(narrow.every((column) => wide.has(column))).toBe(true);
    expect(narrow.length).toBeLessThan(wide.size);
  });

  it("caches per shape, so a hot 5 s read does not rebuild the projection each tick", () => {
    const first = resolveLiveTaskRowProjection({ excludeLog: true, fields: [] });
    const second = resolveLiveTaskRowProjection({ excludeLog: true, fields: [] });
    expect(second).toBe(first);
  });

  it("keeps `excludeLog` winning over a declaration that does not name log", () => {
    const cols = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: [] }));
    expect(cols).not.toContain("log");
  });
});

describe("declared `comments` member (a caller that genuinely reads the comment view)", () => {
  it("selects the pair together, because rowToTask treats them as one comment view", () => {
    const cols = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: ["comments"] }));
    for (const column of COMMENT_COLUMNS) expect(cols).toContain(column);
  });

  it("does not smuggle the other wide fields back in", () => {
    const cols = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: ["comments"] }));
    for (const column of ["description", "summary", "attachments", "workflowStepResults"]) {
      expect(cols).not.toContain(column);
    }
  });
});
