// @vitest-environment node

/*
FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-18:35 (RUFU-384):
`fn task reconcile` was the surface where RUFU-365's permanent refusal was most visible: the card declared
zero commits, its Code Review approval was bound to the canonical empty review input, no branch existed, and
every run printed "Cannot reconcile RUFU-365: no commit with Fusion-Task-Id: RUFU-365 … was found on main" —
a sentence describing a proof the card was never going to produce. These tests pin the new success sentence
and, just as hard, that the ordinary refusal sentence SURVIVES: the discharge is added next to the existing
success cases (RUFU-357's workspace discharge stays byte-identical), never turned into a default that prints
success for a card that genuinely has unlanded content.

Only the fence is stubbed, at its construction, so the CLI's own outcome-to-sentence mapping is the subject.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// FNXC:CliTests 2026-11-03-18:35 (RUFU-384): a STATIC import, the same idiom every other CLI command test in
// this folder uses. A dynamic `await import()` inside each case re-resolves the whole command module graph per
// test, which both blows the 5 s default timeout and makes an unrelated unbuilt workspace package fail to resolve.
import { runTaskReconcile } from "../commands/task.js";

const reconcileLandedReviewTask = vi.hoisted(() => vi.fn());
const reconcileManagerCtor = vi.hoisted(() => vi.fn());
const resolveProjectMock = vi.hoisted(() => vi.fn());
const closeProjectStoreMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@fusion/engine", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/engine")>();
  return {
    ...actual,
    // The fence's decisions are its own and covered in engine tests; here only its RESULT reaches the CLI.
    SelfHealingManager: reconcileManagerCtor,
  };
});

vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  closeProjectStore: closeProjectStoreMock,
  createLocalStore: vi.fn(async () => ({})),
  asLocalProjectContext: vi.fn(() => ({
    projectId: "project-1",
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store: {},
  })),
}));

const EXIT_SENTINEL = "process-exit";

let logLines: string[];
let errorLines: string[];

beforeEach(() => {
  logLines = [];
  errorLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw Object.assign(new Error(EXIT_SENTINEL), { exitCode: code });
  }) as typeof process.exit);
  resolveProjectMock.mockResolvedValue({
    projectId: "project-1",
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store: { close: vi.fn(async () => undefined) },
  });
  reconcileManagerCtor.mockImplementation(function (this: Record<string, unknown>) {
    this.reconcileLandedReviewTask = reconcileLandedReviewTask;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  reconcileLandedReviewTask.mockReset();
});

async function runReconcile(id: string): Promise<{ exitCode?: number }> {
  try {
    await runTaskReconcile(id, "current-project");
    return {};
  } catch (error) {
    const err = error as Error & { exitCode?: number };
    if (err?.message === EXIT_SENTINEL) return { exitCode: err.exitCode };
    throw error;
  }
}

describe("fn task reconcile reports the commit-free discharge as success", () => {
  it("prints a Discharged sentence and exits zero for the singular commit-free discharge", async () => {
    reconcileLandedReviewTask.mockResolvedValue({
      outcome: "zero-commit-discharged",
      baseBranch: "main",
      basis: "empty-input-approval",
    });

    const { exitCode } = await runReconcile("RUFU-365");
    const printed = [...logLines, ...errorLines].join("\n");

    expect(exitCode).toBeUndefined();
    expect(logLines.join("\n")).toContain("Discharged RUFU-365");
    expect(logLines.join("\n")).toContain("no commit authored");
    // RUFU-504's rule at the CLI surface: no sha, no merge strategy is claimed for a card that authored neither.
    expect(printed).not.toMatch(/at [0-9a-f]{7,}/);
    expect(printed).not.toContain("via squash");
    expect(errorLines).toEqual([]);
  });

  it("still prints the not-landed refusal for a card that owes a commit", async () => {
    // The guard rail: this is RUFU-365's old output, and it must stay for every card NOT authorized to be commit-free.
    reconcileLandedReviewTask.mockResolvedValue({ outcome: "not-landed", baseBranch: "main" });

    const { exitCode } = await runReconcile("RUFU-365");

    expect(exitCode).toBe(1);
    expect(errorLines.join("\n")).toContain("Cannot reconcile RUFU-365");
    expect(errorLines.join("\n")).toContain("Fusion-Task-Id: RUFU-365");
    expect(logLines.join("\n")).not.toContain("Discharged");
  });

  it("keeps RUFU-357's workspace discharge sentence byte-identical beside the new case", async () => {
    reconcileLandedReviewTask.mockResolvedValue({
      outcome: "workspace-discharged",
      repoCount: 2,
      dischargedCount: 2,
      repos: [
        { repo: ".", basis: "zero-ahead", baseBranch: "main" },
        { repo: "lager-manager", basis: "landed", baseBranch: "main", landedSha: "abcdef1234567890" },
      ],
    });

    const { exitCode } = await runReconcile("SANE-463");

    expect(exitCode).toBeUndefined();
    expect(logLines.join("\n")).toBe(
      "Discharged SANE-463: 2/2 repositories proven commit-free (. zero-ahead on main; lager-manager landed at abcdef12 on main); card moved to complete, no commit authored.",
    );
  });

  it("still prints the ineligible refusal sentence for a card the fence will not touch", async () => {
    reconcileLandedReviewTask.mockResolvedValue({ outcome: "ineligible", reason: "foreign-ownership" });

    const { exitCode } = await runReconcile("RUFU-365");

    expect(exitCode).toBe(1);
    expect(errorLines.join("\n")).toContain("foreign-ownership");
    expect(logLines.join("\n")).not.toContain("Discharged");
  });
});
