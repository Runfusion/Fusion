/*
FNXC:ReviewLevelPreset 2026-07-19-11:00 (U8 / R6):
Tombstone test — reviewLevel is a CREATION-TIME preset (it writes enabledWorkflowSteps
at create), so NO engine file may READ `task.reviewLevel` at runtime (R6: zero runtime
reads). This is a cheap source-grep guard: it strips comments (where the field is
mentioned in prose) and asserts no live `<obj>.reviewLevel` READ of a task row remains.
Writes (`taskUpdates.reviewLevel = …`), the creation-input read, and type declarations
are not runtime task-row reads and are excluded by pattern.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const engineSrc = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Strip block and line comments so prose mentions of the field don't false-trip. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("reviewLevel runtime-read tombstone (U8 / R6)", () => {
  const engineFiles = ["executor.ts", "triage.ts"];

  for (const file of engineFiles) {
    it(`${file} does not READ task.reviewLevel at runtime`, () => {
      const code = stripComments(readFileSync(join(engineSrc, file), "utf-8"));
      // A runtime read is `<expr>.reviewLevel` NOT immediately followed by an
      // assignment (`=` that is not `===`/`==`/`!=`/`<=`/`>=`). Writes like
      // `taskUpdates.reviewLevel = …` are allowed (they populate the create-only field).
      const reads = code
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\btask\.reviewLevel\b/.test(line));
      // The ONLY task.reviewLevel occurrences allowed are writes (assignment).
      const badReads = reads.filter(({ line }) => !/\btask\.reviewLevel\s*=(?![=])/.test(line));
      expect(badReads.map((r) => `${file}:${r.n} ${r.line.trim()}`)).toEqual([]);
    });
  }
});
