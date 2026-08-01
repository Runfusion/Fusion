---
category: workflow-learnings
module: scripts/check-inert-sync-lane-conversions.mjs
tags: [lifecycle-columns, ratchets, gates, measurement, inert-conversions]
problem_type: process-learning
applies_when: reading a ratchet or census number as evidence that work happened
---

# A falling count is not evidence that anything changed

Sibling to [lifecycle-conversions-that-score-as-wins](./lifecycle-conversions-that-score-as-wins.md),
which records the *shapes* an inert conversion takes and how to tell a claim from a measurement. Its
grammatical tell is the portable one:

> if a claim can be written without running anything, it has not been tested.

This document records the **metric** counterpart, and the instrument failures that let it persist. It
is written from a phase in which the lifecycle-column backlog went 126 → 12, and in which a number
moved without the system moving **four separate times**.

## The tell

**A count that falls is not evidence that anything changed.** Every gate in this program reports a
number, and every number has three ways of going down:

1. work happened
2. the code got denser and the scan stopped matching
3. someone lowered the allowance

Only the first is progress, and from inside the check all three look identical.

| what moved | what actually happened |
|---|---|
| census 12 → 2 in `scheduler.ts` (#3051) | ten guards routed through `resolveTaskWorkflowIrSync`, which answers with the DEFAULT board under PostgreSQL. Byte-identical behaviour. Refuted end-to-end in #3058 |
| census 45 → 44 in `triage.ts` (#3114) | converted the exact arm #3108 had flagged hours earlier, blockers named and a test behind it. #3126 reverted it — three PRs for one line |
| ratchet 20 → 15 | not a conversion: #3065 rewrote `a === x \|\| a === y` as `set.has(a)` and the check counted only comparisons. It printed *"total fell — re-record"*, which would have **permanently retired live guards** |
| ratchet 22 → 9 | `scheduler.ts` reported **0** while 13 guards still fell back to the default board, laundered through `mergeParkedColumns(sync(...), lanes)` |

Rows three and four are the dangerous shape: **the gate went quiet exactly when someone improved the
code**, and the remedy it suggested was to lower the allowance.

### The obligation this creates

Before re-recording any baseline, establish *which* of the three causes applies. A drop caused by
denser encoding and a drop caused by a deleted gate are indistinguishable from inside the tool. The
check that works is cheap: dump the surviving hits and read them. Twice, that dump showed the
remaining entries were all in files nobody had touched — which is what a detection loss looks like.

## One defect, four spellings

The inert-lane ratchet was rewritten four times. Each version was correct about the shape in front of
it and blind to a trivially different spelling of the same defect:

```text
#3062  matched a local only        →  resolveX(store, id).review           walked past
#3068  matched comparisons only    →  parked.terminal.has(to)              walked past, and made the count FALL
#3079  matched same-file only      →  a helper imported from another file  walked past
#3181  matched direct assignment   →  wrapper(resolveX(...), lanes)        walked past
```

The lesson is not "write a better regex". It is that **enumerating the syntax that consumes a value
is a losing game**; the durable form keys on the *source* — anything derived from the broken reader —
and treats consumption as opaque. Each of the four fixes was verified by mutation: apply the shape,
confirm exit 1, restore the file. A green ratchet proves nothing about a shape it cannot express.

## An instrument that runs nowhere and one that cannot fail are the same defect

Both report green forever.

- **`check:inert-sync-lanes` was invoked by nothing** for six PRs — not `test:gate`, not any workflow.
  It only ran when a human typed it. The #3108 → #3114 → #3126 round trip happened while it was
  flagging the defect correctly the entire time.
- **`check:quarantine-ledger` was worse.** It ran nowhere *and* omitted `--strict`, and the script
  only exits non-zero with that flag. Wiring it alone would have been theatre. AGENTS.md had stated
  the 14-day deletion policy the whole time.

Both failures are invisible to every normal signal: the script exists, it is documented, it passes
when run by hand. The audit that finds them is mechanical — list every `check:*` script, grep the gate
chain and `.github/workflows/` for each, and check the exit-code path for a `--strict`-style flag the
package script omits.

## Base drift makes branch numbers incomparable

Three false alarms in this phase came from comparing a branch's reported number against a
remembered or differently-based one. One was mine: I "found" a 13-guard drop that was my own stale
figure from an earlier round.

**Branch outputs are not comparable. Scripts on one tree are.** The procedure that works:

```shell
# Extract both versions; neither needs its branch checked out.
git show <branchA>:scripts/<check>.mjs > /tmp/a.mjs
git show <branchB>:scripts/<check>.mjs > /tmp/b.mjs

# Run both against ONE tree. The primary checkout on `main` is the natural choice
# and needs no switching -- `git show` already did the fetching.
node /tmp/a.mjs ; node /tmp/b.mjs

# If a different tree is genuinely required, take a worktree rather than moving
# the primary checkout off `main` (AGENTS.md, Standing Rule: Prefer `main`):
#   wt switch --create <branch>        # or: git worktree add ../wt/<branch> <branch>
```

That is how two competing fixes were shown to be **additive rather than overlapping** (#3169 + #3181
= 22 = 13 + 7 + 2), which decided the merge order and let one collapse into six lines inside the
other.

## A pick-work list nominating decided sites

The census gained a `--triage` split (documented vs unexamined) because the headline number conflated
"deferred on purpose, reason written next to it" with "nobody has looked". At one point 88 guards
were 53-in-a-PR, 13-flagged, 11-fallback-arms and 11 genuinely open.

The split then had its own version of the same bug, twice: its marker set missed phrasings like
`STAYS INLINE`, `honest about being one` and `would be inert`, so a list headed *"this is the list to
pick work from"* reached **100% false positives** — every entry already decided.

That direction of error is the expensive one. Sending a worker at a site whose owner wrote down why it
must not move is precisely the #3108 → #3114 → #3126 sequence. Over-reporting hides real work;
under-reporting manufactures the collision. When in doubt, prefer showing a decided site over hiding
an open one, and make the marker phrases specific to *declining a conversion* rather than generic.

## Measured: what each lifecycle ratchet cannot see (2026-07-31)

The checklist below says to mutate the shape a ratchet claims to catch and confirm it exits non-zero.
Run against all five lifecycle gates on one tree, staging a probe file per form. Two were wrong.

| gate | catches | does NOT catch |
|---|---|---|
| `lifecycle-column-census` | `===` / `!==` comparisons | ~~membership, switch~~ **fixed** — both were invisible while it printed "a new guard cannot land silently" |
| `check-move-target-literals` | direct + backtick destinations | ~~ternary destination~~ **fixed**; still misses a destination bound to a local first |
| `check-sql-column-literals` | `"column"` comparisons, including inside plain template literals — not only drizzle `sql` tags | nothing found; the one miss probed was an invented identifier the schema never uses |
| `check-inert-sync-lane-conversions` | lane reads via the `resolvePlannerLanes` helper | a DIRECT `store.resolveTaskWorkflowIrSync(...)` read feeding `resolveLifecycleColumns` — inert by the same mechanism, untracked |
| `check-fnxc-future-dates` | future stamps | nothing found — it caught the author of this table, twice |

### The axis this table did not have

Everything above is **detection**: what each tool can and cannot see. I probed that thoroughly and
then wrote "sound" for two gates on the strength of it.

Within a day, three of these tools turned out to share a different defect entirely — **they wrote to
the tree they were checking**, auto-tightening their own baseline during a plain check run:

| gate | wrote during a check | fixed by |
|---|---|---|
| `check-fnxc-future-dates` | yes | #3287 |
| `lifecycle-column-census` | yes, under `--strict` | #3289 |
| `check-sql-column-literals` | yes | #3292 |

No number of detection probes could have surfaced that. The table asserted one property carefully and
**said nothing about the other while reading as comprehensive** — which is the same failure it
documents in the tools it audits.

What it cost: every worker who ran a gate received a byte-identical uncommitted diff they had not
authored, and reasonably committed it. #3283 and #3285 are the same `+0/-1` five minutes apart, by
two authors, neither of whom wrote that line.

**So audit a tool on at least three axes, not one:**

1. **What can it see?** — probe each spelling of the thing it claims to catch.
2. **Can it fail at all?** — invoke it as `package.json` does; a report-only run exits 0 forever.
3. **Does it write?** — `git status --porcelain` before and after, on a clean tree.

A trap for the third: these gates write only when a tightening is *available*, so a clean tree after
a run proves the trigger is absent, not that the tool is read-only. Inflate a baseline entry first,
then run it.

Three tools converged on the same write-during-check design independently, which says the pattern is
attractive rather than that anyone was careless: the tightening is correct, the write saves a step,
and the message even tells you to commit it.

Two lessons the table encodes beyond its rows.

**A ratchet's blind spot is invisible in exactly the way its subject is.** Both fixed gaps sat next to
a printed zero and a sentence promising nothing could land silently. The count was true; the sentence
was true only for the forms the parser happened to visit.

**Probe correctness is its own trap.** The first census probe measured nothing because the scanner
enumerates git-tracked files and the probe was untracked — the scanned-file count stayed flat, which
reads exactly like "no gap". `git add -f` the probe and confirm the scanned count moved. A first
`DELIBERATE-LITERAL` probe also read as a broken escape hatch until the marker was moved to its own
line: mid-expression it attaches to the wrong node, which is the documented gotcha and still caught
the person who had just written it down.

## Checklist

- Before re-recording a baseline: dump the surviving hits and name which of the three causes applies.
- Before trusting a ratchet: mutate the shape it claims to catch and confirm it exits non-zero.
- Before trusting a `check:*` script: confirm something runs it, and that it can fail.
- Before comparing two numbers: confirm they came from one tree.
- Before converting a flagged site: read the flag. It is a claim, and it decays — but re-deriving it
  costs minutes and overriding it wrongly has cost three PRs.
