import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION } from "../execution/plan-premise-ladder.js";

/*
STAS-301 T1..T5: a probe that FAILED is not a probe that answered "nothing here".
The defect (plan-premise-tree.ts `gitProbe`/`gitLine`, shipped by STAS-282): every git failure — a locked
index, the 20 s timeout, an over-buffered read, a failed spawn — came back as the same `null` as a
successful-but-empty `ls-tree`, so `text-absent` and `file-absent` premises resolved `satisfied: true`,
the release door opened, and an executor was dispatched to re-implement work that was already delivered.

Each test installs a `git` shim that fails ONE probe inside one repository and delegates every other
invocation — the whole identity ladder, `merge-base`, the fixture's own git — to the real binary resolved
before PATH was modified. Every test is paired with a control on the identical fixture without the shim,
so the only variable is the probe's answer: this suite fails if the fix launders failure into absence,
AND if it launders genuine absence into a hold.

The premise under test is that premises evaluate against the CARD's own repository, so no engine-repo
path appears in any fixture: a premise naming one would be the self-refuting-premise class STAS-264
exists to report.
*/

const roots: string[] = [];
const envKeys = ["PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"];
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of savedEnv.entries()) {
    // An originally-absent key must be deleted, not assigned — assigning undefined yields the string "undefined".
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const ir: WorkflowIr = {
  version: "v2", id: "probe-door", name: "Probe Door",
  columns: [
    { id: "todo", name: "To Do", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
  ],
  nodes: [], edges: [],
};

const git = (repo: string, args: string[]): void => {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
};

/** A real repository, so a premise's truth is a committed git object rather than a mock's belief. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "stas301-probe-"));
  roots.push(root);
  // The probe itself must never be what makes a probe fail: this machine's global/system git config could
  // carry aliases, hooks or fsmonitor helpers. Pin it to the empty set.
  const gitconfig = join(root, "empty.gitconfig");
  writeFileSync(gitconfig, "");
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_SYSTEM = gitconfig;
  git(root, ["init", "-q", "-b", "main", "."]);
  git(root, ["config", "user.email", "stas301@example.com"]);
  git(root, ["config", "user.name", "STAS-301 Fixture"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

/** A premise's truth is the COMMITTED content, so the fixture stages and commits what it just wrote. */
function commitTree(root: string, message = "chore: land the fixture file"): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", message]);
}

/** A card whose authoritative prompt carries EXACTLY these premises, in this order. */
const premisePrompt = (premises: string[]): string =>
  `# Task\n\n## Plan Premises\n\n${premises.map((one) => `- ${one}`).join("\n")}\n\n## Steps\n\n### Step 0: Preflight\n`;

function makeCard(prompt: string, sourceMetadata: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): Task {
  return {
    id: "STAS-301", title: "premise probe fixture", description: "planned", column: "todo", status: null,
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    prompt, sourceMetadata: { ...sourceMetadata }, baseBranch: "main",
    ...fields,
  } as Task;
}

/** The store seams the premise gate and the release door read, with the real store's key-preserving
 *  sourceMetadataPatch merge and its once-seam dedupe, so an episode is observable if one were written. */
function makeStore(root: string, task: Task): TaskStore {
  const entries = () => task.log as unknown[] as Array<{ action?: string; dedupeKey?: string; timestamp?: string }>;
  const moveTaskIf = async (_id: string, target: string, predicate: (live: Task) => boolean | Promise<boolean>, options?: { allocateWorktree?: (names: Set<string>) => string | null }) => {
    if (!(await predicate(task))) return { task, moved: false };
    options?.allocateWorktree?.(new Set());
    task.column = target;
    return { task, moved: true };
  };
  return {
    getRootDir: () => root,
    getSettings: async () => ({ maxConcurrent: 3 }),
    updateTaskAtomic: async (_id: string, mutate: (live: Task) => unknown) => {
      const patch = await mutate(task);
      if (patch) {
        const { sourceMetadataPatch, ...rest } = patch as Record<string, unknown> & { sourceMetadataPatch?: Record<string, unknown> };
        if (sourceMetadataPatch) task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...sourceMetadataPatch };
        Object.assign(task, rest);
      }
      return task;
    },
    logEntry: async (_id: string, message: string) => {
      entries().push({ timestamp: new Date().toISOString(), message } as never);
    },
    logEntryOnce: async (_id: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) => {
      const cutoff = Date.now() - input.windowMs;
      if (entries().some((entry) => entry.dedupeKey === input.dedupeKey && Date.parse(entry.timestamp ?? "") >= cutoff)) return;
      entries().push({ timestamp: new Date().toISOString(), action: input.action, outcome: input.outcome, dedupeKey: input.dedupeKey } as never);
    },
    moveTaskIf,
  } as unknown as TaskStore;
}

