---
title: "Heap-floor probe: the one short-run claim the board read supports"
problem_type: performance
module: scripts, core/task-store
category: performance
tags: [heap, measurement, listTasks, coalescing, RUFU-627, ci-gate]
applies_when: "Before quoting any heap, slope, or 'the fix worked' figure about the board list read, and before writing a new measurement lane for it."
---

## The requirement this probe exists to satisfy

RUFU-627 opened with a production heap profile and closed with three mechanism changes. The operator's
question at the end was the honest one: **what actually changed, in numbers, from a lane we can run
again?** The answer had to be reproducible in seconds and had to not overclaim, because the tempting
claim — "the heap floor no longer rises toward the limit" — needs hours and nothing shorter can support
it.

`pnpm heap:floor` (`scripts/lib/heap-floor-probe.mjs`) is the seconds-long answer. It asserts exactly one
thing and reports the rest.

## What it asserts

> N genuinely-overlapping same-shape whole-board reads must cost **one** underlying fetch.

"Underlying" is counted by the production attribution seam — `snapshotReadAttribution().listTasks.calls`
(`packages/core/src/task-store/read-attribution.ts`, incremented at `reads.ts:945` inside the shared
read, below the coalescing). It cannot be counted by wrapping `store.listTasks`: coalescing happens
below that wrapper, so a wrapper counts N readers, reports N, and the probe measures its own
instrumentation.

The second rule is a falsifiability guard: the same overlap with `coalesce: false` must cost **one fetch
per reader**. Without it, rule one is satisfied by anything that stops counting — a broken seam, an
unexpected memo hit, a board that lost its rows.

The third rule bounds the transient peak against **one materialization measured in the same run** (the
sequential leg's own peak). It never contains an absolute GiB figure and never a ratio against the heap
limit. `FUSION_PG_TEST_URL_BASE=postgresql://localhost:25537 pnpm heap:floor -- --groups 6 --readers 4`
 run twice compares the factor; it is not a byte-to-byte comparison.

## The trap that made the first measurement of this question worthless

A sequential shadow of this same question measured a perfectly flat cost curve and looked like a fix
working. It measured nothing: a `for` loop that `await`s one read before starting the next never has two
reads in flight, so there is nothing for in-flight coalescing to coalesce, and the curve it draws is the
shape of the loop.

Consequences encoded in the probe:

- Leg A creates every reader promise in a group **before** awaiting any of them. `await` inside the map
  silently converts Leg A into Leg B.
- Leg B (sequential) is a plateau control. It is asserted only as "does not climb", and a climbing Leg B
  invalidates the run's peak rule rather than proving anything about coalescing. **Never quote Leg B as
  evidence coalescing works.**
- The in-proc test asserts Leg A's overlap at the fetch site (`maxConcurrentFetches`) per leg, in a test
  that runs Leg A alone. An earlier draft ran the whole plan and "passed" on the *control* leg's
  concurrency — an assertion that measured the wrong leg still looks green.

## Methodology, and the bug that forced it

GC is forced before each **baseline**. The first real run sampled the baseline live and reported
`peakBytes: 0` for the first group: the pre-group heap happened to sit higher than the post-settle heap,
and the delta clamped at zero. A peak against an uncollected baseline is not a measurement.

The transient **peak itself** is sampled *without* collecting — collecting there is what hid the
mechanism. Post-GC `retainedBytes` is emitted for context and is deliberately **not** an assertion: after
a forced GC, one shared board and four copies are all garbage, so retention cannot separate them. On a
live store the post-GC figure measured ~50 MB in every leg, mechanism or no mechanism, which is exactly
the flatness the sequential shadow mistook for success.

## Measured figures (this host, scratch database on the `:25537` pg test cluster)

| cards | Leg A (coalesced) reads/group | Leg A peak | `coalesce:false` reads/group | control peak | Leg B peak |
|---|---|---|---|---|---|
| 120 (`parsedBytes` 46.7 KB) | 1 | 15.8 MB | 4 | 21.2 MB | 15.5 MB |
| 600 (`parsedBytes` 233.9 KB) | 1 | 30.4 MB | 4 | 48.4 MB | 29.6 MB |

Both runs PASS, and the marginal cost per extra uncoalesced concurrent read is ~(21.2−15.5)=5.7 MB at 120
cards and ~(48.4−29.6)/3≈6.3 MB at 600.

**Read those figures with their limitation attached, which is the reason they are recorded here.** The
read-count rule discriminates cleanly (1 against 4). The peak rule does **not** discriminate at these
calibrations: the control's 48.4 MB is inside 2× of the 29.6 MB reference, because four interleaved
fetches do not cost 4× one fetch's peak — V8 reuses regions across the group. So the peak bound is a
guard against pathological retention, not proof of sharing. Anyone tempted to write "peak fell from
48 MB to 30 MB, the fix works" from this table is quoting a control leg against a different leg; the
sanctioned sentence from this probe is **"four overlapping same-shape board reads now cost one fetch
instead of four."**

Nothing in this file, and nothing from this probe, supports a slope or headroom claim. Those belong to the
`/metrics` soak (`fusion_retention_heap_used_bytes` against `fusion_retention_heap_limit_bytes` over
hours), which stays operator-run. Do not add a slope assertion to a seconds-long lane to make a
seconds-long lane quotable.

## Where it runs

- `pnpm heap:floor` — operator lane. Parent spawns a `node --expose-gc` child; the child creates and
  drops its own scratch database from `FUSION_PG_TEST_URL_BASE` (or uses an explicit
  `FUSION_HEAP_PROBE_DATABASE_URL`) and **refuses to boot an embedded cluster** — that data directory is
  what this machine's real dashboards use, and a measurement lane must not reach it by omission. The
  child builds its store the way the core pg harness does (`applySchemaBaseline` → connection set →
  `AsyncDataLayer` → `TaskStore`), *not* via `scripts/lib/backend-db.mjs`'s `openBackend`: that helper
  brings up the central registry too, and on this host it copied 16 real projects and a legacy secret row
  into the measurement database before failing central verification. An ops helper being correct for ops
  scripts is not evidence it is correct for a probe.
- `scripts/__tests__/heap-floor-probe.test.mjs` — the CI-legal in-proc lane, via `pnpm test:scripts`. It
  injects a fake store that counts underlying fetches and charges each fetch a board's bytes, so the
  overlap rule, its non-coalescing failure mode, the per-leg concurrency attribution, and the gated
  factor rule are all exercised with no backend and no soak. It does **not** prove the real store
  coalesces; `packages/core/src/__tests__/postgres/list-tasks-inflight-coalescing.pg.test.ts` owns that.
- The probe's live lane is not in CI: it needs a Postgres. That is a deliberate asymmetry, not an
  oversight, and it is why the in-proc lane asserts the verdict logic rather than the behaviour.
