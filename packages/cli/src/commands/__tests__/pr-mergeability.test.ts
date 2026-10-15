/**
 * FNXC:PrMergeability 2026-10-14-23:56:
 * Contract for the schedule-invocable seam RUFU-471 adds for RUFU-468's monitor
 * automation. A `command`/`ai-prompt` workflow step captures one stdout string as its
 * `output`/`report`, so the pins here are the ones a scheduled reader depends on:
 * a successful run writes EXACTLY ONE stdout line holding the whole receipt; the
 * reported set is EXACTLY the requested set; a non-`CONFLICTING` API answer with
 * `mergeStateStatus=BLOCKED`/`BEHIND` produces no conflict line; and no failure path
 * prints a receipt at all (the presence of a `MERGEABILITY` line is what tells the
 * automation the classifier actually ran).
 *
 * Nothing here reaches the network, a real `gh` binary, a real `git` spawn, or a real
 * timer: `gh` JSON arrives through the mocked `@fusion/core/gh-cli` runner and `git`
 * through a mocked `execFile`, so `git merge-tree`'s exit-code-1-means-conflict
 * convention is exercised without a repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gh = vi.hoisted(() => ({
  runGhJsonAsync: vi.fn(async (_args: string[], _opts?: unknown): Promise<unknown> => ({})),
  classifyGhError: vi.fn((err: unknown) => ({ code: "unknown", message: String(err), retryable: false })),
  getGhErrorMessage: vi.fn((err: unknown) => String(err)),
  getCurrentRepo: vi.fn(() => ({ owner: "acme", repo: "widgets" })),
  isGhAuthenticated: vi.fn(() => true),
  isGhAvailable: vi.fn(() => true),
}));

vi.mock("@fusion/core/gh-cli", () => ({
  runGhJsonAsync: gh.runGhJsonAsync,
  classifyGhError: gh.classifyGhError,
  getGhErrorMessage: gh.getGhErrorMessage,
  getCurrentRepo: gh.getCurrentRepo,
  isGhAuthenticated: gh.isGhAuthenticated,
  isGhAvailable: gh.isGhAvailable,
}));

/** Callback-style `execFile` stand-in — the seam `runPrMergeability`'s probe runs on. */
const git = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: git.execFile,
}));

vi.mock("@fusion/engine", () => ({
  releaseHeldTaskByEvent: vi.fn(async () => ({ released: true, toColumn: "done" })),
}));
vi.mock("@fusion/dashboard", () => ({
  generatePrMetadata: vi.fn(),
  GitHubClient: vi.fn(function GitHubClient() {
    return { createPr: vi.fn() };
  }),
}));

import { runPrMergeability } from "../pr.js";

type GhArgs = string[];

/** GitHub's own answer for one PR; `mergeable` is the only conflict authority. */
function prPayload(prNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    number: prNumber,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    baseRefName: "main",
    ...overrides,
  };
}

/** Serve `gh pr view` from a fixture map and refuse `gh pr list` outright. */
function servePrViews(byNumber: Record<number, Record<string, unknown>>) {
  gh.runGhJsonAsync.mockImplementation(async (args: GhArgs) => {
    if (args[0] === "pr" && args[1] === "list") {
      throw new Error("test fixture refused PR discovery (an explicit --prs set must be honoured verbatim)");
    }
    const prNumber = Number(args[2]);
    const payload = byNumber[prNumber];
    if (!payload) throw new Error(`test fixture has no payload for PR #${prNumber}`);
    return payload;
  });
}

/** The PR numbers `gh pr view` was actually asked about, in call order. */
function viewedPrNumbers(): number[] {
  return gh.runGhJsonAsync.mock.calls
    .map((call) => call[0] as string[])
    .filter((args) => args[0] === "pr" && args[1] === "view")
    .map((args) => Number(args[2]));
}

/**
 * Script `git`: `--version` proves the binary resolves, `rev-parse --verify` makes a ref
 * exist, and `merge-tree` answers with an exit code — 0 clean, 1 CONFLICTING.
 */
