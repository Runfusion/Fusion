/*
FNXC:WorktreeLifecycleHold 2026-08-17-22:04:
Ratchet for the worktree-held-across-lifecycle invariant (see
reliability-interactions/worktree-lifecycle-certification.test.ts for the incident anatomy).

A self-healing rebound that passes `preserveProgress: true` intends to KEEP the task's work,
but the reopen-into-planning move hook clears `task.worktree` unless the caller also passes
`preserveWorktree: true` — and a cleared pointer makes the checkout invisible to
`scanIdleWorktrees`' active set, so the idle sweep reaps the directory (uncommitted work
included). Six sweeps silently dropped checkouts this way.

Rule: every `preserveProgress: true` in self-healing.ts must sit within a few lines of either
`preserveWorktree` (the default: progress-preserving rebounds hold the checkout) or an explicit
`worktree-discard-intended: <reason>` marker (only for rebounds that have PROVEN the checkout
holds nothing — branch already merged, zero unique commits, or the worktree is already gone).
Static source scan: no git, no store, no timers.
*/
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOW = 6;

describe("self-healing preserveProgress rebounds hold the worktree", () => {
  it("every preserveProgress site preserves the worktree or carries a worktree-discard-intended marker", () => {
    const selfHealingPath = join(dirname(fileURLToPath(import.meta.url)), "..", "self-healing.ts");
    const lines = readFileSync(selfHealingPath, "utf-8").split("\n");
    const violations: string[] = [];
    lines.forEach((line, i) => {
      if (!line.includes("preserveProgress: true")) return;
      const start = Math.max(0, i - WINDOW);
      const end = Math.min(lines.length, i + WINDOW + 1);
      const window = lines.slice(start, end).join("\n");
      if (window.includes("preserveWorktree") || window.includes("worktree-discard-intended")) return;
      violations.push(`self-healing.ts:${i + 1}: ${line.trim()}`);
    });
    expect(
      violations,
      "preserveProgress rebound without preserveWorktree or a worktree-discard-intended marker — a progress-preserving rebound that drops the checkout makes it reap-bait",
    ).toEqual([]);
  });
});
