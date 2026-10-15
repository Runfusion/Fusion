/*
FNXC:PrMergeability 2026-10-12-03:20 (RUFU-471):
Fixture-only coverage for the PR mergeability classification authority. The motivating
incident is six fabricated `[our-main]` conflict causes in one evening, produced by
reading the DISPLAY field (`mergeStateStatus`, and `DIRTY` arriving through
`mapPrConflictState` -> `mergeStatus.mergeable`) as if it were the conflict verdict.
Every case here therefore asserts the VERDICT (`api.mergeable === "CONFLICTING"`) and the
receipt text, never a presence check on a status string.

No network, no `gh` binary, no `git` spawn, no timers: `gh`/`git` arrive as injected
runner spies and the live board state is encoded as plain fixture data.
*/
import { describe, expect, it, vi } from "vitest";
import {
  PR_MERGEABILITY_GH_FIELDS,
  PR_MERGEABILITY_GH_JSON_FIELDS,
  PrMergeabilityFetchError,
  buildPrMergeabilityReport,
  classifyPrMergeability,
  createMergeTreeProbe,
  fetchPrMergeabilityRecords,
  formatPrMergeabilityReport,
  isPrMergeabilityConflict,
  mergeTreeBaseRefCandidates,
  mergeTreeHeadRefCandidates,
  parseMergeTreeOutput,
  prMergeabilityListArgs,
  prMergeabilityViewArgs,
  requireMergeabilityPrNumber,
  requireMergeabilityRepo,
} from "../merge/pr-mergeability.js";
import type { MergeTreeVerdict, PrMergeabilityRecord } from "../merge/pr-mergeability.js";

function record(overrides: Partial<PrMergeabilityRecord> = {}): PrMergeabilityRecord {
  return {
    number: 1,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "main",
    ...overrides,
  };
}

/**
 * The live `runfusion/fusion` board as measured 2026-10-01 16:25Z (RUFU-468 evidence
 * table). #3619 and #3628 are the ONLY real conflicts; the five `BLOCKED` cards are
 * policy/branch-protection states. A classifier that reports anything but {3619, 3628}
 * for this fixture is the defect this card exists to fix.
 */
