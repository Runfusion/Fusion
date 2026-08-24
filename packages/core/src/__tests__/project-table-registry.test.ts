/**
 * FNXC:PgTableRegistry 2026-08-23-16:05:
 * `projectTableNames` drives the PostgreSQL test-harness per-test reset and health compaction.
 * A table declared in the schema but missing from the list is never truncated between tests, so
 * its rows leak forward and make whole-file runs disagree with isolated runs (FN-9059's leaked
 * workspace lease; `current_plan_evidence`'s leaked version counter). Ratchet the two together.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { projectTableNames } from "../postgres/schema/project.js";

describe("project table registry", () => {
  it("registers every table declared in the project schema", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../postgres/schema/project.ts", import.meta.url)),
      "utf8",
    );
    const declared = [...source.matchAll(/projectSchema\.table\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect([...new Set(declared)].filter((name) => !projectTableNames.includes(name as never)).sort()).toEqual([]);
  });

  it("registers no table the project schema does not declare", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../postgres/schema/project.ts", import.meta.url)),
      "utf8",
    );
    const declared = new Set([...source.matchAll(/projectSchema\.table\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!));
    expect(projectTableNames.filter((name) => !declared.has(name)).sort()).toEqual([]);
  });

  /*
  FNXC:PgTableRegistry 2026-08-24-02:12:
  A merge that concatenates both sides' registry tails can list a table twice. TRUNCATE is
  idempotent so tests stay green, but the duplicate is a drift signal that the next omitted
  table will hide behind. One entry per declared table.
  */
  it("registers each project table once", () => {
    expect([...new Set(projectTableNames)]).toEqual([...projectTableNames]);
  });
});
