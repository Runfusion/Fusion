/*
FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
The exemption is only worth having if it is ordered BEFORE the surfaces a human feels. The measured card
(VLLM-081) had landed days earlier, its ref was deleted, its producer could not run — and the lane still
answered every poll with a blocker plus, on a terminal refusal, an operator mailbox message about a gate
nothing can produce. A waiver and a wake-up are both a human paying for a producer that exists; when no
producer exists, neither is owed.

Every case here is the SAME lane with the SAME store fixture, differing only in what git says about the
delivery surface and in which refusal the re-seed seam returns. That is the point: the observation is the
only variable allowed to change the outcome, so a pass that exempts on one read and notifies on the next
cannot hide here. The repositories are real because the decision is git's — a fake that answers "absent"
proves only that the fake answers "absent".

The History assertions are equally load-bearing: each block names its OWN card by id, states the git
observation behind the decision, and reports what the mailbox really did. The pending-evidence arm sends no
message, so its line says exactly that.
*/
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type MessageStore, type Task, type TaskStore } from "@fusion/core";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { resetFinalizationNoticeState } from "../merge/finalization-refusal-notice.js";
import { STALE_RUNNING_CONTINUATION_FLOOR_MS } from "../merge/post-merge-gate-reseed.js";

const GATE_ID = "post-merge-verification";
const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function makeStore(
  task: Task,
  rootDir: string,
  /** Read LIVE by the stub, so a later pass can answer differently without rebuilding the store. */
  seed: { refusal?: string; unsupported?: boolean; seeds?: boolean; workItems?: unknown[] } = {},
): TaskStore {
  const store = {
    getTask: vi.fn(async () => task),
    getRootDir: vi.fn(() => rootDir),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    // No claimant by default: no runnable, running, held, or retrying producer exists anywhere. That is half
    // of what the exemption asks, and it is what lets the re-seed reach its own refusal instead of reporting a
    // live hold. `workItems` injects the card's real rows for the shapes that must NOT be exempted.
    listWorkflowWorkItemsForTask: vi.fn(async () => seed.workItems ?? []),
    // The real store interprets `sourceMetadataPatch` as a key-level merge; a fixture that assigned it as an
    // ordinary field would model a store that cannot persist a durable episode.
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      const { sourceMetadataPatch, ...rest } = patch as Partial<Task> & { sourceMetadataPatch?: Record<string, unknown> | null };
      if (sourceMetadataPatch === null) task.sourceMetadata = undefined;
      else if (sourceMetadataPatch !== undefined) task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...sourceMetadataPatch };
      return Object.assign(task, rest);
    }),
    updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task> | Promise<Partial<Task>>) => Object.assign(task, await update(task))),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(),
    logEntryOnce: vi.fn(async () => true),
    recordRunAuditEvent: vi.fn(),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  } as unknown as TaskStore;
  /*
  The refusals come from the seam, not from a made-up stub: `unsupported-store` — a refusal that can never
  produce the row, which is what makes the hand-off terminal — is exactly what the seam answers when the store
  has no idle-seed primitive. The idle-seed primitive's own refusals are carried verbatim, because the seam
  collapses any unrecognized refusal into `active-continuation`.
  */
  if (!seed.unsupported) {
    (store as unknown as { seedWorkspaceCodeReviewContinuationIfIdle: unknown }).seedWorkspaceCodeReviewContinuationIfIdle =
      vi.fn(async () => seed.seeds
        ? { seeded: true, workItemId: "post-merge-continuation" }
        : { seeded: false, reason: seed.refusal ?? "active-continuation" });
  }
  (store as unknown as { moveTaskIf: unknown }).moveTaskIf = vi.fn(
    async (_id: string, column: string, predicate: (t: Task) => unknown) => {
      if (!await predicate(task)) return { task, moved: false };
      return { task: await (store as unknown as { moveTask: (id: string, c: string) => unknown }).moveTask(task.id, column), moved: true };
    },
  );
  return store;
}

/**
 * A landed card whose pointer was cleared on finalize. The ref name is then only derivable from the id, which
 * is exactly why the probe falls back to the canonical branch name rather than reading a null pointer as an
 * absent delivery surface.
 */
function card(id: string): Task {
  return {
    id,
    column: "in-review",
    updatedAt: new Date().toISOString(),
    autoMerge: true,
    branch: null,
    steps: [{ name: "implementation", status: "done" }],
    enabledWorkflowSteps: [GATE_ID],
    workflowStepResults: [],
    mergeDetails: { mergeConfirmed: true, commitSha: "abc123" },
  } as unknown as Task;
}