const logActions = (task: Task): string[] =>
  (task.log as unknown[] as Array<{ action?: string }>).map((entry) => entry.action ?? "");

/** Run the release door's premise check over `premises` as measured against the card's own repository. */
async function checkPremises(root: string, premises: string[], fields: Record<string, unknown> = {}) {
  const task = makeCard(premisePrompt(premises), {}, fields);
  return await (await import("../execution/plan-premise-check.js")).checkPlanPremises(makeStore(root, task), task);
}

/** The premise check plus the door it gates: a verdict decides nothing on its own, the release does. */
async function doorRelease(root: string, premises: string[], sourceMetadata: Record<string, unknown> = {}) {
  const task = makeCard(premisePrompt(premises), sourceMetadata);
  const store = makeStore(root, task);
  const reserved: string[] = [];
  const deps = {
    now: Date.now,
    reserveSlot: () => { reserved.push(task.id); return { release: () => undefined }; },
    allocateWorktree: () => join(root, "allocated-worktree"),
  };
  const result = await (await import("../execution/hold-release.js")).admitTaskToWip(store, deps, task, "doing", ir);
  return { result, reserved, task };
}

/*
The shim: fails exactly the engine's own probe (`git -C <repo> <subcommand> …`), optionally narrowed to one
path, with the production index.lock contention message from the defect report, and logs every call it
saw — so a test can prove the probe it claims to have broken really was reached. Engine probes are the
only git invocations addressed with `-C <repo>`; this file's own helpers address their repository by cwd.
*/
function failOneProbe(repo: string, subcommand: string, pathNeedle?: string): void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimDir = mkdtempSync(join(tmpdir(), "stas301-shim-"));
  roots.push(shimDir);
  const log = join(shimDir, "calls.log");
  const record = (verdict: string) => `  printf '%s\\n' "${subcommand} $* ${verdict}" >> "${log}"`;
  const failWith = [record("FAILED"), `  printf 'fatal: Unable to create ${repo}/.git/index.lock: File exists.\\n' >&2`, "  exit 128"];
  const guarded = pathNeedle
    ? ["  case \"$*\" in", `    *${pathNeedle}*)`, ...failWith.map((line) => `  ${line}`), "      ;;", "  esac"]
    : failWith;
  writeFileSync(join(shimDir, "git"), [
    "#!/bin/sh",
    `if [ "$1" = "-C" ] && [ "$2" = "${repo}" ] && [ "$3" = "${subcommand}" ]; then`,
    ...guarded,
    "fi",
    record("ok"),
    `exec ${realGit} "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(shimDir, "git"), 0o755);
  process.env.PATH = `${shimDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
}

/** Every engine probe the shim saw, with the verdict it gave. */
function probeCalls(): string[] {
  const shimDir = (process.env.PATH ?? "").split(":")[0];
  const log = join(shimDir, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

const sawFailed = (subcommand: string): boolean => probeCalls().some((call) => call.startsWith(`${subcommand} `) && call.endsWith("FAILED"));

const LOCK_MESSAGE = "index.lock";
const FAILED_PROBE = "could not answer";
const GHOST_TRACKED = "ghost.ts";
const FILE_ABSENT_OF_GHOST = `{"kind":"file-absent","path":"${GHOST_TRACKED}"}`;
const TEXT_ABSENT_FLAG = '{"kind":"text-absent","path":"present.ts","literal":"FLAG_ON"}';

describe("STAS-301 a plan-premise probe that failed is never a verified absence", () => {
  /*
  T1. The literal the plan promises to remove is still committed on main and the `ls-tree` probe fails.
  The plan is false — yet the code today resolves satisfied: an absence premise read a transport error as
  proof that the literal is gone.
  */
  it("T1 text-absent premise with a failing tree-listing probe holds the card and names the probe", 30_000, async () => {
    const root = makeRepo();
    writeFileSync(join(root, "present.ts"), "export const FLAG_ON = true;\n");
    commitTree(root);

    failOneProbe(root, "ls-tree");
    const check = await checkPremises(root, [TEXT_ABSENT_FLAG]);
    expect(check).toMatchObject({ outcome: "unavailable", premiseViolations: [] });
    expect(check.detail).toContain("ls-tree");
    expect(check.detail).toContain(LOCK_MESSAGE);
    expect(check.detail).toContain(FAILED_PROBE);
    expect(check.detail).toContain('"text-absent"');
    expect(check.detail).toContain("Evaluated at");
    expect(sawFailed("ls-tree")).toBe(true);

    // T1b: the door holds the card, burns no escalation episode, and logs no premise-rejection replan.
    const gate = await doorRelease(root, [TEXT_ABSENT_FLAG]);
    expect(gate.result).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(gate.reserved).toEqual([]);
    expect(logActions(gate.task)).not.toContain(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION);
    expect(gate.task.column).toBe("todo");
    expect((gate.task.sourceMetadata as Record<string, unknown>).planPremiseRejection).toBeUndefined();
  });

  /*
  T2. The premise kind the defect report names first, on its own fixture: `file-absent` while the file is
  tracked on main. The inversion lives in two evaluators, so each kind is asserted on its own.
  */
  it("T2 file-absent premise with a failing tree-listing probe holds the card and names the probe", 30_000, async () => {
    const root = makeRepo();
    writeFileSync(join(root, GHOST_TRACKED), "export const module = 1;\n");
    commitTree(root);

    failOneProbe(root, "ls-tree");
    const gate = await doorRelease(root, [FILE_ABSENT_OF_GHOST]);
    expect(gate.result).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(gate.reserved).toEqual([]);
    expect(logActions(gate.task)).not.toContain(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION);
    expect(gate.task.column).toBe("todo");
    expect((gate.task.sourceMetadata as Record<string, unknown>).planPremiseRejection).toBeUndefined();
    expect(sawFailed("ls-tree")).toBe(true);
  });

  /*
  T3. A regular file whose CONTENT read fails: an unreadable file says nothing about what it contains.
  Today's code answers "file content is unreadable at the evaluated commit" — a violated premise — and
  routes the card to replan. The same transport error reads as satisfied for text-absent and as falsified
  here; both directions are the same defect, and neither is a fact about the file.
  */
  it("T3 a failing content read is unavailable for both literal kinds, not a falsified plan", 30_000, async () => {
    const root = makeRepo();
    writeFileSync(join(root, "present.ts"), "export const FLAG_ON = true;\n");
    commitTree(root);

    failOneProbe(root, "show");
    const check = await checkPremises(root, [TEXT_ABSENT_FLAG, '{"kind":"text-present","path":"present.ts","literal":"NEVER_COMMITTED"}']);
    expect(check).toMatchObject({ outcome: "unavailable", premiseViolations: [] });
    expect(check.detail).toContain("show");
    expect(check.detail).toContain(LOCK_MESSAGE);
    expect(sawFailed("show")).toBe(true);
  });

  /*
  T3b. The second deterministic failure mechanism, with NO shim at all: a committed file larger than
  gitProbe's 8 MB maxBuffer overruns execFile (ENOBUFS) — one of the production triggers named in the
  defect report. A whole-file read that cannot fit is not evidence that a literal is absent.
  */
  it("T3b an over-buffer content read fails closed the same way, with no shim at all", 30_000, async () => {
    const root = makeRepo();
    writeFileSync(join(root, "big.txt"), Buffer.alloc(9 * 1024 * 1024, "x"));
    commitTree(root);

    const check = await checkPremises(root, ['{"kind":"text-absent","path":"big.txt","literal":"zzz"}']);
    expect(check).toMatchObject({ outcome: "unavailable", premiseViolations: [] });
    expect(check.detail).toContain("show");
    expect(check.detail).toContain(FAILED_PROBE);
  });

  /*
  T4 control (AC4). The identical fixture shape with nothing intercepting the probe: a literal the
  committed file never carried and a path it never tracked are ANSWERED absent, and must still satisfy
  and release exactly as fast as they do today.
  */
  it("T4 control a successful empty answer still satisfies the absence kinds and releases the card", 30_000, async () => {
    const root = makeRepo();
    writeFileSync(join(root, "present.ts"), "export const FLAG_ON = true;\n");
    commitTree(root);

    const gate = await doorRelease(root, ['{"kind":"text-absent","path":"present.ts","literal":"NEVER_COMMITTED"}', '{"kind":"file-absent","path":"ghost/never-tracked.ts"}']);
    expect(gate.result).toMatchObject({ released: true, task: { column: "doing" } });
    expect(gate.reserved).toEqual(["STAS-301"]);
  });

  /*
  T5 ordering. The premise set whose FIRST premise is genuinely falsified and whose SECOND premise's probe
  cannot answer: one unverifiable fact voids the whole verdict. The answered violation must not be carried
  into a stale verdict that burns the escalation ladder on a transport error.
  */
  it("T5 an answered violation plus an unanswered probe voids the whole verdict", 30_000, async () => {
    const root = makeRepo();
    writeFileSync(join(root, "present.ts"), "export const FLAG_ON = true;\n");
    commitTree(root);

    failOneProbe(root, "ls-tree", GHOST_TRACKED);
    const check = await checkPremises(root, ['{"kind":"file-absent","path":"present.ts"}', FILE_ABSENT_OF_GHOST]);
    expect(check).toMatchObject({ outcome: "unavailable", premiseViolations: [] });
    expect(check.detail).toContain(GHOST_TRACKED);
    expect(check.detail).not.toContain("Plan premise falsified while the card waited");
    expect(sawFailed("ls-tree")).toBe(true);
  });

  /*
  Attribution (the Requirement-5 adjudication, deliberately unchanged): the card delivered the file, its
  branch merged into main, and the door re-evaluates there. The correct verdict is
  premise-invalidated-by-delivery, which promotes with no episode. With the attribution probe broken the
  verdict stays `stale` — the LOUDER route, never a release. What had to change is the detail: the old
  code claimed "<path> is absent from this history", a fact git never reported.
  */
  it("attribution failure fails closed toward the louder stale route and names the probe that failed", 30_000, async () => {
    const root = makeRepo();
    writeFileSync(join(root, "present.ts"), "export const FLAG_ON = true;\n");
    commitTree(root, "chore: base");
    git(root, ["checkout", "-q", "-b", "fusion/stas-301-probe"]);
    writeFileSync(join(root, GHOST_TRACKED), "export const module = 1;\n");
    commitTree(root, "feat(STAS-301): land the ghost module");

    // The card's own commit is what falsified the premise, so the honest verdict is the promotable one.
    const delivered = await checkPremises(root, [FILE_ABSENT_OF_GHOST], { branch: "fusion/stas-301-probe" });
    expect(delivered.outcome).toBe("premise-invalidated-by-delivery");

    failOneProbe(root, "log", GHOST_TRACKED);
    const check = await checkPremises(root, [FILE_ABSENT_OF_GHOST], { branch: "fusion/stas-301-probe" });
    expect(check.outcome).toBe("stale");
    expect(check.detail).toContain(FAILED_PROBE);
    expect(check.detail).toContain(LOCK_MESSAGE);
    expect(check.detail).not.toContain("is absent from this history");
    expect(sawFailed("log")).toBe(true);
  });

  /*
  Identity ladder. When every rung's `rev-parse` probe fails, the verdict must name the probe failure. The
  old code claimed the project root "is not a git repository" — a classification that itself came from a
  probe that never answered — and would send an operator down the wrong path.
  */
  it("an unanswered identity probe is reported as a probe failure, never as an absent repository", 30_000, async () => {
    const root = makeRepo();
    writeFileSync(join(root, "present.ts"), "export const FLAG_ON = true;\n");
    commitTree(root);

    failOneProbe(root, "rev-parse");
    const check = await checkPremises(root, [FILE_ABSENT_OF_GHOST]);
    expect(check.outcome).toBe("unavailable");
    expect(check.detail).toContain(FAILED_PROBE);
    // The classification this verdict used to be built from: a probe that never answered, read as "no repository here".
    expect(check.detail).not.toContain("is not a git repository");

    const gate = await doorRelease(root, [FILE_ABSENT_OF_GHOST]);
    expect(gate.result).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(gate.reserved).toEqual([]);
    expect(logActions(gate.task)).not.toContain(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION);
    expect(gate.task.column).toBe("todo");
    expect(sawFailed("rev-parse")).toBe(true);
  });
});
