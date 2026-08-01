---
category: workflow-learnings
module: docs
tags: [debugging, flakes, races, measurement, diagnosis]
problem_type: process-learning
applies_when: explaining why a test fails, before acting on the explanation
---

# One sample is not a diagnosis

Companion to [silence-is-not-success](./silence-is-not-success.md), which is about not reading a run
that never happened as a pass. This one is about the next step: **reading a single observation as an
explanation.**

Written after reversing three confident diagnoses in one session, all wrong the same way.

## The three reversals

**A breakpoint that wasn't.** `planning-browser-e2e` failed at viewport width 769 and passed at 768.
That is the mobile-breakpoint boundary, so the story wrote itself: a layout regression in the tablet
band, introduced by the recent floating-window migration. Instrumenting the probe and re-running
produced **5 passes in 6 runs**, and on every pass the control sat comfortably inside the viewport at
769 (`right: 753 ≤ 769`). Nothing was structurally wrong there. 769 is simply the most fragile point
to measure *during a transition*, so it is the first case a **race** bites — which looks identical to
a breakpoint bug at N=1.

**A red main that wasn't.** A model-routes test failed **3 runs of 3** locally. Consistency felt like
proof. CI's last three completed runs on main had it **green**, with an entirely different file as
the only failure. The local hang was an environment interaction. The tell was in the fixture the
whole time: it is configured offline (`allowModelNetwork: false`), so if it needs nothing from the
network, a sandbox should not change the outcome — the hang pointed at the environment from the
first run.

**An unpinnable site that wasn't.** A resolver was recorded as impossible to cover without a
forbidden mock-the-world shell. True of the shape being considered — a helper that *receives* the
resolved set — and false of the one that mattered: a helper that *resolves* it. The note hardened a
single failed approach into a property of the site.

## The pattern

Each was a confident causal story built on one observation, and each survived exactly until a second
measurement of a different kind. Not a *repeat* — a **different** measurement: another environment,
another sample, another framing.

The failure is not carelessness. Each story was plausible, mechanistic, and consistent with the
evidence available. That is precisely what makes it dangerous: a diagnosis that explains the one data
point you have feels finished.

## The second measurement, concretely

"Take a second measurement of a different kind" is easy to nod at and hard to act on at 2am. The one
that settled every case above is cheap: **enumerate recent CI runs and compute a per-file failure
rate.**

```bash
for r in $(gh run list --workflow <full-suite-id> --branch main --limit 14 \
            --json databaseId,conclusion -q '[.[]|select(.conclusion=="failure")][0:7][].databaseId'); do
  printf "%s: " "$r"
  gh run view "$r" --log-failed | grep -aE "FAIL" \
    | grep -aoE "(src|app)/[a-zA-Z0-9/_.-]+\.test\.tsx?" | sort -u | tr '\n' ' '
  echo
done
```

Seven runs was enough to separate three populations that look identical from one local run:

| rate on CI | meaning | action |
|---|---|---|
| 7/7 | consistent, real | fix it — or diagnose and hand off with evidence |
| 1/7 | intermittent | flake or race; two in one subsystem is a product-race smell |
| 0/7 (fails only locally) | environment | fix your sandbox, change nothing in the repo |

The third row is the one that keeps catching people. **Three separate local failures in a single
session were all 0/7 on CI** — a model-routes test that hung offline, a component test with four
failing cases, and a set of assertions I was ready to call a regression. Each felt like a finding.

Note the asymmetry in cost: acting on a 0/7 by quarantining deletes coverage that works everywhere
else, while acting on a 7/7 by investigating costs an hour. When unsure which row you are in, the
cheap move is always more samples from the *other* environment.

## Tells worth memorising

| observation | tempting story | check first |
|---|---|---|
| fails at boundary X, passes at X−1 | structural bug at the boundary | run it 5 more times — boundaries are where races surface |
| **consistent** locally, green on CI | main is broken / CI is lying | the environment; consistency is not universality |
| **intermittent** locally, consistent on CI | flaky test | a race the slower machine loses every time |
| one approach failed | the site cannot be done | whether a *different shape* of the approach works |

## Rules

1. **Before naming a cause, take a second measurement of a different kind.** Another environment,
   more samples, or an instrumented probe. Re-running the same command is not a second measurement.
2. **Environment asymmetry is a race signature.** Intermittent on fast hardware and consistent on
   slow, contended runners is the classic shape. It is also the shape most often mislabelled "flaky
   test" and appeased with a longer timeout — which the quarantine rule forbids for good reason.
3. **"I saw it fail" does not satisfy "without a corresponding real bug."** Quarantining on a local
   observation can delete coverage that is green everywhere else.
4. **Record cautions as environment-scoped, not as properties of the code.** "This suite skips
   without TCP PostgreSQL here" ages into "these resolvers are unmeasurable" and becomes a permanent
   excuse for not looking. Say where you measured.
