/**
 * RUFU-182 Step 6 — dependency-contract tripwire for pi's compaction refusals.
 *
 * The chat-lane escalation ladder (chat-context-guard.ts) decides whether a SECOND
 * `session.compact()` is legal from ONE fact: whether pi appended a compaction entry
 * before failing. That decision, and the honest operator diagnosis attached to every
 * refusal, are keyed to literals and control flow inside the installed
 * `@earendil-works/pi-coding-agent` distribution (verified against 0.84.4). If pi
 * renames a refusal literal, starts consuming the instructions argument inside the
 * preparation guard, or reorders the append against the resolve, the ladder silently
 * misclassifies again — exactly the saneca-b6a74d40 false "static floor" diagnosis
 * this task removed. This file makes that drift an honest test failure.
 *
 * It is intentionally NOT an assertion about our own comments or prose: it reads the
 * shipped runtime artifact the engine actually calls and asserts its CODE CONTRACT.
 *
 * Resolution note: pi's package exports map exposes only "."/"./rpc-entry"/"./client"
 * (import condition only), so `require.resolve` throws and vitest's runner does not
 * support `import.meta.resolve`. The test therefore resolves the package ROOT by
 * walking up from this file for `node_modules/@earendil-works/pi-coding-agent` — the
 * first hit is exactly the copy bare-specifier resolution from packages/engine uses
 * under the pnpm layout — then derives the dist directory from the package's own
 * `exports["."].import` condition, so the file read here is the same dist the barrel
 * `@earendil-works/pi-coding-agent` (imported by pi.ts) executes.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCompactionFailure,
  compactSessionContext,
  isRetryAfterCompactionFailureLegal,
  type CompactionOutcome,
} from "../pi.js";

/** Find the installed pi package root the same way bare-specifier resolution would. */
function resolvePiPackageRoot(): { dir: string; version: string; agentSessionJs: string; compactionJs: string } {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up++) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as {
        version?: string;
        exports?: Record<string, { import?: string }>;
      };
      const entry = pkg.exports?.["."]?.import;
      if (typeof entry !== "string") {
        throw new Error('pi package has no exports["."].import condition — the resolution assumption broke');
      }
      const distDir = dirname(join(candidate, entry));
      // The pnpm store layout makes the first upward hit the resolved copy; assert it
      // really is the store install (a stray local copy would make the tripwire hollow).
      const real = realpathSync(candidate);
      if (!real.includes("node_modules")) {
        throw new Error(`resolved pi package is not a node_modules install: ${real}`);
      }
      return {
        dir: candidate,
        version: pkg.version ?? "unknown",
        agentSessionJs: join(distDir, "core", "agent-session.js"),
        compactionJs: join(distDir, "core", "compaction", "compaction.js"),
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not resolve @earendil-works/pi-coding-agent from the engine package");
}

const piPkg = resolvePiPackageRoot();
const agentSession = readFileSync(piPkg.agentSessionJs, "utf8");
const compactionModule = readFileSync(piPkg.compactionJs, "utf8");

