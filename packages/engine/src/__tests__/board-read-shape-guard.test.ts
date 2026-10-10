/*
FNXC:TaskLogProjections 2026-10-10-20:15 (RUFU-615):
PER-CALLER READ-SHAPE GUARD.

RUFU-615 made `excludeLog: true` effective while deriving, which turned the log column from a hidden
constant into a per-call decision. That decision is now load-bearing in BOTH directions:

  * a sweep that reads neither `log` nor a derived badge should not pay for a 31 MB column, and
  * a consumer that pattern-matches log CONTENT must keep receiving it — silently dropping it is the
    same class of bug as a blanked badge, only quieter, because the card still renders.

Each row below therefore states the shape AND its justification, and the retentions are asserted as
hardly as the switches: a future "consistency" edit that adds `excludeLog` to a retaining caller fails
here rather than in production three weeks later. The justifications are the field audits already
written at each call site; this test is what stops them from going stale.
*/

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

/**
 * The options object of the FIRST `listTasks({...})` call at or after `marker`, balanced-brace sliced.
 * Anchoring on a marker rather than a line number keeps the guard alive across edits, and slicing to
 * the closing brace means it asserts ONE call's shape, not the file's general vibe.
 */
function listTasksOptionsAt(file: string, marker: string): string {
  const src = readFileSync(file, "utf8");
  const at = src.indexOf(marker);
  expect(at, `${file} no longer contains the audit text "${marker.slice(0, 60)}…" — the call site moved; `
    + `update this guard in the same change that moves it`).toBeGreaterThan(-1);
  const open = src.indexOf("listTasks({", at);
  expect(open, `no listTasks({ call after the marker in ${file}`).toBeGreaterThan(at);
  let depth = 0;
  let i = open + "listTasks(".length;
  const start = i + 1;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i);
}

describe("board-shaped engine reads carry the read shape their consumer audit justifies", () => {
  /*
  Switched to `excludeLog: true` by measurement. Each entry's marker is a fragment of the FNXC field
  audit at that site, so if someone rewrites the audit without carrying the shape forward, the guard
  fails and says so instead of quietly losing the byte saving.
  */
  const switched: Array<{ file: string; marker: string; label: string }> = [
    { file: SRC("healing/gridlock-detector.ts"), label: "gridlock 5 s sweep", marker: "The 5 s sweep reads persisted fields only" },
    { file: SRC("triage.ts"), label: "planning-admission refresh", marker: "A whole-board read whose only job is to find plannable cards" },
    { file: SRC("triage.ts"), label: "stale-planning sweep", marker: "This sweep filters on `status`, keys by `id`" },
    { file: SRC("triage.ts"), label: "triage poll/discovery", marker: "The engine's hottest board read" },
    { file: SRC("scheduler.ts"), label: "dispatch sweep", marker: "let tasks = await this.store.listTasks" },
    { file: SRC("scheduler.ts"), label: "post-sweep re-read", marker: "tasks = await this.store.listTasks" },
  ];

  for (const { file, marker, label } of switched) {
    it(`${label} reads with no log column and no per-row derivation`, () => {
      const options = listTasksOptionsAt(file, marker);
      expect(options, `${label} must stop selecting the log column`).toContain("excludeLog: true");
      expect(options, `${label} reads no derived badge, so derivation stays off`).toContain("derive: false");
    });
  }

  /*
  Deliberate RETENTIONS. These keep `log` because a downstream consumer reads its CONTENT, not the five
  projected figures. Recorded as an assertion so the retention is a named decision rather than an
  omission someone can "tidy away" — adding `excludeLog` here would trade milliseconds for an auto-heal
  that quietly stops happening.
  */
  const retained: Array<{ file: string; marker: string; label: string }> = [
    {
      file: SRC("project-engine.ts"),
      label: "lane-role read feeding merge eligibility",
      marker: "Stays NON-SLIM deliberately",
    },
  ];

  for (const { file, marker, label } of retained) {
    it(`${label} keeps the log column, by decision`, () => {
      const options = listTasksOptionsAt(file, marker);
      expect(options, `${label} must NOT drop the log — a consumer pattern-matches its content`).not.toContain("excludeLog");
    });
  }

  /*
  Pre-existing shape from RUFU-202, pinned here so the fleet of board-shaped reads has one table rather
  than one convention per file.
  */
  const alreadyCarried: Array<{ file: string; marker: string; label: string }> = [
    { file: SRC("execution/hold-release.ts"), label: "hold-release sweep", marker: "`excludeLog` is the second, bigger half" },
  ];

  for (const { file, marker, label } of alreadyCarried) {
    it(`${label} keeps both opt-outs it was measured into`, () => {
      const options = listTasksOptionsAt(file, marker);
      expect(options).toContain("derive: false");
      expect(options).toContain("excludeLog: true");
      // And it stays non-slim: `slim` would re-parse PROMPT.md per card and could shift release decisions.
      expect(options).not.toContain("slim: true");
    });
  }

  it("the retention reason for merge eligibility really is a log-content read", () => {
    // Guarding the guard: the reason project-engine keeps `log` is `hasAutoHealableVerificationBufferFailure`
    // inspecting task.log. If that inspection is ever replaced by a projection, this assertion is the
    // prompt to revisit the retention rather than leave a stale comment behind.
    const src = readFileSync(SRC("project-engine.ts"), "utf8");
    expect(src).toMatch(/hasAutoHealableVerificationBufferFailure[\s\S]{0,400}task\.log|task\.log[\s\S]{0,400}hasAutoHealableVerificationBufferFailure/);
  });
});
