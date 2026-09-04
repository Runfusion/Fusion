import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyReviewInlineFixRecapture,
  isFastForwardAdvance,
  readHeadSha,
  type ReviewInlineFixRecaptureInput,
} from "../worktree/review-inline-fix-recapture.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fusion-review-recapture-"));
  directories.push(directory);
  await git(directory, ["init"]);
  await git(directory, ["config", "user.email", "test@example.test"]);
  await git(directory, ["config", "user.name", "Test"]);
  await writeFile(join(directory, "file.txt"), "base\n");
  await git(directory, ["add", "file.txt"]);
  await git(directory, ["commit", "-m", "base"]);
  return directory;
}

const valid: ReviewInlineFixRecaptureInput = {
  verdict: "APPROVE",
  reviewKind: "code",
  reviewedCommitSha: "before",
  currentHeadSha: "after",
  baseRef: "base",
  fastForwardAdvance: true,
  baseIsAncestor: true,
  fingerprintProbeAvailable: true,
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("review inline-fix recapture classifier", () => {
  it.each([
    ["recaptures a proven approving fast-forward", {}, "recaptured", true],
    ["rejects an unchanged head", { currentHeadSha: "before" }, "head-unchanged", false],
    ["rejects revision verdicts", { verdict: "REVISE" }, "not-approval-verdict", false],
    ["rejects plan approvals", { reviewKind: "plan" }, "plan-domain", false],
    ["requires all anchors", { baseRef: undefined }, "missing-anchor", false],
    ["rejects rewritten history", { fastForwardAdvance: false }, "history-rewritten", false],
    ["requires base ancestry", { baseIsAncestor: false }, "base-not-ancestor", false],
    ["fails closed on unavailable ancestry", { fastForwardAdvance: undefined }, "probe-unavailable", false],
    ["fails closed on unavailable fingerprinting", { fingerprintProbeAvailable: false }, "probe-unavailable", false],
  ] as const)("%s", (_name, override, reason, recapture) => {
    expect(classifyReviewInlineFixRecapture({ ...valid, ...override })).toEqual({ reason, recapture });
  });

  it("proves fast-forward advancement and fails closed for divergence or unreadable evidence", async () => {
    const directory = await createRepository();
    const base = await readHeadSha(directory);
    await writeFile(join(directory, "file.txt"), "advance\n");
    await git(directory, ["add", "file.txt"]);
    await git(directory, ["commit", "-m", "advance"]);
    const head = await readHeadSha(directory);

    expect(await isFastForwardAdvance(directory, base, head)).toBe(true);
    expect(await isFastForwardAdvance(directory, head, base)).toBe(false);
    expect(await isFastForwardAdvance(directory, "not-a-commit", head)).toBeUndefined();
    expect(await readHeadSha(join(directory, "missing"))).toBeUndefined();
  });
});