describe(`pi compaction contract tripwire (installed @earendil-works/pi-coding-agent@${piPkg.version})`, () => {
  it("still refuses a second pass with the Already-compacted literal the classifier recognizes", () => {
    // The refusal guard: prepareCompaction returns undefined, then the LAST branch
    // entry's type picks which literal throws. Pin the whole shape, not just the word.
    const guard = agentSession.match(
      /if \(!preparation\) \{[\s\S]*?lastEntry\?\.type === "compaction"[\s\S]*?throw new Error\("([^"]+)"\);\s*\}\s*throw new Error\("([^"]+)"\);/,
    );
    expect(guard, "pi no longer refuses via the last-entry compaction guard with two literals").not.toBeNull();
    const [, alreadyLiteral, tooSmallLiteral] = guard!;
    expect(alreadyLiteral).toBe("Already compacted");
    expect(tooSmallLiteral).toBe("Nothing to compact (session too small)");

    // Drift tripwire through the REAL artifact: feed the extracted literals to our
    // classifier. If pi rewords either literal, the classifier silently degrades to
    // the generic `error` arm — which the ladder would then RETRY illegally or
    // misdiagnose — and that degradation fails here instead of at an operator's desk.
    expect(classifyCompactionFailure(new Error(alreadyLiteral))).toMatchObject({
      reason: "already-compacted",
      branchMutated: false,
    });
    expect(classifyCompactionFailure(new Error(tooSmallLiteral))).toMatchObject({
      reason: "nothing-to-compact",
      branchMutated: false,
    });
    // pi throws nothing else with these words; case-insensitive recognition is ours,
    // the literals above are pi's exact shipped text.
  });

  it("still ignores the instructions argument on the refusal path (no directive unlocks a second pass)", () => {
    // The compact() entry point takes customInstructions, but the preparation call that
    // gates ALL compaction — and therefore the refusal — receives only the branch and
    // settings. An instructions-driven third argument here would silently legalize the
    // tier-2 escalation on branches pi has sealed.
    expect(agentSession).toMatch(/async compact\(customInstructions\) \{/);
    expect(agentSession).toMatch(/const preparation = prepareCompaction\(pathEntries, settings\);/);
    expect(compactionModule).toMatch(/export function prepareCompaction\(pathEntries, settings\) \{/);
    // The instructions argument may only reach the SUMMARIZER, never the preparation
    // signature — if pi ever routes it into prepareCompaction, this trips.
    expect(compactionModule).not.toMatch(/export function prepareCompaction\([^)]*customInstructions/);
  });

  it("still appends the compaction entry before compact() resolves (a throw means nothing landed)", () => {
    // The whole branch-mutation contract: `branchMutated: true` on any resolve and
    // `false` on any throw is only sound because the append happens INSIDE compact()
    // before it returns. Assert the manual path appends before emitting compaction_end
    // (the resolve signal), and that the automatic path carries the same append.
    const manualStart = agentSession.indexOf('async compact(customInstructions) {');
    expect(manualStart).toBeGreaterThanOrEqual(0);
    const manualBody = agentSession.slice(manualStart, agentSession.indexOf('"compaction_end"', manualStart));
    expect(manualBody).toContain("this.sessionManager.appendCompaction(");
    expect(agentSession.indexOf("this.sessionManager.appendCompaction(", manualStart)).toBeLessThan(
      agentSession.indexOf('"compaction_end"', manualStart),
    );
    // The threshold-driven automatic pass (auto-compaction path) shares the append —
    // a second site exists beyond the manual one.
    const appendCount = agentSession.split("this.sessionManager.appendCompaction(").length - 1;
    expect(appendCount).toBeGreaterThanOrEqual(2);
  });

  it("keeps the retry-legality predicate exactly branch-mutation-based", async () => {
    // Truth table for every arm, including one driven through the real helper against a
    // falsy-resolving fake (the defensive arm that contradicts the append-before-resolve
    // contract above — it must classify as `error`, nothing proven appended).
    const arms: Array<{ label: string; outcome: CompactionOutcome; retryLegal: boolean }> = [
      {
        label: "compacted",
        outcome: {
          reason: "compacted",
          branchMutated: true,
          summary: "s",
          tokensBefore: 10,
          estimatedTokensAfter: 5,
          reduced: true,
        },
        retryLegal: false,
      },
      { label: "already-compacted", outcome: { reason: "already-compacted", branchMutated: false, engineMessage: "Already compacted" }, retryLegal: false },
      { label: "nothing-to-compact", outcome: { reason: "nothing-to-compact", branchMutated: false, engineMessage: "Nothing to compact (session too small)" }, retryLegal: false },
      { label: "unsupported", outcome: { reason: "unsupported", branchMutated: false, engineMessage: null }, retryLegal: false },
      { label: "error", outcome: { reason: "error", branchMutated: false, engineMessage: "boom" }, retryLegal: true },
    ];
    for (const { label, outcome, retryLegal } of arms) {
      expect(isRetryAfterCompactionFailureLegal(outcome), label).toBe(retryLegal);
    }

    // Falsy resolve via the real helper → error arm (retry legal), NOT a refusal reason.
    const falsySession = { compact: async () => null } as unknown as Parameters<typeof compactSessionContext>[0];
    const falsyOutcome = await compactSessionContext(falsySession);
    expect(falsyOutcome.reason).toBe("error");
    expect(falsyOutcome.branchMutated).toBe(false);
    expect(isRetryAfterCompactionFailureLegal(falsyOutcome)).toBe(true);

    // Throwing the shipped refusal literal via the real helper → terminal refusal arm.
    const refusalSession = {
      compact: async () => {
        throw new Error("Already compacted");
      },
    } as unknown as Parameters<typeof compactSessionContext>[0];
    const refusalOutcome = await compactSessionContext(refusalSession);
    expect(refusalOutcome.reason).toBe("already-compacted");
    expect(isRetryAfterCompactionFailureLegal(refusalOutcome)).toBe(false);
  });
});
