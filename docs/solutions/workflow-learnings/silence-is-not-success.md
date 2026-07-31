---
category: workflow-learnings
module: scripts
tags: [verification, gates, measurement, false-green, tooling]
problem_type: process-learning
applies_when: reading the output of a test run, gate, or script as evidence it passed
---

# Silence is not success

Companion to [one-sample-is-not-a-diagnosis](./one-sample-is-not-a-diagnosis.md), which covers the
next step — reading a single observation as an explanation.

Sibling to [a-falling-count-is-not-evidence](./a-falling-count-is-not-evidence.md) (a metric moving
is not proof the system moved) and
[blind-the-resolver-to-find-uncovered-conversions](./blind-the-resolver-to-find-uncovered-conversions.md)
(a green suite is not proof a conversion is held). This one is narrower and more embarrassing: **the
absence of a failure message is not proof anything ran.**

Written after hitting the same root cause **three times in one session**, in three different tools,
while auditing a program whose entire subject is defects that hide behind green results.

## The three costumes

| what happened | what it looked like | what it was |
|---|---|---|
| `git stash --keep-index` swept the new **untracked** test file out of the tree (it stashes tracked, unstaged changes and, with `-u`, untracked ones — an unstaged new file is not protected by `--keep-index`) | "45 passed" | the pre-existing count; the new test never ran |
| a blinding script hit an unmapped role and `sys.exit(2)` with **no message**; `&&` skipped the check, `;` let the run proceed | "375/375 green under blinding" | nothing was blinded — the run was against unmodified source |
| a gate piped to `tail -1`, which printed a blank line | "gate ran, no complaints" | exit code 1; the FNXC stamp check had failed and CI caught it later |

Each read as success. None was.

## Why this class is hard to see

A passing run and a run that never happened produce **the same evidence**: no failure text. Every
other bug announces itself; this one is defined by the absence of an announcement. The instinct that
catches ordinary bugs — "nothing looks wrong" — is precisely the instinct that certifies this one.

It is worse under automation, where output is piped, filtered, and skimmed. `| tail -1`, `| grep
"Tests"`, `>/dev/null` and `2>&1` all discard the part that would have said "0 files matched" or
"command not found".

## Rules

**1. Assert the exit code, not the absence of text.** `rc=$?` immediately after the command, before
any pipe. A pipeline's exit status is the *last* stage's by default, so `cmd | tail -1` reports
`tail`'s success, never `cmd`'s. (`set -o pipefail` changes that, and `PIPESTATUS`/`pipestatus`
exposes each stage — but neither is on by default in the shells these commands are pasted into, so
the rule stands unless you have explicitly enabled it.)

**2. Confirm the run did the work.** A test run must report a plausible file/test COUNT — "Test Files
1 passed" when you expected 16 is a finding, not a pass. The exact strings quoted here are **Vitest's**
(`Test Files N passed`, `No test files found`, which exits non-zero and is easy to mistake for a
failing test); other runners word it differently, so match on the count you expected rather than on
the phrasing.

**3. A tool that can no-op must say what it did.** Print the substitution and its location, and fail
loudly on the paths where it cannot act. A silent `exit 2` is indistinguishable from success once
piped.

**4. Verify the mutation, not the tool's promise.** `git diff --stat` after an edit script; `grep`
for the changed line. The tool's exit code describes the tool, not the file.

**5. Make the check obviously fatal once.** If a guard is supposed to fail, break it on purpose and
watch it fail. A guard never observed failing has not been shown to work — the same standard this
repo applies to product ratchets, turned on your own verification.

## The uncomfortable part

The FNXC-stamp breach above was against a rule **I had added to AGENTS.md myself**, and it was the
second time I broke it. I ran the gate. I read `tail -1`. I moved on.

Writing a rule down does not make you follow it. A gate whose output you do not read is not a gate,
and the only reason this was caught is that CI read the output when the author did not. That is an
argument for the gate existing — not for the author having been careful.