function mailbox() {
  const calls: Array<{ key: string; content: string }> = [];
  const messageStore = {
    sendMessageOnce: vi.fn(async (input: { content: string }, key: string) => {
      calls.push({ key, content: input.content });
      return { message: {} as never, inserted: true };
    }),
  } as unknown as Pick<MessageStore, "sendMessageOnce">;
  return { messageStore, calls };
}

/** One installed post-merge continuation, shaped like the rows the durable work-item read returns. */
function workItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wi-1", runId: "run-1", taskId: "RUFU-450", nodeId: GATE_ID, kind: "task", state: "running",
    attempt: 1, retryAfter: null, deferredSince: null, leaseOwner: null, leaseExpiresAt: null,
    lastError: null, blockedReason: null, updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The idle-seed primitive's own call list — how many passes actually reached the re-seed seam. */
function seedCalls(store: TaskStore): unknown[][] {
  const seam = (store as unknown as { seedWorkspaceCodeReviewContinuationIfIdle?: { mock: { calls: unknown[][] } } }).seedWorkspaceCodeReviewContinuationIfIdle;
  return seam?.mock.calls ?? [];
}

/** The churned audit row this card is partly about, counted per pass. */
function refusalRows(store: TaskStore): Array<Record<string, unknown>> {
  return ((store as unknown as { recordRunAuditEvent: { mock: { calls: unknown[][] } } }).recordRunAuditEvent.mock.calls)
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event?.mutationType === "task:auto-merge-finalize-column-mismatch-no-action");
}

/** Every History line the pass wrote, through the durable once-seam or the shipped `logEntry` fallback. */
function historyActions(store: TaskStore): string {
  const once = (store as unknown as { logEntryOnce: { mock: { calls: unknown[][] } } }).logEntryOnce.mock.calls;
  const fallback = (store as unknown as { logEntry: { mock: { calls: unknown[][] } } }).logEntry.mock.calls;
  return [...once.map((call) => String((call[1] as { action?: string })?.action ?? "")),
    ...fallback.map((call) => String(call[1]))].join("\n");
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [
    "-c", "user.email=engine@fusion.test", "-c", "user.name=Fusion Engine", "commit", "-q", "-m", message,
  ], { cwd: repo });
}

function write(repo: string, file: string, body: string): void {
  execFileSync("bash", ["-c", `echo ${body} > ${file}`], { cwd: repo });
}

