---
category: workflow-learnings
module: scripts
tags: [ratchets, gates, measurement, tooling, false-green]
problem_type: process-learning
applies_when: trusting a ratchet's number, or probing a ratchet to test what it can see
---

# Probe the instrument the way CI runs it

Companion to [silence-is-not-success](./silence-is-not-success.md) and
[a-falling-count-is-not-evidence](./a-falling-count-is-not-evidence.md). Those are about misreading
what the code did. This one is about misreading **the tool you are using to check the code** — the
layer that is supposed to be the ground truth when everything else is in doubt.

A ratchet reports a number. The number is only as good as two things nobody looks at: **which files
the tool decided exist**, and **whether the invocation you used can fail at all**. Both failed in one
session, on different tools, and each looked exactly like a pass.

## 1. A tool that cannot fail from the command line you typed

`check-move-target-literals` is report-only by default; `--strict` is what makes it exit non-zero, and
`package.json` supplies it:

```jsonc
"check:move-target-literals": "node scripts/check-move-target-literals.mjs --strict"
```

Probing it directly — `node scripts/check-move-target-literals.mjs` — returned **exit 0 for every
probe**, including a blatant `moveTask(id, "in-review")` pasted into `scheduler.ts`. That is
indistinguishable from a dead ratchet, and it was nearly reported as one. The guard was fine; the
invocation could not fail.

The output makes this worse, not better: a report-only run prints its normal summary line and exits 0,
so the terminal looks identical to a genuine pass. There is no "(report-only)" in the transcript to
catch your eye.

**Rule:** invoke a checker exactly as `package.json` does, or call the `pnpm check:*` script. If you
are testing what a tool can see, confirm first that your invocation can fail *at all* — introduce an
obvious violation and watch it go red before you trust a single green.

## 2. A tool that cannot see the file you just wrote

`lifecycle-column-census` and `check-move-target-literals` both discovered files with `git ls-files`,
which lists **tracked files only**. Everything else in the program walks the filesystem. So a new file
was invisible until it was committed:

| state of a new file containing a plain legacy guard | result |
| --- | --- |
| added to an already-tracked file | caught |
| new file, untracked | **missed, exit 0** |
| identical file, `git add`ed | caught, exit 1 |

Nothing is wrong with the detector in either tool — the literal is flagged the instant the file is
staged. The blindness is in discovery, and it lands at the exact moment the number is consulted: you
add a helper, run the census against your own work, read zero, and commit. The violation surfaces
later in someone else's CI run, attributed to a push rather than to the edit that introduced it.

The tool was answering a question about the last commit while being asked one about the working tree.

## 3. The compounding cost: instruments that disagree about reality

The two failures above are individually cheap. Together they are not.

`check-inert-sync-lane-conversions` walks the filesystem; the census used `git ls-files`. When the same
probe file was measured against both, one caught it and one missed it — and that differential was read
as a claim about *expression walking*, which is where a full investigation went before the real cause
turned out to be that the two tools disagreed about **which files exist**.

When instruments in one program disagree about their own domain, every differential between them is
unreadable until someone notices. Align the scopes, or the next person spends a day attributing a
discrepancy to the thing being measured instead of to the measuring.

## Read the reported COUNT, not the exit code

There is a second probing technique that sidesteps §1 entirely. It is **more informative for shape
coverage** — not strictly more informative, since it cannot answer §1's question at all: a count tells
you what the detector saw, never whether the ratchet would have failed on it.

Instead of asking "did the tool exit non-zero", parse the tool's own **per-file count** out of its
output:

```bash
# Capture output and status SEPARATELY: the pipeline below ends in `tr`, so a piped form reports
# `tr`'s success and a crashed detector reads as a clean zero — the failure this document is about.
out=$(node scripts/check-move-target-literals.mjs 2>&1); rc=$?
[ "$rc" -le 1 ] || { printf 'detector failed (rc=%s)\n%s\n' "$rc" "$out" >&2; exit 1; }

count=$(printf '%s\n' "$out" | grep -a "my-probe-tmp" | grep -aoE "^ +[0-9]+" | tr -d ' ')
[ -n "$count" ] || { printf 'no matching line — probe not scanned?\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$count"
```

`rc -le 1` because these ratchets use 1 for "violations found" and 2+ for "could not run"; a missing
match is reported rather than silently returning empty, since an absent line and a zero count are
different findings.

Two properties matter:

- **Immune to the report-only trap.** A report-only run still prints the count. The number moves from
  0 to 1 whether or not `--strict` was passed, so a missing flag cannot fake a pass.
- **It measures WHICH SHAPES, not just whether something fired.** An exit code is one bit for the whole
  run. Auditing a detector means asking "of these five spellings, which are seen?" — and five separate
  binary runs cannot distinguish *partial* detection from a probe file that failed to compile. The
  count answers per form, in one run: the move-target audit read `direct 1 / backtick 1 / ternary 0 /
  const 0`, which named the gap immediately.

The two techniques answer different questions and both are worth keeping. Use `pnpm check:*` to ask
**"can this ratchet fail?"** — the §1 question, and the one to ask first. Use per-file counts to ask
**"what can it see?"** — the shape-coverage question, where an exit code is too coarse.