function scriptGit(mergeTree: (headRef: string) => { code: number; stdout?: string }) {
  git.execFile.mockImplementation(
    (_file: string, args: string[], _options: unknown, callback: (error: unknown, stdout?: string, stderr?: string) => void) => {
      if (args[0] === "--version") {
        callback(null, "git version 2.45.0", "");
        return;
      }
      if (args[0] === "rev-parse") {
        callback(null, "", "");
        return;
      }
      if (args[0] === "merge-tree") {
        const headRef = args[args.length - 1];
        const verdict = mergeTree(headRef);
        if (verdict.code === 0) {
          callback(null, verdict.stdout ?? "", "");
        } else {
          callback(
            Object.assign(new Error(`git ${args[0]} exited ${verdict.code}`), { code: verdict.code, stdout: verdict.stdout ?? "" }),
            verdict.stdout ?? "",
            "",
          );
        }
        return;
      }
      callback(Object.assign(new Error(`unexpected git call: ${args.join(" ")}`), { code: 128 }), "", "");
    },
  );
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const stdout = () => String(logSpy.mock.calls.map((call) => call.join(" ")).join("\n"));
const stderr = () => String(errorSpy.mock.calls.map((call) => call.join(" ")).join("\n"));

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as (code?: number) => never);

  // Every default is re-armed here so one test's `mockReturnValue(false)` cannot leak.
  gh.isGhAvailable.mockReturnValue(true);
  gh.isGhAuthenticated.mockReturnValue(true);
  gh.getCurrentRepo.mockReturnValue({ owner: "acme", repo: "widgets" });
  gh.classifyGhError.mockImplementation((err: unknown) => ({ code: "unknown", message: String(err), retryable: false }));
  gh.getGhErrorMessage.mockImplementation((err: unknown) => String(err));
  gh.runGhJsonAsync.mockImplementation(async (_args: string[]) => ({}));
  git.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: unknown, stdout?: string, stderr?: string) => void) => {
    callback(null, "", "");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("fn pr mergeability", () => {
  it("reports exactly the requested PR set, in ascending order, on one stdout line", async () => {
    servePrViews({
      3619: prPayload(3619, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      3628: prPayload(3628),
    });

    await runPrMergeability({ repo: "acme/widgets", prs: "3628,3619" });

    // The requested set arrives verbatim — both PRs, no discovery pass, in canonical
    // ascending order regardless of the order `--prs` was written in.
    expect(viewedPrNumbers()).toEqual([3619, 3628]);
    expect(gh.runGhJsonAsync.mock.calls.filter((call) => (call[0] as string[])[1] === "list")).toHaveLength(0);

    // One stdout write holds the whole receipt, because the cron step reads one string.
    expect(logSpy).toHaveBeenCalledTimes(1);
    const lines = stdout().split("\n");
    expect(lines[0]).toBe("MERGEABILITY repo=acme/widgets classified=2 conflicts=1");

    // Only the CONFLICTING PR is named, and `mergeStateStatus=BLOCKED` alone never is.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "CONFLICT #3619 source=api.mergeable api=CONFLICTING base=main merge-tree=not-probed conflicted_files=unknown merge-state=DIRTY",
    );
    expect(stdout()).not.toContain("#3628");
  });

  /*
  FNXC:PrMergeability 2026-10-15-00:40:
  Symptom verification through the SHIPPED surface. The live baseline measured
  2026-10-01T14:38Z (repo Runfusion/Fusion, base `main`, 7 OPEN) carried exactly
  #3619 and #3628 as `CONFLICTING`/`DIRTY` and five `MERGEABLE`/`BLOCKED` cards that
  the monitor prompt kept reporting as conflicts with a fabricated `[our-main]` cause.
  The assertion is on the REPORTED SET — the byte-exact receipt lines — never on the
  word CONFLICTING appearing somewhere. #3699 is the synthetic discriminator the live
  fixture cannot supply: a `MERGEABLE` + `DIRTY` card is what proves `mergeStateStatus`
  is never read as a verdict, which the five `BLOCKED` cards alone cannot demonstrate.
  */
  it("symptom check: reports only #3619 and #3628 from the live baseline, never the policy-blocked five", async () => {
    servePrViews({
      3619: prPayload(3619, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      3628: prPayload(3628, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      3624: prPayload(3624),
      3626: prPayload(3626),
      3627: prPayload(3627),
      3630: prPayload(3630),
      3632: prPayload(3632),
      3699: prPayload(3699, { mergeStateStatus: "DIRTY" }),
    });

    await runPrMergeability({ repo: "runfusion/fusion", prs: "3619,3624,3626,3627,3628,3630,3632,3699" });

    // One write, three lines, byte-exact: two real conflicts counted out of eight
    // classified cards.
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(stdout().split("\n")).toEqual([
      "MERGEABILITY repo=runfusion/fusion classified=8 conflicts=2",
      "CONFLICT #3619 source=api.mergeable api=CONFLICTING base=main merge-tree=not-probed conflicted_files=unknown merge-state=DIRTY",
      "CONFLICT #3628 source=api.mergeable api=CONFLICTING base=main merge-tree=not-probed conflicted_files=unknown merge-state=DIRTY",
    ]);

    // The five BLOCKED cards, the DIRTY-but-mergeable discriminator, and the cause tag
    // the old prompt invented appear nowhere in the receipt.
    for (const absent of ["#3624", "#3626", "#3627", "#3630", "#3632", "#3699", "our-main", "upstream"]) {
      expect(stdout()).not.toContain(absent);
    }
  });

  it("prints the structured report instead of the receipt for --json", async () => {
    servePrViews({
      3619: prPayload(3619, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      3628: prPayload(3628),
    });

    await runPrMergeability({ repo: "acme/widgets", prs: "3619,3628", json: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(stdout());
    expect(report).toMatchObject({
      repo: "acme/widgets",
      classified: 2,
      conflicts: [{ number: 3619, source: "api.mergeable", api: "CONFLICTING", mergeTree: "not-probed" }],
      disagreements: [],
    });
    expect(stdout()).not.toContain("MERGEABILITY repo=");
  });

  it("never spawns git unless --merge-tree asks for corroboration", async () => {
    servePrViews({ 3619: prPayload(3619, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) });

    await runPrMergeability({ repo: "acme/widgets", prs: "3619" });

    // Zero spawns, and the receipt says so honestly instead of implying a clean probe.
    expect(git.execFile).not.toHaveBeenCalled();
    expect(stdout()).toContain("merge-tree=not-probed");
  });

  it("corroborates with merge-tree and names a disagreement without inventing a cause", async () => {
    servePrViews({
      3619: prPayload(3619, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      3628: prPayload(3628),
    });
    scriptGit((headRef) =>
      headRef.includes("/pull/3619/")
        ? { code: 1, stdout: "1234567890123456789012345678901234567890\nsrc/a.ts\nsrc/b.ts\n" }
        : { code: 1, stdout: "1234567890123456789012345678901234567890\nsrc/c.ts\n" },
    );

    await runPrMergeability({ repo: "acme/widgets", prs: "3619,3628", mergeTree: true });

    const lines = stdout().split("\n");
    expect(lines[0]).toBe("MERGEABILITY repo=acme/widgets classified=2 conflicts=1");
    expect(lines[1]).toBe(
      "CONFLICT #3619 source=api.mergeable api=CONFLICTING base=main merge-tree=CONFLICTING conflicted_files=2 merge-state=DIRTY",
    );
    // API says MERGEABLE, merge-tree says CONFLICTING: both are printed, no verdict chosen.
    expect(lines[2]).toBe("DISAGREE: #3628 api=MERGEABLE merge-tree=CONFLICTING base=main conflicted_files=1");

    // The RUFU-468 premise: nobody may attribute a cause this classifier cannot prove.
    expect(stdout()).not.toContain("[our-main]");
    expect(stdout()).not.toContain("[upstream]");
  });

  it("resolves the repository from the working directory when --repo is absent", async () => {
    servePrViews({ 3619: prPayload(3619) });

    await runPrMergeability({ prs: "3619" });

    expect(stdout()).toContain("MERGEABILITY repo=acme/widgets");
    expect(gh.runGhJsonAsync.mock.calls[0]?.[0]).toEqual([
      "pr",
      "view",
      "3619",
      "--repo",
      "acme/widgets",
      "--json",
      "number,state,mergeable,mergeStateStatus,baseRefName",
    ]);
  });

  it("exits 1 with the structured gh error and fetches nothing when gh is unavailable", async () => {
    gh.isGhAvailable.mockReturnValue(false);

    await runPrMergeability({ repo: "acme/widgets" });

    expect(stderr()).toContain("GitHub error:");
    expect(stderr()).toContain("gh cli is not available");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(gh.runGhJsonAsync).not.toHaveBeenCalled();
  });

  it("exits 1 with the structured gh error when gh is not authenticated", async () => {
    gh.isGhAuthenticated.mockReturnValue(false);

    await runPrMergeability({ repo: "acme/widgets" });

    expect(stderr()).toContain("GitHub error:");
    expect(stderr()).toContain("not logged into GitHub");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(gh.runGhJsonAsync).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty entry", "3619,,3628", "--prs contains an empty entry"],
    ["a non-numeric entry", "3619,latest", '--prs entry "latest" is not a positive integer'],
    ["a zero", "0", "--prs entry \"0\" is not a positive integer"],
  ])("rejects %s before any gh call", async (_label, prs, expected) => {
    await runPrMergeability({ repo: "acme/widgets", prs });

    expect(stderr()).toContain(expected);
    expect(stderr()).toContain("Usage: fn pr mergeability");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(gh.runGhJsonAsync).not.toHaveBeenCalled();
  });

  it("exits 1 with usage when no repository can be resolved", async () => {
    gh.getCurrentRepo.mockReturnValue(null);

    await runPrMergeability({});

    expect(stderr()).toContain("could not resolve a GitHub repository");
    expect(stderr()).toContain("Usage: fn pr mergeability");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(gh.runGhJsonAsync).not.toHaveBeenCalled();
  });

  it("prints no receipt when the gh fetch is refused", async () => {
    gh.runGhJsonAsync.mockRejectedValue(new Error("gh: HTTP 404 — could not resolve repository"));
    gh.classifyGhError.mockReturnValue({ code: "not-found", message: "repository not found", retryable: false });

    await runPrMergeability({ repo: "acme/missing" });

    expect(stderr()).toContain("GitHub error:");
    expect(stderr()).toContain("repository not found");
    expect(stderr()).not.toContain("MERGEABILITY");
    expect(logSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rethrows an unclassified error instead of relabelling a bug as a gh failure", async () => {
    gh.runGhJsonAsync.mockRejectedValue(new TypeError("cannot read properties of undefined"));

    await expect(runPrMergeability({ repo: "acme/widgets" })).rejects.toThrow(TypeError);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