const LIVE_BOARD_FIXTURE: PrMergeabilityRecord[] = [
  record({ number: 3619, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
  record({ number: 3624, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
  record({ number: 3626, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
  record({ number: 3627, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
  record({ number: 3628, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
  record({ number: 3630, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
  record({ number: 3632, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
];

const MERGE_STATE_VALUES = ["BLOCKED", "DIRTY", "CLEAN", "UNSTABLE", "UNKNOWN", "BEHIND"];

describe("isPrMergeabilityConflict — the single conflict predicate", () => {
  it("reports GitHub's CONFLICTING as the only conflict", () => {
    expect(isPrMergeabilityConflict({ mergeable: "CONFLICTING" })).toBe(true);
  });

  it("is case-tolerant on the API enum", () => {
    expect(isPrMergeabilityConflict({ mergeable: "conflicting" })).toBe(true);
  });

  it.each([
    ["MERGEABLE", "mergeable"],
    ["UNKNOWN", "mergeable not yet computed"],
    ["", "empty string"],
    [null, "null (mergeable not yet computed)"],
  ])("never reports %s (%s) as a conflict", (mergeable) => {
    expect(isPrMergeabilityConflict({ mergeable })).toBe(false);
  });

  it("does not read a display status as a verdict", () => {
    // `DIRTY` is the display value `mapPrConflictState` produces for a real conflict, and
    // `BLOCKED` is branch protection. Neither is `api.mergeable`, so neither decides.
    expect(isPrMergeabilityConflict({ mergeable: "DIRTY" })).toBe(false);
    expect(isPrMergeabilityConflict({ mergeable: "BLOCKED" })).toBe(false);
  });
});

describe("classifyPrMergeability — mergeStateStatus is never a verdict input", () => {
  it.each(MERGE_STATE_VALUES)("mergeable=MERGEABLE + mergeStateStatus=%s produces no conflict", (mergeStateStatus) => {
    const result = classifyPrMergeability([record({ mergeable: "MERGEABLE", mergeStateStatus })]);
    expect(result.conflicts).toEqual([]);
  });

  it("carries every mergeStateStatus value through the full cross-product without changing the reported set", () => {
    const mergeableOnly = classifyPrMergeability([
      record({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
    ]);
    for (const mergeStateStatus of MERGE_STATE_VALUES) {
      const withStatus = classifyPrMergeability([
        record({ number: 7, mergeable: "MERGEABLE", mergeStateStatus }),
      ]);
      expect(withStatus.conflicts.map((c) => c.number)).toEqual([]);
      expect(withStatus.classified).toBe(mergeableOnly.classified);
    }
  });

  it.each(MERGE_STATE_VALUES)("mergeable=CONFLICTING stays reported with mergeStateStatus=%s", (mergeStateStatus) => {
    const result = classifyPrMergeability([record({ number: 9, mergeable: "CONFLICTING", mergeStateStatus })]);
    expect(result.conflicts.map((c) => c.number)).toEqual([9]);
  });

  it("never reports a null/UNKNOWN mergeable even when the probe claims a conflict", () => {
    const probe: MergeTreeVerdict = { status: "CONFLICTING", conflictedFileCount: 3 };
    for (const mergeable of [null, "UNKNOWN", undefined] as const) {
      const result = classifyPrMergeability([record({ number: 12, mergeable: mergeable ?? null })], {
        12: probe,
      });
      expect(result.conflicts).toEqual([]);
    }
  });

  it("names the PR's own baseRefName as the conflict base", () => {
    const result = classifyPrMergeability([
      record({ number: 4, mergeable: "CONFLICTING", baseRefName: "release/2.1" }),
    ]);
    expect(result.conflicts[0]).toMatchObject({ number: 4, base: "release/2.1", source: "api.mergeable" });
  });

  it("filters non-OPEN records out of the classified set", () => {
    const result = classifyPrMergeability([
      record({ number: 5, state: "MERGED", mergeable: "CONFLICTING" }),
      record({ number: 6, state: "CLOSED", mergeable: "CONFLICTING" }),
      record({ number: 7, state: "OPEN", mergeable: "CONFLICTING" }),
    ]);
    expect(result.classified).toBe(1);
    expect(result.conflicts.map((c) => c.number)).toEqual([7]);
  });

  it("sorts conflicts ascending by PR number", () => {
    const result = classifyPrMergeability([
      record({ number: 3628, mergeable: "CONFLICTING" }),
      record({ number: 3619, mergeable: "CONFLICTING" }),
      record({ number: 4, mergeable: "CONFLICTING" }),
    ]);
    expect(result.conflicts.map((c) => c.number)).toEqual([4, 3619, 3628]);
  });
});

describe("classifyPrMergeability — merge-tree corroboration", () => {
  it("emits a disagreement when api=MERGEABLE but merge-tree=CONFLICTING, without reporting the PR", () => {
    const result = classifyPrMergeability([record({ number: 11, mergeable: "MERGEABLE" })], {
      11: { status: "CONFLICTING", conflictedFileCount: 2 },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.disagreements).toEqual([
      { number: 11, api: "MERGEABLE", mergeTree: "CONFLICTING", base: "main", conflictedFileCount: 2 },
    ]);
  });

  it("keeps an api=CONFLICTING PR reported and adds a disagreement when merge-tree=MERGEABLE", () => {
    const result = classifyPrMergeability([record({ number: 12, mergeable: "CONFLICTING" })], {
      12: { status: "MERGEABLE", conflictedFileCount: 0 },
    });
    expect(result.conflicts.map((c) => c.number)).toEqual([12]);
    expect(result.disagreements.map((d) => [d.number, d.api, d.mergeTree])).toEqual([[12, "CONFLICTING", "MERGEABLE"]]);
  });

  it("treats an UNAVAILABLE probe as missing evidence, not dissent", () => {
    const unavailable: MergeTreeVerdict = {
      status: "UNAVAILABLE",
      conflictedFileCount: null,
      unavailableReason: "no-ref",
    };
    const clean = classifyPrMergeability([record({ number: 13, mergeable: "MERGEABLE" })], { 13: unavailable });
    const conflicting = classifyPrMergeability([record({ number: 14, mergeable: "CONFLICTING" })], {
      14: unavailable,
    });
    expect(clean.disagreements).toEqual([]);
    expect(clean.conflicts).toEqual([]);
    expect(conflicting.disagreements).toEqual([]);
    expect(conflicting.conflicts[0]).toMatchObject({ number: 14, mergeTree: "UNAVAILABLE" });
  });

  it("agrees silently when both sources say CONFLICTING and carry the probe's file count", () => {
    const result = classifyPrMergeability([record({ number: 15, mergeable: "CONFLICTING" })], {
      15: { status: "CONFLICTING", conflictedFileCount: 4 },
    });
    expect(result.disagreements).toEqual([]);
    expect(result.conflicts[0]).toMatchObject({ mergeTree: "CONFLICTING", conflictedFileCount: 4 });
  });
});

describe("formatPrMergeabilityReport — the receipt contract", () => {
  it("renders the live fixture as exactly #3619 and #3628, byte-identically", () => {
    const text = formatPrMergeabilityReport(LIVE_BOARD_FIXTURE, {}, { repo: "runfusion/fusion" });
    expect(text).toBe(
      [
        "MERGEABILITY repo=runfusion/fusion classified=7 conflicts=2",
        "CONFLICT #3619 source=api.mergeable api=CONFLICTING base=main merge-tree=not-probed conflicted_files=unknown merge-state=DIRTY",
        "CONFLICT #3628 source=api.mergeable api=CONFLICTING base=main merge-tree=not-probed conflicted_files=unknown merge-state=DIRTY",
      ].join("\n"),
    );
    expect(text).not.toMatch(/\[our-main\]|\[upstream\]/);
  });

  it("names no cause tag for any mergeStateStatus x mergeable x probe combination", () => {
    const probes: Record<number, MergeTreeVerdict> = {
      1: { status: "CONFLICTING", conflictedFileCount: 2 },
      2: { status: "MERGEABLE", conflictedFileCount: 0 },
      3: { status: "UNAVAILABLE", conflictedFileCount: null, unavailableReason: "no-ref" },
    };
    for (const mergeStateStatus of [...MERGE_STATE_VALUES, null]) {
      for (const mergeable of ["MERGEABLE", "CONFLICTING", "UNKNOWN", null] as const) {
        for (const probeKey of [undefined, 1, 2, 3] as const) {
          const records = [record({ number: 40, mergeable, mergeStateStatus })];
          const probeResults = probeKey === undefined ? {} : { 40: probes[probeKey] };
          const text = formatPrMergeabilityReport(records, probeResults, { repo: "acme/widgets" });
          expect(text).not.toMatch(/\[our-main\]|\[upstream\]/);
        }
      }
    }
  });

  it("emits an explicit DISAGREE line naming both values, and never picks one silently", () => {
    const text = formatPrMergeabilityReport(
      [record({ number: 21, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" })],
      { 21: { status: "CONFLICTING", conflictedFileCount: 3 } },
      { repo: "acme/widgets" },
    );
    expect(text).toContain("DISAGREE: #21 api=MERGEABLE merge-tree=CONFLICTING base=main conflicted_files=3");
    expect(text.split("\n")).toHaveLength(2);
    expect(text.split("\n")[1]).not.toMatch(/^CONFLICT /);
  });

  it("keeps the CONFLICT line for an api conflict the probe denies, with both values on the DISAGREE line", () => {
    const text = formatPrMergeabilityReport(
      [record({ number: 22, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })],
      { 22: { status: "MERGEABLE", conflictedFileCount: 0 } },
      { repo: "acme/widgets" },
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe(
      "CONFLICT #22 source=api.mergeable api=CONFLICTING base=main merge-tree=MERGEABLE conflicted_files=0 merge-state=DIRTY",
    );
    expect(lines[2]).toBe("DISAGREE: #22 api=CONFLICTING merge-tree=MERGEABLE base=main conflicted_files=0");
  });

  it("prints conflicted_files=unknown when no probe ran or the probe produced no count", () => {
    const notProbed = formatPrMergeabilityReport([record({ number: 30, mergeable: "CONFLICTING" })]);
    expect(notProbed).toContain("conflicted_files=unknown");
    const unparseable = formatPrMergeabilityReport(
      [record({ number: 31, mergeable: "CONFLICTING" })],
      { 31: { status: "CONFLICTING", conflictedFileCount: null } },
    );
    expect(unparseable).toContain("merge-tree=CONFLICTING conflicted_files=unknown");
  });

  it("prints merge-state=unknown when mergeStateStatus is null, as evidence only", () => {
    const text = formatPrMergeabilityReport([
      record({ number: 32, mergeable: "CONFLICTING", mergeStateStatus: null }),
    ]);
    expect(text).toContain("merge-state=unknown");
  });

  it("orders receipt lines ascending by PR number with a PR's own DISAGREE after its CONFLICT", () => {
    const text = formatPrMergeabilityReport(
      [
        record({ number: 500, mergeable: "CONFLICTING" }),
        record({ number: 6, mergeable: "MERGEABLE" }),
        record({ number: 7, mergeable: "CONFLICTING" }),
      ],
      {
        6: { status: "CONFLICTING", conflictedFileCount: 1 },
        7: { status: "MERGEABLE", conflictedFileCount: 0 },
        500: { status: "CONFLICTING", conflictedFileCount: 9 },
      },
      { repo: "acme/widgets" },
    );
    const numbers = text
      .split("\n")
      .slice(1)
      .map((line) => Number(line.match(/#(\d+)/)?.[1]));
    expect(numbers).toEqual([6, 7, 7, 500]);
    expect(text.split("\n")[2]).toMatch(/^CONFLICT #7/);
    expect(text.split("\n")[3]).toMatch(/^DISAGREE: #7/);
  });

  it("is byte-identical for identical input and carries no clock or randomness", () => {
    const first = formatPrMergeabilityReport(LIVE_BOARD_FIXTURE, { 3619: { status: "MERGEABLE", conflictedFileCount: 0 } }, { repo: "runfusion/fusion" });
    const second = formatPrMergeabilityReport(LIVE_BOARD_FIXTURE, { 3619: { status: "MERGEABLE", conflictedFileCount: 0 } }, { repo: "runfusion/fusion" });
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|[A-Z]{3} [A-Z][a-z]{2} \d{2}/);
  });

  it("builds a structured report with the same content the text renders", () => {
    const report = buildPrMergeabilityReport(LIVE_BOARD_FIXTURE, {}, { repo: "runfusion/fusion" });
    expect(report.repo).toBe("runfusion/fusion");
    expect(report.classified).toBe(7);
    expect(report.conflicts.map((c) => c.number)).toEqual([3619, 3628]);
    expect(report.disagreements).toEqual([]);
  });
});

describe("parseMergeTreeOutput — exit-code semantics of the dashboard precedent", () => {
  it("maps exit 0 to MERGEABLE even though stdout is non-empty (tree OID)", () => {
    expect(parseMergeTreeOutput(0, "8b1a2c3d4e5f60718293a4b5c6d7e8f901234567\n")).toEqual({
      status: "MERGEABLE",
      conflictedFileCount: 0,
    });
  });

  it("maps exit 1 to CONFLICTING and counts the --name-only path list after the tree OID", () => {
    const stdout = [
      "8b1a2c3d4e5f60718293a4b5c6d7e8f901234567",
      "packages/cli/src/bin.ts",
      "packages/core/src/index.ts",
      "",
      "Information about conflicts",
      "Auto-merging packages/cli/src/bin.ts",
    ].join("\n");
    expect(parseMergeTreeOutput(1, stdout)).toEqual({ status: "CONFLICTING", conflictedFileCount: 2 });
  });

  it("reports a null count rather than zero when exit 1 carried no parseable path list", () => {
    expect(parseMergeTreeOutput(1, "")).toEqual({ status: "CONFLICTING", conflictedFileCount: null });
    expect(parseMergeTreeOutput(1, "8b1a2c3d4e5f60718293a4b5c6d7e8f901234567\n")).toEqual({
      status: "CONFLICTING",
      conflictedFileCount: null,
    });
  });

  it.each([128, 2, 127])("treats exit %i as no verdict, not a conflict", (code) => {
    expect(parseMergeTreeOutput(code, "fatal: not a valid object name")).toEqual({
      status: "UNAVAILABLE",
      conflictedFileCount: null,
      unavailableReason: "git-error",
    });
  });
});

describe("merge-tree ref resolution — offline, no fetch", () => {
  it("lists the PR head ref candidates in priority order", () => {
    expect(mergeTreeHeadRefCandidates(3619)).toEqual([
      "refs/remotes/origin/pull/3619/head",
      "refs/remotes/pr/3619",
    ]);
  });

  it("derives base candidates from the PR's own base, never a hardcoded main", () => {
    expect(mergeTreeBaseRefCandidates("release/2.1")).toEqual([
      "refs/remotes/origin/release/2.1",
      "release/2.1",
    ]);
  });

  it("probes with the resolved head ref and the record's own base ref", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        const ref = args[args.length - 1];
        return { code: ref === "refs/remotes/origin/pull/3619/head" || ref === "refs/remotes/origin/release/2.1" ? 0 : 1, stdout: "" };
      }
      return { code: 1, stdout: "8b1a2c3d4e5f60718293a4b5c6d7e8f901234567\nsrc/a.ts\n" };
    });
    const probe = createMergeTreeProbe(runGit, { cwd: "/repo" });

    await expect(probe(record({ number: 3619, baseRefName: "release/2.1" }))).resolves.toEqual({
      status: "CONFLICTING",
      conflictedFileCount: 1,
    });

    expect(runGit.mock.calls.map((call) => call[0])).toEqual([
      ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/pull/3619/head"],
      ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/release/2.1"],
      ["merge-tree", "--write-tree", "--name-only", "refs/remotes/origin/release/2.1", "refs/remotes/origin/pull/3619/head"],
    ]);
    expect(runGit.mock.calls.every((call) => !call[0].includes("fetch"))).toBe(true);
  });

  it("degrades to UNAVAILABLE(no-ref) when no head ref candidate exists locally, without probing", async () => {
    const runGit = vi.fn(async () => ({ code: 1, stdout: "" }));
    const probe = createMergeTreeProbe(runGit);

    await expect(probe(record({ number: 9999 }))).resolves.toEqual({
      status: "UNAVAILABLE",
      conflictedFileCount: null,
      unavailableReason: "no-ref",
    });
    expect(runGit.mock.calls.map((call) => call[0][0])).toEqual(["rev-parse", "rev-parse"]);
  });

  it("falls back to the second head-ref candidate", async () => {
    const resolvable = new Set(["refs/remotes/pr/42", "refs/remotes/origin/main"]);
    const runGit = vi.fn(async (args: string[]) => {
      const ref = args[args.length - 1];
      if (args[0] === "rev-parse") return { code: resolvable.has(ref) ? 0 : 1, stdout: "" };
      return { code: 0, stdout: "8b1a2c3d4e5f60718293a4b5c6d7e8f901234567\n" };
    });
    await expect(createMergeTreeProbe(runGit)(record({ number: 42 }))).resolves.toMatchObject({
      status: "MERGEABLE",
    });
    const mergeTreeCall = runGit.mock.calls.map((c) => c[0]).find((args) => args[0] === "merge-tree");
    expect(mergeTreeCall).toContain("refs/remotes/pr/42");
  });
});

describe("fetchPrMergeabilityRecords — argv shape and command separation", () => {
  it("exports the gh field list this classifier consumes", () => {
    expect([...PR_MERGEABILITY_GH_FIELDS]).toEqual(["number", "state", "mergeable", "mergeStateStatus", "baseRefName"]);
    expect(PR_MERGEABILITY_GH_JSON_FIELDS).toBe("number,state,mergeable,mergeStateStatus,baseRefName");
  });

  it("fetches each named PR with the exact view argv, in ascending order", async () => {
    const runGhJson = vi.fn(async () => ({
      number: 3619,
      state: "OPEN",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      baseRefName: "main",
    }));
    await expect(
      fetchPrMergeabilityRecords(runGhJson, { repo: "runfusion/fusion", prNumbers: [3628, 3619] }),
    ).resolves.toHaveLength(2);

    expect(runGhJson.mock.calls.map((call) => call[0])).toEqual([
      prMergeabilityViewArgs("runfusion/fusion", 3619),
      prMergeabilityViewArgs("runfusion/fusion", 3628),
    ]);
    expect(runGhJson.mock.calls[0][0]).toEqual([
      "pr",
      "view",
      "3619",
      "--repo",
      "runfusion/fusion",
      "--json",
      PR_MERGEABILITY_GH_JSON_FIELDS,
    ]);
  });

  it("discovers open PR numbers first and then views each one (no gh pr list mergeable reuse)", async () => {
    const runGhJson = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return [{ number: 3624 }, { number: 3619 }];
      return {
        number: Number(args[2]),
        state: "OPEN",
        mergeable: Number(args[2]) === 3619 ? "CONFLICTING" : "MERGEABLE",
        mergeStateStatus: "DIRTY",
        baseRefName: "main",
      };
    });

    const records = await fetchPrMergeabilityRecords(runGhJson, { repo: "runfusion/fusion" });
    expect(runGhJson.mock.calls[0][0]).toEqual(prMergeabilityListArgs("runfusion/fusion"));
    expect(runGhJson.mock.calls[0][0]).toEqual([
      "pr",
      "list",
      "--repo",
      "runfusion/fusion",
      "--state",
      "open",
      "--json",
      "number",
    ]);
    expect(records.map((r) => r.number)).toEqual([3619, 3624]);
    expect(records.filter((r) => isPrMergeabilityConflict(r)).map((r) => r.number)).toEqual([3619]);
  });

  it("drops non-OPEN records returned by gh", async () => {
    const runGhJson = vi.fn(async () => ({
      number: 5,
      state: "MERGED",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      baseRefName: "main",
    }));
    await expect(fetchPrMergeabilityRecords(runGhJson, { repo: "a/b", prNumbers: [5] })).resolves.toEqual([]);
  });

  it("rejects an invalid PR number before any gh argv is built", async () => {
    const runGhJson = vi.fn(async () => ({}));
    await expect(
      fetchPrMergeabilityRecords(runGhJson, { repo: "a/b", prNumbers: ["3619; rm -rf" as unknown as number] }),
    ).rejects.toBeInstanceOf(PrMergeabilityFetchError);
    expect(runGhJson).not.toHaveBeenCalled();
    expect(() => prMergeabilityViewArgs("a/b", 0)).toThrow(PrMergeabilityFetchError);
  });

  it("rejects a malformed repo slug before any gh argv is built", async () => {
    const runGhJson = vi.fn(async () => ({}));
    await expect(fetchPrMergeabilityRecords(runGhJson, { repo: "a/b; echo" })).rejects.toBeInstanceOf(
      PrMergeabilityFetchError,
    );
    expect(runGhJson).not.toHaveBeenCalled();
    expect(() => requireMergeabilityRepo("")).toThrow(PrMergeabilityFetchError);
    expect(requireMergeabilityRepo("runfusion/fusion")).toBe("runfusion/fusion");
  });

  it("fails loudly when gh pr list returns an unexpected shape instead of reporting zero PRs", async () => {
    const runGhJson = vi.fn(async () => ({ unexpected: true }));
    await expect(fetchPrMergeabilityRecords(runGhJson, { repo: "a/b" })).rejects.toThrow(
      "gh pr list returned an unexpected shape",
    );
  });

  it("validates PR numbers as positive integers", () => {
    expect(requireMergeabilityPrNumber("12")).toBe(12);
    for (const bad of [0, -1, 1.5, Number.NaN, "", null, undefined]) {
      expect(() => requireMergeabilityPrNumber(bad as unknown)).toThrow(PrMergeabilityFetchError);
    }
  });
});
