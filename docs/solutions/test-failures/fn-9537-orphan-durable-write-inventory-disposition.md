---
title: FN-9537 orphan durable-write inventory disposition
category: test-failure
module: "@fusion/engine"
problem_type: ci-evidence
---

# FN-9537 orphan durable-write inventory disposition

## Immutable hosted failure

The original failure is Full Suite (non-blocking) run [`38289329239`](https://github.com/Runfusion/Fusion/actions/runs/38289329239), attempt `1`, on `main` at `9b3f3a7467237bf0b636d6429a60e75cda5e5fe9`. The run started at `2026-10-12T18:12:18Z`, completed with `failure` at `2026-10-12T18:40:07Z`, and therefore lasted 27 minutes 49 seconds.

Its failed shard was [Test shard 2/4](https://github.com/Runfusion/Fusion/actions/runs/38289329239/job/114945310419), which ran from `2026-10-12T18:12:21Z` to `2026-10-12T18:35:54Z` and concluded `failure`. The retained `post-merge-full-suite-evidence` artifact is [`11766761884`](https://github.com/Runfusion/Fusion/actions/artifacts/11766761884). It was available when this record was written; its published and locally verified digest is `sha256:6ccc157a80ebac3d57b9ee58afd90a7473b8ab0414d9def4ef63bdba21c97e55`.

The artifact's shard-2 timing report records these failed assertions from `merge-orphan-durable-write-inventory-drift.test.ts`:

- `FN-8923 orphan durable-write inventory drift guard is bijective by call-site id and fingerprint and fails closed on suspects`
- `FN-8923 orphan durable-write inventory drift guard rebuilds a current manifest without changing it`

The timing artifact identifies failed tests, not their assertion-diff text. The historical delta is nevertheless independently attributable from the source and fixture at that run's ancestry: the manifest lacked these derived call sites:

- `packages/engine/src/scheduler.ts::invalidateMismatchedFileScopeLeaseRelease::store.updateTaskAtomic::#1`
- `packages/engine/src/scheduler.ts::revalidateFileScopeLeaseReleases>revalidated::store.updateTaskAtomic::#1`

This record does not convert the historical failure into a pass.

## Source attribution and reviewed disposition

`git blame` and `git show c133c50e5639bc3caded5a1d6eeb17c3d1f784d9 -- packages/engine/src/scheduler.ts` attribute both durable calls to FN-9529. That source change added revision-fenced clearing of stale clean-checkout file-scope lease-release receipts:

- `invalidateMismatchedFileScopeLeaseRelease` returns without mutation for an absent receipt or matching scope. On a mismatch, its atomic callback clears only when the current receipt still has the observed revision and scope fingerprint; a concurrent change returns `null`. Its caller is the scheduler's overlap classification pass, with an outer-dispatch helper using the same function.
- `revalidateFileScopeLeaseReleases` skips non-clean-checkout receipts and clean retained checkouts. When inspection fails, is dirty, or cannot be completed, its atomic callback clears only when the current receipt keeps the observed revision; otherwise it returns `null`. Its caller is the scheduler's hold-release sweep before admission.

Neither helper is called by `runAiMerge`, `landWorkspaceTask`, or `landOneRepo`. They are present in the AST import closure as independent scheduler and dispatch infrastructure, but closure membership is not a merge-body call edge. An aborted or orphaned merge body therefore cannot reach either write. Both entries carry the complete required `out-of-frontier` tuple: `axis1`, final lifecycle, and observation are `out-of-frontier`; execution proof and follow-up are respectively `none:out-of-frontier` and `none:out-of-frontier`.

FN-9538 (`ed75d905761d8e67a571dea3267116b66163b405`) landed the manifest and reliability-document repair after the failed run. It added only these two reviewed entries and reconciled the documented totals to 428 derived call sites: 363 out-of-frontier and 65 frontier entries. Earlier FN-9504, FN-9514, and FN-9533 commits refreshed fixture data but did not add the FN-9529 scheduler source; they are not the source attribution for this drift.

## Local verification

On the checkout containing FN-9538, the following focused guard passed with regeneration disabled:

```text
pnpm --filter @fusion/engine exec vitest run src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts --project=engine-default --silent=passed-only --reporter=dot
```

The guard ran eight assertions successfully. It verifies the writer surface and import closure, exact call-site ID/fingerprint bijection, final lifecycle tuple, unchanged rebuild, red `pending:classify` handling for missing entries, preservation of human verdicts through structural regeneration, and refusal of unclassified writers or unresolved receivers. A regeneration run with `FUSION_UPDATE_MERGE_INVENTORY=1` also passed and left the manifest unchanged. The guard is outside the curated `engine-core` merge gate and is exercised by affected/full-suite lanes.

The final workspace verification on this repair checkout also passed: `pnpm lint`, `pnpm verify:fast`, and `pnpm build`. No changeset is required because this repair updates an inventory and its evidence documentation without changing published-package behavior.

## Subsequent hosted-run rule

No subsequent hosted run is claimed by this document. A later run may be recorded as eligible repair evidence only when it identifies its run URL and ID, source SHA, shard/job URL, artifact ID and digest when retained, and the exact result of both named FN-8923 assertions. It must remain separate from the immutable failure above; a local pass, a different source SHA without shard evidence, or an artifact that omits the assertions is not a hosted-pass disposition.
