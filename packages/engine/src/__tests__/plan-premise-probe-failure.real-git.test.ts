import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { admitTaskToWip } from "../execution/hold-release.js";
import { checkPlanPremises } from "../execution/plan-premise-check.js";
import { TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION } from "../execution/plan-premise-ladder.js";

/*
STAS-301: a probe that FAILED and a probe that ANSWERED "nothing here" used to be the same value —
gitProbe collapsed every throw (non-zero exit, timeout, maxBuffer overflow) into the same `null` a
successful empty output produces. For the absence premise kinds that inversion is silent and
directional: `entry === null` reads as satisfied, so a card whose plan was false released into a
processing column, and the only evidence left on the card claimed the repository had refuted the plan.
These tests attack the inversion where a real release decision hangs on it, and each one ships a
control — the same premise over the same repository with a working probe — so a passing run cannot be
read as "the fixture is simply broken".

Two independent failure mechanisms are exercised, both deterministic:
  - a PATH shim that fails exactly one git subcommand against the evaluated repository (the in-repo
    idiom from merger-commit-association-stats.test.ts), and
  - a content read that overruns the probe's 8 MB maxBuffer, which raises ENOBUFS with no shim at all.
*/

const roots: string[] = [];
const shims: Array<{ restore(): void }> = [];
const FLAG_ON = "export const alphaUpdatesEnabled = true;\n";
const FLAG_OFF = "export const footer = true;\n";
const ALPHA_PRESENT = '{"kind":"text-present","path":"src/App.tsx","literal":"alphaUpdatesEnabled"}';
const ALPHA_ABSENT = '{"kind":"text-absent","path":"src/App.tsx","literal":"alphaUpdatesEnabled"}';
const FILE_ABSENT = '{"kind":"file-absent","path":"src/App.tsx"}';

