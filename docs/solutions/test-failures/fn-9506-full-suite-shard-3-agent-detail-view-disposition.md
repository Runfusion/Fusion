---
title: FN-9506 Full Suite shard 3 Agent Detail disposition
date: 2026-10-05
category: test-failures
---

# FN-9506: Full Suite shard 3 Agent Detail disposition

## Source evidence

- Full Suite run: [37279527225](https://github.com/Runfusion/Fusion/actions/runs/37279527225), head `52e790446dbcfff118e4c6150056cec3d090da0c`, terminal conclusion `failure`.
- Shard job: [Test shard 3/4](https://github.com/Runfusion/Fusion/actions/runs/37279527225/job/111664072084), job ID `111664072084`, failed at the deterministic test step after running from `2026-10-05T07:51:22Z` to `2026-10-05T08:01:33Z`.
- Timing artifact: `test-timings-shard-3`, artifact ID `11332755977`, created `2026-10-05T08:01:34Z`, expires `2026-10-19T08:01:33Z`, 454,652 bytes, GitHub digest `sha256:85a8465f96e26a8ec9f0d80ff9f051f6a9e66673a0042fdd18c2d434a7577ec4`.
- Acquisition: GitHub Actions REST API on `2026-10-05`. The downloaded ZIP SHA-256 was `85a8465f96e26a8ec9f0d80ff9f051f6a9e66673a0042fdd18c2d434a7577ec4`, exactly matching GitHub's digest.

The job ran `pnpm test:ci:shard --shard 3 --total 4`. The artifact contained six package reports plus a shard diagnostic; the dashboard report parsed successfully and was attributable to `packages/dashboard/.timings/timings-shard3-2.json`.

## Reporter ledger

| Report path | Suites | Assertions | Failed assertions | Disposition |
| --- | ---: | ---: | ---: | --- |
| `packages/dashboard/.timings/timings-shard3-2.json` | 176 | 6,009 | 1 | Investigated Agent Detail ordering failure |

The sole dashboard failure was:

- Reporter: `AgentDetailView — core > loads compatible legacy skill details through the resolved canonical ID`
- Source: `packages/dashboard/app/components/__tests__/AgentDetailView.core.test.tsx:507:17`
- Duration: 58.443616 ms
- Error: expected `data-skill-state="auto-available"`, received `data-skill-state="pending"`.

## Attribution and causal boundary

This is a deterministic test-ordering defect, not a product defect and not a failure caused by FN-9504.

The badge test was introduced with legacy canonical-ID support in `52c9f5ff3c` (FN-9322). It queried the rendered badge as soon as the agent arrived, but discovery is asynchronous and can still be pending at that point. `AgentDetailView` correctly classifies pending discovery as neutral and correctly withholds `fetchSkillContent` until a canonical ID exists. The test's immediate `auto-available` assertion was therefore invalid under the real lifecycle.

FN-9504's target-SHA diff contains only `packages/engine/src/__tests__/fixtures/merge-orphan-durable-write-inventory.json` and `docs/solutions/reliability/merge-orphan-body-durable-write-fences.md`. It neither modifies dashboard code nor imports the skill classifier, discovery hook, or Agent Detail component. It did not cause this dashboard failure.

## Controlled reproduction and repair

The exact focused command passed on the current equivalent before and after the repair:

```text
FUSION_DASHBOARD_DEEP=1 pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/AgentDetailView.core.test.tsx --project dashboard-app --testNamePattern "loads compatible legacy skill details through the resolved canonical ID" --silent=passed-only --reporter=dot
```

The repair changes only the test. A controlled deferred `fetchDiscoveredSkills` response now proves this sequence:

1. The agent's stored legacy reference renders a retained badge with `data-skill-state="pending"`.
2. Clicking while pending makes no detail-content request.
3. Resolving the canonical discovered skill updates the same badge to `auto-available`.
4. After closing the pending selection and clicking the retained badge, exactly one request uses `fetchSkillContent(canonicalId, "legacy-resolution-detail")`.

The inverse ordering cannot occur in this component: the discovery hook mounts with the Dashboard tab only after the agent is loaded. Thus agent-before-discovery is the reachable asynchronous ordering, and the deferred scenario is the production-shaped symptom reproduction. Production code was unchanged; the stored reference remains in the tooltip, while the request uses the resolved canonical ID and project ID.

## Flake-policy disposition

This file is outside the thin merge gate and retains 54 focused cases. No prior tracked sighting of this subject or its `legacy-resolution-detail` fixture exists. The no-product-bug failure is therefore recorded as the policy-eligible high-value first sighting in `suite-only-flakes-observed-register.md`, entry 21, alongside the structural repair.

A deterministic repair does not exempt this result from the deletion ratchet: a second sighting of this file requires a same-change file-level quarantine in `scripts/lib/test-quarantine.json` and the direct `quarantinedDashboardTests` exclusion, with the 14-day deletion deadline recorded. No retry, timeout change, skip, or weaker assertion was introduced.

## Verification

- Focused controlled Agent Detail regression — passed.
- Agent Detail core, classifier, mobile Agent Detail, Agents View, and Skill Multiselect targeted tests — passed (218 tests across five files).
- Observed-flake register synchronization test — passed with `node --test scripts/__tests__/observed-flake-register.test.mjs`.
- No published-package behavior changed, so no changeset was created.
