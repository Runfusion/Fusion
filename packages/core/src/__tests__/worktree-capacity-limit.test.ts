import { describe, expect, it } from "vitest";
import { resolveWorktreeCapacityLimit } from "../workflow-capacity.js";
import { DEFAULT_SETTINGS } from "../settings-schema.js";

/*
FNXC:CapacityModel 2026-07-28-12:40:
`resolveWorktreeCapacityLimit` is THE single expression of "are worktrees a
capacity dimension for this project?". These cases pin the distinction the whole
worktrees-off design rests on: OFF returns `null` (absence — callers build no gate)
and never a large number, because "very high" is a limiter that can start binding
again while absence cannot.
*/
describe("resolveWorktreeCapacityLimit", () => {
  it("returns the configured limit when worktrees are enabled", () => {
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 7, worktreeLimitEnabled: true })).toBe(7);
  });

  it("treats an omitted worktreeLimitEnabled as ON (back-compat for every existing project)", () => {
    // Existing rows have no `worktreeLimitEnabled` key. They must keep gating exactly
    // as before — an upgrade must not silently remove a limiter operators rely on.
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 3 } as never)).toBe(3);
  });

  it("returns null — not Infinity, not a large number — when worktrees are off", () => {
    const resolved = resolveWorktreeCapacityLimit({ maxWorktrees: 4, worktreeLimitEnabled: false });
    expect(resolved).toBeNull();
    // Explicitly NOT a number: a numeric "disabled" value is a sentinel, and a
    // sentinel is what silently stopped binding in the capacity-pool-id defect.
    expect(typeof resolved).not.toBe("number");
  });

  it("ignores maxWorktrees entirely when off, including values that would deadlock", () => {
    // 0 deadlocks the ON path (`used >= 0` holds on an empty board). Off must not
    // care what the number is.
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 0, worktreeLimitEnabled: false })).toBeNull();
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 999, worktreeLimitEnabled: false })).toBeNull();
    expect(resolveWorktreeCapacityLimit({ worktreeLimitEnabled: false } as never)).toBeNull();
  });

  it("falls back to the shipped default when the limit is missing or non-finite", () => {
    expect(resolveWorktreeCapacityLimit({ worktreeLimitEnabled: true } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit(undefined)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: Number.NaN } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: Infinity } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
  });

  it("ships with worktrees enabled by default", () => {
    // The supported shape is everything-in-a-worktree, planning included.
    expect(DEFAULT_SETTINGS.worktreeLimitEnabled).toBe(true);
  });
});