afterEach(() => {
  while (shims.length > 0) shims.pop()!.restore();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/*
The shim intercepts only engine probes: they are the sole git invocations addressed with `-C <repo>`,
while this file's own helpers and the integration-branch resolver address their repository with `cwd`.
Every other call execs the real binary, so a shimmed run and an unshimmed run differ in one probe.
*/
function failOneProbe(repo: string, subcommand: string): { calls(): string[] } {
  const bin = mkdtempSync(join(tmpdir(), "stas301-git-shim-"));
  roots.push(bin);
  const logPath = join(bin, "probe-calls.log");
  const realGit = execSync("command -v git", { encoding: "utf-8" }).trim();
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
    `if [ "$1" = "-C" ] && [ "$2" = ${JSON.stringify(repo)} ] && [ "$3" = "${subcommand}" ]; then`,
    "  echo 'fatal: shim: injected probe failure' >&2",
    "  exit 128",
    "fi",
    `exec ${realGit} "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  shims.push({
    restore: () => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    },
  });
  return {
    calls: () => {
      try {
        return readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

const ir: WorkflowIr = {
  version: "v2", id: "test", name: "test",
  columns: [
    { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
  ],
  nodes: [], edges: [],
};

/** A real repository, so a premise's truth is a committed git object rather than a mock's belief. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "stas301-probe-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/App.tsx"), FLAG_ON);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "chore: land the flag on main"]);
  return root;
}

function commitOnIntegration(root: string, path: string, content: string, message: string): void {
  writeFileSync(join(root, path), content);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", message], { cwd: root, stdio: "ignore" });
}

function card(over: Partial<Task> & { prompt: string }): Task {
  return {
    id: "STAS-301", title: "planned", description: "planned", column: "todo", status: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    dependencies: [], steps: [], currentStep: 0, log: [],
    ...over,
  } as Task;
}

/** The live release door, so the verdict is measured by the move it authorises, not by its own wording. */
function openDoor(task: Task, root: string) {
  const moveTaskIf = vi.fn(async (_id: string, target: string, predicate: (live: Task) => boolean | Promise<boolean>) => {
    if (!(await predicate(task))) return { task, moved: false };
    task.column = target;
    return { task, moved: true };
  });
  const store = {
    getRootDir: () => root,
    getSettings: vi.fn(async () => ({ maxConcurrent: 3 })),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => unknown) => {
      const patch = await mutate(task) as Record<string, unknown> | undefined;
      if (patch) {
        const { sourceMetadataPatch, ...rest } = patch;
        if (sourceMetadataPatch) task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...(sourceMetadataPatch as object) };
        Object.assign(task, rest);
      }
      return task;
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { task.log.push({ timestamp: new Date().toISOString(), message } as never); }),
    logEntryOnce: vi.fn(async (_id: string, input: { action: string; dedupeKey: string; windowMs: number }) => {
      const cutoff = Date.now() - input.windowMs;
      const dup = task.log.some((entry: { dedupeKey?: string; timestamp?: string }) =>
        entry.dedupeKey === input.dedupeKey && Date.parse(entry.timestamp ?? "") >= cutoff);
      if (dup) return;
      task.log.push({ timestamp: new Date().toISOString(), action: input.action, dedupeKey: input.dedupeKey } as never);
    }),
    moveTaskIf,
    getTask: async () => task,
    getTaskDocument: async () => null,
    upsertTaskDocument: async () => {},
  } as unknown as TaskStore;
  const reserve = vi.fn(() => ({ release: vi.fn() }));
  const allocate = vi.fn(() => join(root, ".wt"));
  const deps = { now: () => Date.now(), reserveSlot: reserve, allocateWorktree: allocate };
  return { store, deps, reserve, allocate };
}

const release = (door: ReturnType<typeof openDoor>, task: Task) =>
  admitTaskToWip(door.store, door.deps, task, "doing", ir, { expectedColumn: "todo" });

const logActions = (task: Task): string[] =>
  (task.log as Array<Record<string, unknown>>).filter((entry) => typeof entry.action === "string").map((entry) => entry.action as string);

describe("a plan premise probe that cannot answer", () => {
  it("does not read a failed existence probe as an absent literal, and holds the card it cannot clear", async () => {
    const root = makeRepo();
    const premise = `## Plan Premises\n\n- ${ALPHA_ABSENT}\n\n## Steps\n`;

    // Control: with a working probe this premise is ANSWERED — the literal is in the file — so the plan
    // is refuted and the card is held. The card below must not fare better for git being unreadable.
    const control = card({ prompt: premise });
    const controlDoor = openDoor(control, root);
    expect(await release(controlDoor, control)).toMatchObject({ released: false, rejection: "plan-premise-stale" });
    expect(control.column).toBe("todo");

    const probe = failOneProbe(root, "ls-tree");
    const held = card({ prompt: premise });
    const heldDoor = openDoor(held, root);
    expect(await checkPlanPremises(heldDoor.store, held)).toMatchObject({ outcome: "unavailable" });
    // Proof the shim was the difference: the probe it was built to break really was attempted.
    expect(probe.calls().some((call) => call.includes("ls-tree"))).toBe(true);

    expect(await release(heldDoor, held)).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(held.column).toBe("todo");
    // An unanswered probe is not a refusal either: no episode, no ladder refusal, no escalation record.
    expect(held.sourceMetadata?.planPremiseRejection).toBeUndefined();
    expect(logActions(held)).not.toContain(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION);
    expect(heldDoor.reserve).not.toHaveBeenCalled();
    expect(heldDoor.allocate).not.toHaveBeenCalled();
  }, 30_000);

  it("does not read a failed existence probe as an absent file, and holds the card it cannot clear", async () => {
    const root = makeRepo();
    const premise = `## Plan Premises\n\n- ${FILE_ABSENT}\n\n## Steps\n`;

    const control = card({ prompt: premise });
    const controlDoor = openDoor(control, root);
    expect(await release(controlDoor, control)).toMatchObject({ released: false, rejection: "plan-premise-stale" });

    const probe = failOneProbe(root, "ls-tree");
    const held = card({ prompt: premise });
    const heldDoor = openDoor(held, root);
    const verdict = await checkPlanPremises(heldDoor.store, held);
    expect(probe.calls().some((call) => call.includes("ls-tree"))).toBe(true);
    expect(verdict).toMatchObject({ outcome: "unavailable" });
    // The falsified-plan payload must not go on asserting a violation git never established.
    expect(JSON.stringify(verdict)).not.toContain("path exists at the evaluated commit");

    expect(await release(heldDoor, held)).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(held.sourceMetadata?.planPremiseRejection).toBeUndefined();
    expect(logActions(held)).not.toContain(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION);
  }, 30_000);

  it("treats an unreadable file content as an unavailable probe, never as a falsified plan", async () => {
    const root = makeRepo();
    const probe = failOneProbe(root, "show");

    // Both content-reading kinds are covered: an unreadable file may neither confirm a literal nor
    // deny one. Today it denies, which is the "card told its plan is false on an unreadable file" bug.
    const present = card({ prompt: `## Plan Premises\n\n- ${ALPHA_PRESENT}\n\n## Steps\n` });
    const presentDoor = openDoor(present, root);
    expect(await checkPlanPremises(presentDoor.store, present)).toMatchObject({ outcome: "unavailable" });
    expect(probe.calls().some((call) => call.includes("show"))).toBe(true);

    const absent = card({ prompt: `## Plan Premises\n\n- ${ALPHA_ABSENT}\n\n## Steps\n` });
    const absentDoor = openDoor(absent, root);
    expect(await checkPlanPremises(absentDoor.store, absent)).toMatchObject({ outcome: "unavailable" });

    expect(await release(presentDoor, present)).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(present.sourceMetadata?.planPremiseRejection).toBeUndefined();
    expect(logActions(present)).not.toContain(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION);
  }, 30_000);

  it("treats a content read that overruns the probe buffer as unavailable, with no shim involved", async () => {
    const root = makeRepo();
    // Past the probe's 8 MB maxBuffer, `git show` fails with ENOBUFS on its own — the ceiling is a real
    // failure mode, and it must not be read as "the literal is not in this file".
    commitOnIntegration(root, "src/Huge.tsx", `const payload = "${"x".repeat(9 * 1024 * 1024)}";\n`, "chore: commit an over-buffer file");
    const task = card({ prompt: `## Plan Premises\n\n- {"kind":"text-present","path":"src/Huge.tsx","literal":"const payload"}\n\n## Steps\n` });
    const opened = openDoor(task, root);
    expect(await checkPlanPremises(opened.store, task)).toMatchObject({ outcome: "unavailable" });
    expect(await release(opened, task)).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(task.sourceMetadata?.planPremiseRejection).toBeUndefined();
  }, 30_000);

  it("does not attribute a falsified premise to the card's own delivery when the attribution probe fails", async () => {
    const root = makeRepo();
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git(["checkout", "-q", "-b", "fusion/stas-301"]);
    commitOnIntegration(root, "src/App.tsx", FLAG_OFF, "feat: retire the alpha flag\n\nFusion-Task-Id: STAS-301");
    git(["checkout", "-q", "main"]);

    // Control: with a working probe, this card's own delivery refuted the premise — evidence recorded,
    // card released. The card below sits on the same repository and may not be called stale.
    const control = card({ prompt: `## Plan Premises\n\n- ${ALPHA_PRESENT}\n\n## Steps\n`, branch: "fusion/stas-301" });
    expect(await release(openDoor(control, root), control)).toMatchObject({ released: true });

    const probe = failOneProbe(root, "log");
    const held = card({ prompt: `## Plan Premises\n\n- ${ALPHA_PRESENT}\n\n## Steps\n`, branch: "fusion/stas-301" });
    const heldDoor = openDoor(held, root);
    const verdict = await checkPlanPremises(heldDoor.store, held);
    expect(probe.calls().some((call) => call.includes("log"))).toBe(true);
    expect(verdict).toMatchObject({ outcome: "unavailable" });
    // A detail git never earned: "the last commit touching this file is absent from this history".
    expect(JSON.stringify(verdict)).not.toContain("absent from this history");
    expect(held.sourceMetadata?.planPremiseRejection).toBeUndefined();
    expect(logActions(held)).not.toContain(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION);
  }, 30_000);

  it("names the probe failure in the identity detail instead of claiming the root is not a repository", async () => {
    const root = makeRepo();
    const probe = failOneProbe(root, "rev-parse");
    const task = card({
      prompt: `## Plan Premises\n\n- ${ALPHA_PRESENT}\n\n## Steps\n`,
      branch: "fusion/ghost-card",
      baseBranch: "ghost/base",
    });
    const opened = openDoor(task, root);
    const verdict = await checkPlanPremises(opened.store, task);
    expect(probe.calls().some((call) => call.includes("rev-parse"))).toBe(true);
    expect(verdict).toMatchObject({ outcome: "unavailable" });
    const detail = "detail" in verdict ? verdict.detail : "";
    expect(detail).toContain("git identity");
    expect(detail).toContain("injected probe failure");
    // The root IS a git database; a probe that could not answer must not be reported as its absence.
    expect(detail).not.toContain("is not a git repository");
    expect(await release(opened, task)).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(task.sourceMetadata?.planPremiseRejection).toBeUndefined();
  }, 30_000);
});
