import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { REWRITTEN_DELIVERY_SEARCH_LIMIT, reconcileRewrittenDelivery } from "../execution/rewritten-delivery-reconciliation.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repository() {
  const root = mkdtempSync(join(tmpdir(), "fn-429-reconciliation-"));
  cleanup.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fusion@example.test");
  git(root, "config", "user.name", "Fusion Test");
  writeFileSync(join(root, "shared.ts"), "export const contract = 'v0';\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "C0");
  return { root, c0: git(root, "rev-parse", "HEAD") };
}

function commitDelivery(root: string, content: string, subject: string, trailers: string[]) {
  writeFileSync(join(root, "shared.ts"), content);
  git(root, "add", ".");
  git(root, "commit", "-qm", subject, "-m", trailers.join("\n"));
  return git(root, "rev-parse", "HEAD");
}

const V1 = "export const contract = 'v1';\n";
const OWNED_TRAILERS = ["Fusion-Task-Id: FN-A", "Fusion-Task-Lineage: lineage-a"];

/** Reproduces the FN-428 shape: the delivered commit is rebased onto a new parent with its patch untouched. */
function rebasedDelivery() {
  const { root, c0 } = repository();
  git(root, "checkout", "-qb", "holder");
  const landedShaBefore = commitDelivery(root, V1, "feat(FN-A): deliver the shared contract", OWNED_TRAILERS);
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "upstream.ts"), "export const upstream = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "upstream work");
  git(root, "checkout", "-q", "holder");
  git(root, "rebase", "-q", "--onto", "main", c0, "holder");
  const landedShaAfter = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--ff-only", "holder");
  const execution = `${root}-execution`;
  cleanup.push(execution);
  git(root, "worktree", "add", "-q", "-b", "fusion/fn-b", execution, "main");
  return { root, execution, c0, landedShaBefore, landedShaAfter };
}

