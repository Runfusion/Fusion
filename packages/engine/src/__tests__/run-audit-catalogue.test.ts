import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_PIPELINE_RUN_AUDIT_EVENTS,
  DELIVERY_PIPELINE_RUN_AUDIT_EVENT_NOTES,
} from "../run-audit/run-audit-catalogue.js";

// Run-audit source file (RUFU-065): the authoritative `DatabaseMutationType` union lives here. We
// read the union declaration verbatim and assert every catalogued event is a quoted literal it
// declares, so the catalogue is a truthful surface even if the array's type were ever bypassed.
const RUN_AUDIT_SOURCE_PATH = fileURLToPath(new URL("../util/run-audit.ts", import.meta.url));
const RUN_AUDIT_DOC_PATH = fileURLToPath(new URL("../../../../docs/run-audit.md", import.meta.url));

const runAuditUnionSource = readFileSync(RUN_AUDIT_SOURCE_PATH, "utf8");

/** Extract every catalogued event name that the union declares as a quoted literal. */
function declaredUnionMembers(): Set<string> {
  const members = new Set<string>();
  // The union body is the `export type DatabaseMutationType =\n  | "name" ...` block. Capture any
  // quoted string literal and keep only those shaped like a run-audit event (contains a ':').
  for (const match of runAuditUnionSource.matchAll(/"([a-z]+:[^\"]+)"/g)) {
    members.add(match[1]);
  }
  return members;
}

/**
 * Parse the documented event names out of `docs/run-audit.md`. Only the three category event tables
 * are read: each lists its event in a leading backticked cell on a table row (`| \`event\` | ... |`).
 */
function documentedEventNames(): Set<string> {
  const doc = readFileSync(RUN_AUDIT_DOC_PATH, "utf8");
  const documented = new Set<string>();
  for (const line of doc.split("\n")) {
    const match = /^\| `([a-z]+:[^\`]+)` \|/.exec(line.trim());
    if (match) documented.add(match[1]);
  }
  return documented;
}

describe("run-audit catalogue", () => {
  it("catalogues only real members of the run-audit DatabaseMutationType union", () => {
    const union = declaredUnionMembers();
    // Compile-time: the array is typed `Readonly<DatabaseMutationType[]>`, so an invented name is a
    // type error here. Runtime: every entry must be a non-empty, union-declared event literal.
    expect(DELIVERY_PIPELINE_RUN_AUDIT_EVENTS.length).toBeGreaterThan(0);
    for (const event of DELIVERY_PIPELINE_RUN_AUDIT_EVENTS) {
      expect(typeof event).toBe("string");
      expect(event.length).toBeGreaterThan(0);
      expect(event, `${event} is not a declared DatabaseMutationType literal`).toMatch(/^[a-z]+:[a-z0-9:-]+$/);
      expect(union.has(event), `${event} is not declared in the run-audit union`).toBe(true);
    }
  });

  it("documents every catalogued event with a notes-map entry", () => {
    for (const event of DELIVERY_PIPELINE_RUN_AUDIT_EVENTS) {
      expect(DELIVERY_PIPELINE_RUN_AUDIT_EVENT_NOTES[event], `missing notes-map entry for ${event}`).toBeTruthy();
    }
    // No notes-map key outside the curated set: catalogued events and notes stay in lock-step.
    expect(Object.keys(DELIVERY_PIPELINE_RUN_AUDIT_EVENT_NOTES).sort()).toEqual(
      [...DELIVERY_PIPELINE_RUN_AUDIT_EVENTS].sort(),
    );
  });

  it("keeps docs/run-audit.md and the catalogue module in lock-step (no drift)", () => {
    const documented = documentedEventNames();
    const catalogued = new Set([...DELIVERY_PIPELINE_RUN_AUDIT_EVENTS]);

    const undocumentedInDoc = [...documented].filter((event) => !catalogued.has(event));
    const missingFromDoc = [...catalogued].filter((event) => !documented.has(event));

    expect(undocumentedInDoc, `doc lists events the catalogue does not: ${undocumentedInDoc.join(", ")}`).toEqual([]);
    expect(missingFromDoc, `catalogue events missing from the doc: ${missingFromDoc.join(", ")}`).toEqual([]);
    expect(documented).toEqual(catalogued);
  });
});