describeIfGit("post-merge producer-surface exemption is ordered before the human surfaces", () => {
  let repo = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "rufu-450-surface-"));
    git(repo, ["init", "-q", "-b", "main", "."]);
    write(repo, "shipped.txt", "shipped");
    commit(repo, "feat: land the card");
    /*
    A board that CAN report is the only board where the producer surface is the question at all: with a GitHub
    remote and no workflow file the contract resolves this gate as `no-evidence-reporter` first — an exemption
    that already explains the absence — and the case would prove nothing about the new arm. Remote and workflow
    file are presence-only facts; nothing in this file reaches the network.
    */
    execFileSync("bash", ["-c", "mkdir -p .github/workflows && printf 'name: ci\\n' > .github/workflows/ci.yml"], { cwd: repo });
    commit(repo, "ci: a board that can report");
    git(repo, ["remote", "add", "origin", "https://github.com/example/rufu-450.git"]);
    /*
    These two refs EXIST and each carries a commit `main` never took, which is the state that must never read
    as absence: a live developer branch is precisely what this exemption has to leave alone.
    */
    for (const [branch, file] of [["fusion/rufu-450-divergent", "ahead1.txt"], ["fusion/rufu-450-pending", "ahead2.txt"]] as const) {
      git(repo, ["checkout", "-q", "-b", branch]);
      write(repo, file, "ahead");
      commit(repo, `feat: unmerged work on ${branch}`);
      git(repo, ["checkout", "-q", "main"]);
    }
    // `fusion/rufu-450-exempt` is deliberately never created — the cleanup shape this card is about: the work
    // is on `main` and the task ref is gone, so `show-ref` answers absence.
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
  });

  it("exempts a gone ref with a durable landing and no producer, finalizing the card and notifying nobody", async () => {
    const task = card("RUFU-450-EXEMPT");
    const store = makeStore(task, repo, { unsupported: true });
    const mail = mailbox();

    const result = await finalizeProvenAutoMergeTask({
      store,
      taskId: task.id,
      source: "self-healing",
      messageStore: mail.messageStore,
      result: { task, mergeConfirmed: true, commitSha: "abc123" } as never,
    });

    expect(result.outcome).toBe("done");
    expect(result.reason ?? "").not.toMatch(/has not reported|post-merge gate unreachable/);
    // No wake-up for evidence nothing can produce, and no operator waiver charged against a producer that is
    // gone. The terminal hand-off is the pre-existing behavior for a card this rule does not exempt.
    expect(mail.calls).toHaveLength(0);
    expect(task.column).toBe("done");
    const history = historyActions(store);
    expect(history).toContain("Post-merge evidence was not required for RUFU-450-EXEMPT");
    expect(history).toContain(`gate '${GATE_ID}'`);
    expect(history).toContain("no operator notification was needed");
  });

  it("keeps the terminal hand-off when the surface is merely divergent, and says on the card that it notified", async () => {
    const task = card("RUFU-450-DIVERGENT");
    const store = makeStore(task, repo, { unsupported: true });
    const mail = mailbox();

    const result = await finalizeProvenAutoMergeTask({
      store,
      taskId: task.id,
      source: "self-healing",
      messageStore: mail.messageStore,
      result: { task, mergeConfirmed: true, commitSha: "abc123" } as never,
    });

    expect(result).toMatchObject({ outcome: "blocked", postMergeEvidenceBlocked: true });
    expect(result.reason ?? "").toMatch(/post-merge gate unreachable: unsupported-store/);
    expect(mail.calls).toHaveLength(1);
    expect(task.column).toBe("in-review");
    const history = historyActions(store);
    expect(history).toContain("Post-merge evidence needs a human decision for RUFU-450-DIVERGENT");
    expect(history).toContain("delivery surface read as ref-divergent");
    expect(history).toContain("was delivered to the operator mailbox");
  });

  it("records the pending-evidence refusal durably without claiming a notice it did not send", async () => {
    const task = card("RUFU-450-PENDING");
    // `active-continuation` can genuinely clear on a later pass, so this arm defers instead of handing off.
    const store = makeStore(task, repo, { refusal: "active-continuation" });
    const mail = mailbox();

    const result = await finalizeProvenAutoMergeTask({
      store,
      taskId: task.id,
      source: "self-healing",
      messageStore: mail.messageStore,
      result: { task, mergeConfirmed: true, commitSha: "abc123" } as never,
    });

    expect(result).toMatchObject({ outcome: "blocked", deferredPostMergeEvidence: true });
    expect(result.reason ?? "").toMatch(/has not reported/);
    expect(result.reason ?? "").not.toMatch(/post-merge gate unreachable/);
    expect(mail.calls).toHaveLength(0);
    const history = historyActions(store);
    expect(history).toContain("Post-merge evidence refused for RUFU-450-PENDING");
    expect(history).toContain(`gate '${GATE_ID}'`);
    expect(history).toContain("re-seed refused (active-continuation)");
    expect(history).toContain("was not sent (this refusal is still retryable)");
    // The refusal is durable now, which is what bounds its repetition across a restart.
    expect(task.sourceMetadata?.postMergeEvidenceRefusal).toMatchObject({
      gateId: GATE_ID,
      state: "missing",
      reseedReason: "active-continuation",
    });
  });

  /*
  FNXC:PostMergeProducerSurface 2026-11-02-20:20 (RUFU-450, row d): the shape RUFU-326 measured and the reason
  this card exists. A post-merge continuation IS installed — so any "no producer row was ever created" rule
  would keep refusing — and it is RUFU-610's abandoned shape: `running` with no `leaseExpiresAt` at all, which
  the scheduler cannot claim and the idle-seed predicate cannot reuse. The exemption must therefore come from
  git plus the liveness read, and it must arrive BEFORE the seam: a pass that reached the seam would take its
  `active-continuation` refusal as the last word and the card would stay wedged forever.
  */
  it("exempts an installed continuation that can no longer be advanced, without ever reaching the seam (row d)", async () => {
    const task = card("RUFU-450-STALE");
    const stalled = workItem({
      taskId: task.id,
      updatedAt: new Date(Date.now() - STALE_RUNNING_CONTINUATION_FLOOR_MS - 60_000).toISOString(),
    });
    const store = makeStore(task, repo, { refusal: "active-continuation", workItems: [stalled] });
    const mail = mailbox();

    const result = await finalizeProvenAutoMergeTask({
      store,
      taskId: task.id,
      source: "self-healing",
      messageStore: mail.messageStore,
      result: { task, mergeConfirmed: true, commitSha: "abc123" } as never,
    });

    expect(result.outcome).toBe("done");
    expect(task.column).toBe("done");
    expect(mail.calls).toHaveLength(0);
    // Ordering proof, not a style preference: had the lane admitted the pass first, the seam would have
    // refused `active-continuation` and that refusal would be the only verdict the card ever got.
    expect(seedCalls(store)).toHaveLength(0);
    expect(historyActions(store)).toContain("Post-merge evidence was not required for RUFU-450-STALE");
  });

  /*
  FNXC:PostMergeProducerSurface 2026-11-02-20:20 (RUFU-450, row m): the safety control. An already-landed card
  whose post-merge hop is merely QUEUED is the normal case, not the limbo case — the scheduler will run it and
  the evidence will arrive. Exempting it would silence a demand the board can still meet, which is the exact
  opposite defect from the one this card fixes, and worse, because it would be invisible.
  */
  it("never pre-empts a normal post-merge hop: an advanceable continuation keeps the gate owed (row m)", async () => {
    const task = card("RUFU-450-LIVEHOP");
    const store = makeStore(task, repo, {
      refusal: "active-continuation",
      workItems: [workItem({ taskId: task.id, state: "runnable" })],
    });
    const mail = mailbox();

    const result = await finalizeProvenAutoMergeTask({
      store,
      taskId: task.id,
      source: "self-healing",
      messageStore: mail.messageStore,
      result: { task, mergeConfirmed: true, commitSha: "abc123" } as never,
    });

    expect(result).toMatchObject({ outcome: "blocked", postMergeEvidenceBlocked: true });
    expect(result.reason ?? "").toMatch(/has not reported/);
    expect(mail.calls).toHaveLength(0);
    // The requirement is still owed, so the lane still does the useful thing: asks for the gate to be seeded.
    expect(seedCalls(store)).toHaveLength(1);
    const history = historyActions(store);
    expect(history).not.toContain("was not required");
    expect(history).toContain("Post-merge evidence refused for RUFU-450-LIVEHOP");
  });

  /*
  FNXC:PostMergeEvidenceRefusalEpisode 2026-11-02-20:20 (RUFU-450, Half 1): the bound has to survive the
  restart that RUFU-431/442's in-process gate could not. The measurement was five rows inside one minute for a
  card that had been waiting for days, so the assertion is: one record per distinct refusal, and a process
  that forgets must not make the card's wait look new. Clearing the shipped in-process notice state is exactly
  what an engine restart does; the card's own episode is what remembers. Deleting the episode leg and leaving
  only the in-process gate turns the middle assertion red — the bound would reset with the process.
  */
  it("keeps one refusal record per distinct refusal across an engine restart, and records a changed refusal", async () => {
    resetFinalizationNoticeState();
    const task = card("RUFU-450-PENDING");
    // Mutable: the third pass answers differently, which is a DIFFERENT refusal, not a repeat of this one.
    const seed: { refusal?: string; seeds?: boolean } = { refusal: "active-continuation" };
    const store = makeStore(task, repo, seed);
    const mail = mailbox();
    const call = () => finalizeProvenAutoMergeTask({
      store,
      taskId: task.id,
      source: "self-healing",
      messageStore: mail.messageStore,
      result: { task, mergeConfirmed: true, commitSha: "abc123" } as never,
    });

    await call();
    expect(refusalRows(store)).toHaveLength(1);
    expect(task.sourceMetadata?.postMergeEvidenceRefusal).toMatchObject({ reseedReason: "active-continuation" });

    resetFinalizationNoticeState();
    await call();
    expect(refusalRows(store)).toHaveLength(1);

    seed.seeds = true;
    seed.refusal = undefined;
    const third = await call();
    expect(third).toMatchObject({ outcome: "blocked", resumedPostMergeEvidence: true });
    expect(refusalRows(store)).toHaveLength(2);
    // The identity is the whole point: `none` names "the seam accepted this time", which is a different
    // wait from `active-continuation`. `reseedReason` is omitted rather than stored as null.
    expect(task.sourceMetadata?.postMergeEvidenceRefusal).toMatchObject({
      signature: `${GATE_ID}:missing:none`,
    });
    resetFinalizationNoticeState();
  });
});