function input(execution: string, landedSha: string, overrides: Record<string, unknown> = {}) {
  return { worktreePath: execution, repository: ".", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", landedSha, ...overrides } as const;
}

describe("rewritten delivery reconciliation", () => {
  it("reconciles a rebase that preserved the patch and the Fusion trailers", async () => {
    const fx = rebasedDelivery();
    expect(() => git(fx.execution, "merge-base", "--is-ancestor", fx.landedShaBefore, "HEAD")).toThrow();
    expect(git(fx.execution, "merge-base", "--is-ancestor", fx.landedShaAfter, "HEAD")).toBe("");

    await expect(reconcileRewrittenDelivery(input(fx.execution, fx.landedShaBefore)))
      .resolves.toEqual({ outcome: "reconciled", reconciledSha: fx.landedShaAfter, proof: "patch-id+task-trailer" });
  });

  it("reconciles on the lineage trailer alone when the task id trailer is absent", async () => {
    const { root, c0 } = repository();
    git(root, "checkout", "-qb", "holder");
    const before = commitDelivery(root, V1, "feat: deliver the shared contract", ["Fusion-Task-Lineage: lineage-a"]);
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "upstream.ts"), "export const upstream = true;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "upstream work");
    git(root, "checkout", "-q", "holder");
    git(root, "rebase", "-q", "--onto", "main", c0, "holder");
    const after = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--ff-only", "holder");
    const execution = `${root}-execution`;
    cleanup.push(execution);
    git(root, "worktree", "add", "-q", "-b", "fusion/fn-b", execution, "main");

    await expect(reconcileRewrittenDelivery(input(execution, before)))
      .resolves.toEqual({ outcome: "reconciled", reconciledSha: after, proof: "patch-id+lineage-trailer" });
  });

  it("refuses a subject-anchored commit that carries no Fusion trailer", async () => {
    const { root, c0 } = repository();
    git(root, "checkout", "-qb", "holder");
    const before = commitDelivery(root, V1, "feat(FN-A): deliver the shared contract", OWNED_TRAILERS);
    git(root, "checkout", "-q", "main");
    commitDelivery(root, V1, "feat(FN-A): deliver the shared contract", ["(no trailer)"]);
    const execution = `${root}-execution`;
    cleanup.push(execution);
    git(root, "worktree", "add", "-q", "-b", "fusion/fn-b", execution, "main");
    expect(c0).toBeTruthy();

    await expect(reconcileRewrittenDelivery(input(execution, before)))
      .resolves.toEqual({ outcome: "refused", reason: "no-equivalent-delivery" });
  });

  it("refuses a rewrite whose conflict resolution changed the patch", async () => {
    const { root } = repository();
    git(root, "checkout", "-qb", "holder");
    const before = commitDelivery(root, V1, "feat(FN-A): deliver the shared contract", OWNED_TRAILERS);
    git(root, "checkout", "-q", "main");
    commitDelivery(root, "export const contract = 'v1-resolved';\n", "feat(FN-A): deliver the shared contract", OWNED_TRAILERS);
    const execution = `${root}-execution`;
    cleanup.push(execution);
    git(root, "worktree", "add", "-q", "-b", "fusion/fn-b", execution, "main");

    await expect(reconcileRewrittenDelivery(input(execution, before)))
      .resolves.toEqual({ outcome: "refused", reason: "no-equivalent-delivery" });
  });

  it("refuses a patch-equal commit owned by a foreign task", async () => {
    const { root } = repository();
    git(root, "checkout", "-qb", "holder");
    const before = commitDelivery(root, V1, "feat(FN-A): deliver the shared contract", OWNED_TRAILERS);
    git(root, "checkout", "-q", "main");
    commitDelivery(root, V1, "feat(FN-OTHER): deliver the shared contract", ["Fusion-Task-Id: FN-OTHER", "Fusion-Task-Lineage: lineage-other"]);
    const execution = `${root}-execution`;
    cleanup.push(execution);
    git(root, "worktree", "add", "-q", "-b", "fusion/fn-b", execution, "main");

    await expect(reconcileRewrittenDelivery(input(execution, before)))
      .resolves.toEqual({ outcome: "refused", reason: "identity-foreign" });
  });

  it("refuses two patch-equal owned candidates as ambiguous", async () => {
    const { root } = repository();
    git(root, "checkout", "-qb", "holder");
    const before = commitDelivery(root, V1, "feat(FN-A): deliver the shared contract", OWNED_TRAILERS);
    git(root, "checkout", "-q", "main");
    commitDelivery(root, V1, "feat(FN-A): deliver the shared contract (rewritten once)", OWNED_TRAILERS);
    commitDelivery(root, "export const contract = 'v0';\n", "revert the shared contract", ["Fusion-Task-Id: FN-REVERT"]);
    commitDelivery(root, V1, "feat(FN-A): deliver the shared contract (rewritten twice)", OWNED_TRAILERS);
    const execution = `${root}-execution`;
    cleanup.push(execution);
    git(root, "worktree", "add", "-q", "-b", "fusion/fn-b", execution, "main");

    await expect(reconcileRewrittenDelivery(input(execution, before)))
      .resolves.toEqual({ outcome: "refused", reason: "identity-ambiguous" });
  });

  it("refuses an equivalent delivery that is absent from the declared target", async () => {
    const fx = rebasedDelivery();
    git(fx.root, "branch", "release", fx.c0);

    await expect(reconcileRewrittenDelivery(input(fx.execution, fx.landedShaBefore, { target: "release" })))
      .resolves.toEqual({ outcome: "refused", reason: "target-mismatch" });
  });

  it("refuses an unresolvable declared target", async () => {
    const fx = rebasedDelivery();
    await expect(reconcileRewrittenDelivery(input(fx.execution, fx.landedShaBefore, { target: "refs/heads/never-created" })))
      .resolves.toEqual({ outcome: "refused", reason: "target-mismatch" });
  });

  it("accepts the rewrite when the declared target does contain it", async () => {
    const fx = rebasedDelivery();
    await expect(reconcileRewrittenDelivery(input(fx.execution, fx.landedShaBefore, { target: "main" })))
      .resolves.toEqual({ outcome: "reconciled", reconciledSha: fx.landedShaAfter, proof: "patch-id+task-trailer" });
  });

  it("refuses an unreadable original delivery object instead of guessing", async () => {
    const fx = rebasedDelivery();
    await expect(reconcileRewrittenDelivery(input(fx.execution, "0".repeat(40))))
      .resolves.toEqual({ outcome: "refused", reason: "evidence-unavailable" });
  });

  it("refuses when the checkout holds no equivalent delivery at all", async () => {
    const { root } = repository();
    git(root, "checkout", "-qb", "holder");
    const before = commitDelivery(root, V1, "feat(FN-A): deliver the shared contract", OWNED_TRAILERS);
    git(root, "checkout", "-q", "main");
    const execution = `${root}-execution`;
    cleanup.push(execution);
    git(root, "worktree", "add", "-q", "-b", "fusion/fn-b", execution, "main");

    await expect(reconcileRewrittenDelivery(input(execution, before)))
      .resolves.toEqual({ outcome: "refused", reason: "no-equivalent-delivery" });
  });

  it("keeps the candidate window bounded", async () => {
    const fx = rebasedDelivery();
    expect(REWRITTEN_DELIVERY_SEARCH_LIMIT).toBe(200);
    // One unrelated commit in front of the rewritten delivery is enough to fall outside a window of one.
    writeFileSync(join(fx.execution, "later.ts"), "export const later = true;\n");
    git(fx.execution, "add", ".");
    git(fx.execution, "commit", "-qm", "later unrelated work");
    await expect(reconcileRewrittenDelivery(input(fx.execution, fx.landedShaBefore, { searchLimit: 1 })))
      .resolves.toEqual({ outcome: "refused", reason: "no-equivalent-delivery" });
  });
});
