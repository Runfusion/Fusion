---
title: FN-9496 Full Suite shard 3 disposition
date: 2026-10-05
category: test-failures
---

# FN-9496: Full Suite shard 3 disposition

## Source evidence

- Full Suite run: [37259527410](https://github.com/Runfusion/Fusion/actions/runs/37259527410), head `acafb5254a0f0b4e7daedd2bce49207537c71843`, terminal conclusion `failure`.
- Shard job: [Test shard 3/4](https://github.com/Runfusion/Fusion/actions/runs/37259527410/job/111603612802), job ID `111603612802`, terminal conclusion `failure`. The job ran from `2026-10-05T03:28:15Z` through `2026-10-05T03:43:42Z`; its deterministic test step failed from `2026-10-05T03:35:40Z` through `2026-10-05T03:43:39Z`.
- Timing artifact: `test-timings-shard-3`, artifact ID `11323614101`, created `2026-10-05T03:43:40Z`, expires `2026-10-19T03:43:39Z`, 268,657 bytes, GitHub digest `sha256:5e3d031fea350839a436c4a1f8ee1d0ba90b9eb73975f7cd3382951c140e4e8d`.
- Acquisition: GitHub Actions REST API at `2026-10-05T03:50:18Z`. The downloaded ZIP SHA-256 was `5e3d031fea350839a436c4a1f8ee1d0ba90b9eb73975f7cd3382951c140e4e8d`, exactly matching GitHub's digest. Downloaded log and archive files remain ignored local evidence and were not staged.

The job log records `pnpm test:ci:shard --shard 3 --total 4`. It executed the core slice as:

```text
vitest run --silent=passed-only --reporter=dot --shard=1/2 --reporter=json --outputFile.json=.timings/timings-shard3-1.json
```

## Reporter ledger

All six JSON reports parsed successfully; no report path was malformed or duplicated.

| Report path | Suites | Assertions | Failed assertions | Disposition |
| --- | ---: | ---: | ---: | --- |
| `packages/cli/.timings/timings-shard3-0.json` | 174 | 2,181 | 0 | Passed |
| `packages/core/.timings/timings-shard3-1.json` | 337 | 3,522 | 1 | Unrelated core inventory failure |
| `packages/plugin-sdk/.timings/timings-shard3-0.json` | 2 | 16 | 0 | Passed |
| `plugins/examples/fusion-plugin-auto-label/.timings/timings-shard3-0.json` | 1 | 22 | 0 | Passed |
| `plugins/examples/fusion-plugin-settings-demo/.timings/timings-shard3-0.json` | 1 | 25 | 0 | Passed |
| `plugins/fusion-plugin-cursor-runtime/.timings/timings-shard3-0.json` | 10 | 64 | 0 | Passed |

The sole failed assertion was:

- Reporter: `core task:updated emit surface > registers every direct and safe production producer`
- Source: `packages/core/src/__tests__/task-updated-lanes-emit-surfaces.test.ts:76:47`
- Duration: 45.609314 ms
- Retained assertion: `expected [ …(17) ] to deeply equal [ …(16) ]`
- Log diff: the source scan found `packages/core/src/task-store/branch-and-pr-entities.ts`, but the `PRODUCERS` inventory omitted it.

## Attribution

This is not caused by FN-9492.

`acafb5254a0f0b4e7daedd2bce49207537c71843^..acafb5254a0f0b4e7daedd2bce49207537c71843` changes only `PlanningModeModal.planning-flow.test.tsx` and the FN-9492 disposition document. Its test change settles a resumed mobile hydration effect and reacquires live Questions and Plan preview controls. It neither imports nor changes `@fusion/core`, `branch-and-pr-entities.ts`, or the core producer inventory.

At the investigated SHA, blame assigns `branch-and-pr-entities.ts`'s safe `task:updated` emission to `51ed5eab232ef73f63fd8c1b24e7cb7f220f9f40` (FN-9436), which predates FN-9492. The target-SHA inventory does not register that module. The failure is therefore a stale core census caused by the earlier producer addition, not a Planning Mode hydration interaction, a dashboard project selection issue, or a shard artifact defect.

A repository search found the named mobile reporter only in the dashboard planning-flow test and the Planning Mode tab consumer only in `PlanningModeModal.tsx`; neither appears in the core failure or timing report. The task intentionally makes no source or test change because repairing the unrelated core owner would violate its causal boundary.

## Focused reproduction and verification

The exact local owner reproduction was run without retries:

```text
pnpm --filter @fusion/core exec vitest run src/__tests__/task-updated-lanes-emit-surfaces.test.ts --testNamePattern="registers every direct and safe production producer" --silent=passed-only --reporter=dot
```

It failed in 3.3 seconds with the same 17-versus-16 producer inventory mismatch, confirming the log and artifact reporter. This is recorded as evidence, not repaired here.

The task worktree passed the required unaffected checks:

- `pnpm lint` — passed in 30.5 seconds.
- `pnpm verify:fast` — passed in 110.7 seconds.
- `pnpm build` — passed in 70.9 seconds.

No FN-9492 Planning Mode repair was required or claimed. The earlier FN-9492 focused mobile test remains outside this artifact's reporter set; this disposition does not revise its historical attribution.
