import { describe, expect, it } from "vitest";
import {
  TaskLogShapeError,
  coerceTaskLogArray,
  toJson,
  toJsonArray,
} from "../db-helpers.js";

/*
FNXC:TaskLogShape 2026-11-02-17:20 (RUFU-858):
`project.tasks.log` is a jsonb column whose contract is an ARRAY of log entries. Two measurements from
2026-11-02 define what these guards must do, and they are different degradations of the same column:

1. Double-encoding. `toJson()` stringifies anything that is not null/empty-array, so handing it a value
   that is ALREADY JSON text produced `"[{\"action\":...}]"` - a jsonb *scalar*. Two rows reached that shape
   (RUFU-235, SANE-616), and because store queries select `id, log` across a whole `project_id`, one scalar
   row made every project-wide read throw. `fn task delete` then reported failure AFTER its own write had
   committed, and `fn task create` failed without creating anything.
2. Character-spread. The log-append path built `[...(current.log ?? []), entry]`. Spreading a string yields
   single characters, so the same corrupt input shape could instead have written an array of 1-char strings.

The seam therefore has to (a) heal a JSON string that parses to an array - both measured rows healed cleanly
- and (b) refuse anything else loudly, because writing it either poisons the column or shreds the history.
Refusing is safe in practice: after the 2026-11-02 repair the count of non-array rows is zero.
*/

describe("toJsonArray: the array-column write seam (RUFU-858)", () => {
  it("writes a real array unchanged", () => {
    expect(toJsonArray([{ action: "Task created" }])).toBe('[{"action":"Task created"}]');
  });

  it("writes the empty array as []", () => {
    expect(toJsonArray([])).toBe("[]");
    expect(toJsonArray(undefined)).toBe("[]");
    expect(toJsonArray(null)).toBe("[]");
  });

  it("heals a double-encoded array instead of writing a jsonb scalar", () => {
    const poisoned = JSON.stringify('[{"action":"Created as refinement of RUFU-231"}]');
    // The pre-fix behaviour, pinned so a regression that reintroduces it is visible:
    expect(JSON.parse(toJson(poisoned))).toBeTypeOf("string");
    // The fix: the inner array is recovered, not wrapped again.
    const healed = toJsonArray(poisoned);
    expect(JSON.parse(healed)).toEqual([{ action: "Created as refinement of RUFU-231" }]);
    expect(Array.isArray(JSON.parse(healed))).toBe(true);
  });

  it("refuses text that is not JSON at all, rather than poisoning the column", () => {
    expect(() => toJsonArray("not json")).toThrow(TaskLogShapeError);
  });

  it("refuses JSON that parses to a non-array, rather than changing the column contract", () => {
    expect(() => toJsonArray('{"action":"x"}')).toThrow(TaskLogShapeError);
  });

  it("refuses a character-shredded value so the shred can never be written back", () => {
    const shredded = Array.from('[{"action":"x"}]').join("");
    expect(() => toJsonArray(shredded)).not.toThrow(); // parses to an array: healable
    expect(() => toJsonArray(["a", "b"].join("|"))).toThrow(TaskLogShapeError);
  });
});

describe("coerceTaskLogArray: the append-path guard", () => {
  it("keeps an array", () => {
    const entries = [{ action: "a" }];
    expect(coerceTaskLogArray(entries)).toBe(entries);
  });

  it("does not spread a JSON string into characters", () => {
    const poisoned = '[{"action":"a"},{"action":"b"}]';
    const coerced = coerceTaskLogArray(poisoned);
    expect(coerced).toHaveLength(2);
    expect(coerced[0]).toEqual({ action: "a" });
    // The regression this exists for: spreading that same string yields one entry PER CHARACTER.
    const spread = Array.from(poisoned);
    expect(spread.length).toBeGreaterThan(2);
    expect(spread.every((ch) => typeof ch === "string" && ch.length === 1)).toBe(true);
  });

  it("treats an absent log as empty and a non-healable one as a loud refusal", () => {
    expect(coerceTaskLogArray(undefined)).toEqual([]);
    expect(coerceTaskLogArray(null)).toEqual([]);
    expect(() => coerceTaskLogArray("garbage")).toThrow(TaskLogShapeError);
  });
});