/*
FNXC:CapacityModel 2026-07-29-22:55:
"Worktrees off" must make `maxWorktrees` genuinely INERT for admission, not merely skipped by
convention. `resolveWorktreeCapacityLimit` is the only expression of that, so the invariant is not
"the resolver is correct" (asserted above) but "nothing bounds admission WITHOUT going through it".

A unit test on the resolver cannot see a second reader. This one enumerates every non-test source
file that uses `maxWorktrees` in a BOUNDING expression — a comparison, a multiplier, a min/max — and
requires each to be named with a reason. A new raw bound fails here rather than quietly re-limiting a
project that turned worktrees off.

MEASURED at the time of writing: exactly two, and only one of them bounds admission.
*/
describe("worktrees-off is structural: no unaudited maxWorktrees bound", () => {
  /*
  Audited bounds, keyed on the EXPRESSION and not the file (greptile #2652).

  This was `Record<file, reason>` and checked `!(file in AUDITED_BOUNDS)`, which exempted every
  bounding expression in an allowlisted file. A SECOND raw admission bound added to `scheduler.ts` —
  the single most likely place for one to appear — stayed green, so the ratchet could not fire where it
  was most needed. Naming the expression means an audited file gets no blanket pass.

  `expr` is matched as a substring of the comment-stripped, generic-stripped line.
  */
  const AUDITED_BOUNDS: Array<{ file: string; expr: string; reason: string }> = [
    {
      file: "packages/engine/src/scheduler.ts",
      expr: "settings.maxWorktrees ?? this.options.maxWorktrees ?? 4",
      reason:
        "THE admission gate's limit read, and the ONLY one: it feeds resolveWorktreeCapacityLimit, whose "
        + "gate snapshot is optional so OFF mode constructs no gate at all.",
    },
    {
      file: "packages/engine/src/scheduler.ts",
      expr: "maxWorktreesGate.used >= maxWorktreesGate.limit",
      reason:
        "The gate's own binding check, and SAFE BY CONSTRUCTION in OFF mode: it reads the OPTIONAL "
        + "`maxWorktreesGate` snapshot, which is `undefined` when resolveWorktreeCapacityLimit returns "
        + "null, so the `&&` short-circuits and no worktree gate can bind. Surfaced only once this "
        + "allowlist became per-expression — the file-level version was hiding it.",
    },
    {
      file: "packages/engine/src/scheduler.ts",
      expr: "slack: maxWorktreesLimit - maxWorktreesUsed",
      reason:
        "The gate's own slack arithmetic on the RESOLVED limit. Surfaced only once this scan followed "
        + "aliases: `maxWorktreesLimit` holds resolveWorktreeCapacityLimit's result, and the whole block "
        + "is skipped when that is null, so OFF mode never reaches it.",
    },
    {
      file: "packages/engine/src/self-healing.ts",
      expr: "if (dirs.length <= cap) return;",
      reason:
        "enforceWorktreeCap's early exit. `cap` is the alias of `(settings.maxWorktrees ?? 4) * 2` — "
        + "on-disk hygiene, not admission (see the entry below). Invisible to a line-based scan.",
    },
    {
      file: "packages/engine/src/self-healing.ts",
      expr: "const excess = dirs.length - cap;",
      reason:
        "The same hygiene sweep deciding HOW MANY idle worktrees to remove. Same alias, same reason: it "
        + "bounds directories on disk, never admission.",
    },
    {
      file: "packages/engine/src/self-healing.ts",
      expr: "(settings.maxWorktrees ?? 4) * 2",
      reason:
        "enforceWorktreeCap: on-disk hygiene, not admission. Caps worktree DIRECTORIES at 2x and only "
        + "removes idle ones. Must keep applying in OFF mode or idle worktrees accumulate unbounded.",
    },
    /*
    FNXC:WorktreeCapacity 2026-08-03-02:01:
    Planning admission and child-spawn paths now resolve/bound maxWorktrees the same way as the
    scheduler executor gate. These are intentional admission readers (or aliases of resolveWorktreeCapacityLimit),
    not raw second gates that bypass OFF mode.
    */
    {
      file: "packages/engine/src/executor.ts",
      expr: "heldWorktrees + this.totalSpawnedCount > spawnMaxWorktrees",
      reason:
        "Child-spawn worktree budget: spawnMaxWorktrees aliases settings.maxWorktrees ?? 4; the block "
        + "is skipped when the resolved value is non-finite (worktrees-off / unset).",
    },
    {
      file: "packages/engine/src/scheduler.ts",
      expr: "maxWorktrees !== null && maxWorktrees <= maxConcurrent",
      reason:
        "Binding-gate discriminator after resolveWorktreeCapacityLimit: null means worktrees are not a "
        + "capacity dimension, so this arm cannot bind in OFF mode.",
    },
    {
      file: "packages/engine/src/triage.ts",
      expr: "Math.max(0, maxWorktrees - claimed)",
      reason:
        "Planning admission worktreeRoom from resolveWorktreeCapacityLimit; only evaluated when the "
        + "resolved limit is non-null.",
    },
    {
      file: "packages/engine/src/triage.ts",
      expr: "Math.min(projectRoom, worktreeRoom)",
      reason:
        "Planning maxToStart combines agent and worktree rooms; worktreeRoom is Infinity when limit is null.",
    },
    {
      file: "packages/engine/src/triage.ts",
      expr: "worktreeRoom <= 0 && projectRoom > 0",
      reason:
        "Throttle reason discriminator for plan:admission-throttled — names which gate bound, not a second limit.",
    },
  ];

  /*
  FNXC:CapacityModel 2026-07-30-23:20 (coderabbit #2652 — AST, because the regex could be walked around):
  This scan was line-based, and two shapes bypassed it while leaving the suite green:

      const limit = settings.maxWorktrees;   // read and bound on DIFFERENT lines
      if (used >= limit) { ... }

      resolveWorktreeCapacityLimit(          // call split across lines
        settings,
      )

  A ratchet a reviewer can walk around by extracting a local is not a ratchet. It now PARSES: every
  read of `.maxWorktrees` is found in the AST, then followed through a single alias hop (a local
  initialised from that read) to see whether the value reaches a comparison, arithmetic or min/max.
  Formatting and generics stop mattering — `Pick<Settings, "maxWorktrees" | ...>` is a type node, not
  an expression, so the false positive the old `stripGenerics` hack existed for cannot occur.
  */
  it("every file bounding on maxWorktrees is audited", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { createRequire } = await import("node:module");
    const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
    const root = resolve(__dirname, "../../../..");

    const files = execFileSync("git", ["ls-files", "--", "packages"], { cwd: root, encoding: "utf-8" })
      .split("\n")
      .filter((f) => f && /\/src\//.test(f) && /\.tsx?$/.test(f) && !f.includes("__tests__"));

    const BOUNDING_OPS = new Set<number>([
      ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.LessThanToken,
      ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.PlusToken,
    ]);

    /** Does this expression feed a comparison / arithmetic / Math.min|max? */
    const feedsABound = (node: import("typescript").Node): boolean => {
      let current: import("typescript").Node | undefined = node;
      // Walk out through parentheses, `??`, `!`, and `as` so `(x ?? 4) * 2` still counts.
      while (current?.parent) {
        const parent: import("typescript").Node = current.parent;
        if (ts.isBinaryExpression(parent)) {
          if (BOUNDING_OPS.has(parent.operatorToken.kind)) return true;
          if (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) { current = parent; continue; }
          return false;
        }
        if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) {
          current = parent;
          continue;
        }
        if (ts.isCallExpression(parent)) {
          const callee = parent.expression.getText(parent.getSourceFile());
          return callee === "Math.min" || callee === "Math.max";
        }
        return false;
      }
      return false;
    };

    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(resolve(root, file), "utf-8");
      if (!raw.includes("maxWorktrees")) continue;
      const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

      /* Locals initialised from a `maxWorktrees` read — the alias hop the regex missed. */
      const aliases = new Set<string>();
      const collectAliases = (node: import("typescript").Node): void => {
        if (
          ts.isVariableDeclaration(node)
          && node.initializer
          && ts.isIdentifier(node.name)
          && /\bmaxWorktrees\b/.test(node.initializer.getText(sf))
        ) {
          aliases.add(node.name.text);
        }
        ts.forEachChild(node, collectAliases);
      };
      collectAliases(sf);

      const report = (node: import("typescript").Node): void => {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const text = raw.split("\n")[line - 1]?.trim() ?? node.getText(sf);
        const audited = AUDITED_BOUNDS.some((a) => a.file === file && text.includes(a.expr));
        if (!audited) offenders.push(`${file}:${line}: ${text}`);
      };

      const visit = (node: import("typescript").Node): void => {
        // A direct read: `settings.maxWorktrees`, `this.options.maxWorktrees`, …
        if (ts.isPropertyAccessExpression(node) && node.name.text === "maxWorktrees" && feedsABound(node)) report(node);
        // An aliased read: `limit` where `const limit = settings.maxWorktrees`.
        if (ts.isIdentifier(node) && aliases.has(node.text) && !ts.isVariableDeclaration(node.parent) && feedsABound(node)) report(node);
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(
      offenders,
      "a new maxWorktrees bound appeared. Admission must resolve through resolveWorktreeCapacityLimit "
      + "(null = worktrees are not a capacity dimension). If the bound is genuinely not about admission, "
      + "add it to AUDITED_BOUNDS with the reason.",
    ).toEqual([]);

    /*
    The allowlist must not rot: an entry naming an expression that no longer exists is a hole a real
    new bound can hide behind, because the file keeps its audited status.
    */
    for (const entry of AUDITED_BOUNDS) {
      const src = readFileSync(resolve(root, entry.file), "utf-8");
      expect(
        src.includes(entry.expr),
        `${entry.file} no longer contains the audited bound \`${entry.expr}\` — update or drop that entry`,
      ).toBe(true);
    }
  });

  it("admission has exactly the known worktree-limit readers", async () => {
    /*
    FNXC:WorktreeCapacity 2026-08-03-02:01:
    Scheduler execute admission and triage planning admission both resolve the same limit. A third
    call site is a product change and must be audited here.
    */
    const { execFileSync } = await import("node:child_process");
    const { resolve } = await import("node:path");
    const root = resolve(__dirname, "../../../..");
    // Call sites only (exclude the definition, the barrel re-exports, and prose).
    const hits = execFileSync(
      "git",
      ["grep", "-n", "resolveWorktreeCapacityLimit({", "--", "packages"],
      { cwd: root, encoding: "utf-8" },
    ).split("\n").filter((l) => l && !l.includes("__tests__"));

    expect(hits.length, `expected two admission readers, got:\n${hits.join("\n")}`).toBe(2);
    expect(hits.some((h) => h.includes("packages/engine/src/scheduler.ts"))).toBe(true);
    expect(hits.some((h) => h.includes("packages/engine/src/triage.ts"))).toBe(true);
  });
});

/*
FNXC:CapacityModel 2026-07-30-15:10 (one shared stripper — #2633 owns it now):
Imports the comment stripper from the PROGRAM'S census lib rather than carrying one here. This test
briefly had its own, `replace(/^\s*\/\/.*$/gm, " ")`, which only matched a comment occupying a WHOLE
line — a trailing `foo(); // maxWorktrees * 2` survived, so its prose could trip the unaudited-bound
check as a false positive on a file with no raw bounding code at all. A ratchet that fires on prose is
a ratchet someone mutes.

I then had a second copy in my own census script; #2633 merged the canonical one, so both of mine are
gone and this points at the survivor. Three implementations of "strip comments" was the exact drift
shape this program keeps paying for.
*/
async function stripComments(src: string): Promise<string> {
  const mod = await import("../../../../scripts/lib/lifecycle-column-census.mjs");
  return (mod as { stripComments: (s: string) => string }).stripComments(src);
}
