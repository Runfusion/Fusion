/*
 * Persisted external checkout routing is an explicit operator contract. Execution
 * must use the same validated checkout as review, and stale path/branch metadata
 * must fail closed instead of silently falling back to the project task worktree.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectExternalGitCheckout, resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";
import { resolveReviewCheckoutCwd } from "../execution/review-checkout.js";

function makeGitCheckout(branch = "local/runtime-fixes"): string {
  const dir = mkdtempSync(join(tmpdir(), "external-execution-checkout-"));
  execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Fusion Test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

let checkout: string;

beforeAll(() => {
  checkout = makeGitCheckout();
});

afterAll(() => {
  rmSync(checkout, { recursive: true, force: true });
});

describe("resolveExternalExecutionCheckoutRoute", () => {
  it("reports an absent route without widening to other task fields", async () => {
    await expect(resolveExternalExecutionCheckoutRoute({
      worktree: "/tmp/task-worktree",
      customFields: { executionCheckoutPath: "/tmp/untrusted" },
    })).resolves.toEqual({ configured: false });
    await expect(resolveExternalExecutionCheckoutRoute({
      sourceMetadata: {
        externalExecutionCheckout: null,
        externalExecutionBranch: null,
      },
    })).resolves.toEqual({ configured: false });
  });

  it("resolves a persisted path and branch and matches explicit review routing", async () => {
    const realCheckout = realpathSync(checkout);
    const task = {
      sourceMetadata: {
        externalExecutionCheckout: checkout,
        externalExecutionBranch: "local/runtime-fixes",
        externalReviewCheckout: checkout,
      },
    };

    await expect(resolveExternalExecutionCheckoutRoute(task)).resolves.toEqual({
      configured: true,
      valid: true,
      checkoutPath: realCheckout,
      branch: "local/runtime-fixes",
    });
    expect(resolveReviewCheckoutCwd(task, "/tmp/task-worktree")).toBe(realCheckout);
  });

  it("fails closed when the persisted branch does not match the checkout", async () => {
    await expect(resolveExternalExecutionCheckoutRoute({
      sourceMetadata: {
        externalExecutionCheckout: checkout,
        externalExecutionBranch: "stale-branch",
      },
    })).resolves.toMatchObject({
      configured: true,
      valid: false,
      reason: expect.stringContaining("branch mismatch"),
    });
  });

  it("fails closed when a path is persisted without a branch fence", async () => {
    await expect(resolveExternalExecutionCheckoutRoute({
      sourceMetadata: { externalExecutionCheckout: checkout },
    })).resolves.toMatchObject({
      configured: true,
      valid: false,
      reason: expect.stringContaining("externalExecutionBranch"),
    });
  });

  it("requires a clean checkout when an operator first persists the route", async () => {
    writeFileSync(join(checkout, "dirty.txt"), "dirty");
    await expect(inspectExternalGitCheckout(checkout, { requireClean: true })).resolves.toMatchObject({
      valid: false,
      reason: expect.stringContaining("must be clean"),
    });
  });
});