One caveat that applies to both: confirm the probe file is actually being scanned, by watching the
tool's *scanned-file* total move. A probe that never compiled and a probe the tool never discovered
both report zero hits, and neither is a finding.

## What to actually do

- Before trusting a ratchet's number, run it once with a deliberate violation and confirm it goes red.
  A ratchet nobody has seen fail is a ratchet nobody has verified.
- Match the probe to the question: `pnpm check:*` for **"can this ratchet fail?"** (§1 — always run
  it through the CI entry point, never a bare `node scripts/...`), and the per-file **count** probe for
  **"what shapes can it see?"**. The count cannot answer the first question and the exit code cannot
  answer the second.
- Prefer one discovery mechanism across a family of tools. If a tool must differ, say so in its header
  and say why, so a cross-tool differential is readable.
- `git ls-files --cached --others --exclude-standard` is the tracked-plus-untracked form (dedupe the
  result: a path can appear under both flags in some index states). Ignored paths stay excluded, so
  build output does not leak into the count.

## The general shape: a green that answers a different question

The two defects above are instances of one thing, and it kept happening — **four times in a single
session**, from four unrelated directions. Each time the signal was real; it was simply the answer to
a question other than the one being asked.

| what was read as "pass" | what the green actually meant |
| --- | --- |
| `node scripts/check-*.mjs` exits 0 | report-only mode — the failure path needs `--strict` |
| a census reports 0 for a new file | the file is untracked, so it was never scanned |
| a backgrounded `cmd > log; grep …` reports exit 0 | that is `grep`'s status; the suite inside had 8 failures |
| a rebased branch's tests pass | the rebase never started, so it ran on the **old** base |

The last two are worth spelling out because neither involves a ratchet at all.

**Exit codes belong to the last command in the pipeline.** `run_tests > log 2>&1; echo done; grep X log`
exits with `grep`'s status. A harness that reports "completed, exit 0" is reporting on the pipeline,
not on the tests. Read the summary line out of the log; never infer a suite's result from a wrapper's
exit code.

**A failed rebase leaves you on the old base, and the tests still pass there.** `git rebase` refused
with `cannot rebase: You have unstaged changes` — so the branch never moved. `git diff origin/main`
then listed 20+ files including other workers' commits, which reads exactly like the branch had
reverted their work, and a full test run on that tree came back green. Both signals were true about a
tree nobody cared about.

```sh
git merge-base --is-ancestor origin/main HEAD    # the only check that distinguishes the two
```

It said STALE while the tests said pass. Run it after any rebase, before trusting a verification —
especially before reporting "verified on current main".

**The tell, in all four cases, is a result that is too clean or too alarming for what changed.** Every
probe shape passing, including ones that obviously should not. A two-file branch that appears to
revert twenty. When the answer does not fit the size of the question, check what was actually
measured before believing it.

## Your environment is a variable in every measurement you report

The sections above are about tools that answer a different question than the one asked. This one is
about the machine underneath them, which is the variable nobody writes down.

**One stale install produced five wrong reports.** A `node_modules` that had drifted from the lockfile
(`jsdom@29.0.1` installed, `29.1.1` pinned) generated failures that existed on no CI machine and no
other checkout. They were not subtle: deterministic, reproducible on demand, with plausible stack
traces and real-looking assertion diffs. Each round of triage got *more precise about the wrong data*:

| round | claim | why it was wrong |
| --- | --- | --- |
| 1 | "4 deterministic failures" | measured in a 4-file batch, called it isolation |
| 2 | "3 deterministic, 2 order-dependent" | isolated correctly, but a race is not deterministic |
| 3 | "TaskCard is broken" | stale jsdom; the CSS assertion was correct |
| 4 | "no contamination" | true of four app files; published unqualified |
| 5 | "quarantine these two" | never read the failure text — both were timeouts |

The through-line is not carelessness about the code. It is that **the environment was never treated
as part of the claim**, so no amount of care about the analysis could recover.

### The checks, in the order they cost the most

```bash
pnpm install --frozen-lockfile   # your node_modules is not evidence until it matches the lockfile
<run the file ALONE, 3+ times>   # isolation and repetition answer different questions
<read the failure TEXT>          # a timeout and an assertion failure need opposite responses
uptime                           # a loaded box manufactures timeouts that mean nothing
```

The last one deserves its own note. Two tests "failing" in a full-suite run turned out to be
`Test timed out in 15000ms` on a box at load average 9.7 with 84 users. Under AGENTS.md's
quarantine-on-sight rule that reads as a flake to quarantine — and the ledger's 14-day deletion
ratchet would have made the lost coverage permanent. **The rule presumes the failure is a property of
the test, not of the machine.** A wall-clock budget crossed under local contention is evidence about
the hardware.

### The tell

A finding is environment-derived when it is **local, recent, and unshared**: nobody else has reported
it, CI is green, and it appeared without a commit that could explain it. Any two of those should stop
a report before it is written. All three did apply, and the report went out anyway, five times.

## Provenance

Both defects were found by probing, not by reading: staged probe files measured against the tools with
before/after counts, working tree confirmed clean after each. The report-only trap was caught by a
result that was *too* clean — every shape passing, including ones that obviously should not — which is
the same tell as a suite where nothing fails.
