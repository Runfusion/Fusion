---
title: FN-9540 orphan durable-write inventory rebuild disposition
category: test-failure
module: "@fusion/engine"
problem_type: ci-evidence
---

# FN-9540 orphan durable-write inventory rebuild disposition

<!--
FNXC:MergeReliability 2026-10-12-20:35:
A durable-write inventory location is AST-derived structural evidence, not a reviewed reachability verdict. Refresh only changed structural fields so an orphan merge-body guard stays fail-closed for new writers, unresolved receivers, and changed lifecycle evidence.
-->

## Immutable hosted failure

Full Suite run [`38298429801`](https://github.com/Runfusion/Fusion/actions/runs/38298429801), attempt `1`, ran on `main` at `3ab7bc031056f6e91c512f6440b2254c23daf085`. It started at `2026-10-12T19:33:24Z`, completed with `failure` at `2026-10-12T19:56:30Z`, and the failed [Test shard 2/4 job `114975116346`](https://github.com/Runfusion/Fusion/actions/runs/38298429801/job/114975116346) ran from `2026-10-12T19:33:27Z` to `2026-10-12T19:56:12Z`.

The run retained these artifacts:

- [`post-merge-full-suite-evidence` artifact `11769924844`](https://github.com/Runfusion/Fusion/actions/artifacts/11769924844), created `2026-10-12T19:56:27Z`, `sha256:92b9c7e5b09d96b56937b154aa2783c0f6bfbb2a62560353cb1017f63f767ba5`.
- [`test-timings-shard-2` artifact `11769959894`](https://github.com/Runfusion/Fusion/actions/artifacts/11769959894), created `2026-10-12T19:56:08Z`, `sha256:a71c9b0d751ee633e15b4cd3745622cc2e666ec264b2f9a1fe8a80c49b2d819d`.

Authenticated GitHub metadata retrieval confirmed both artifact names, URLs, retention, sizes, and published digests. Binary artifact extraction was not completed because this hosted execution environment rejected the artifact-download output path as outside the worktree boundary; this record does not invent artifact contents. The original assertion result was reproduced locally from the named source revision lineage: `FN-8923 orphan durable-write inventory drift guard > rebuilds a current manifest without changing it` failed, while the other seven assertions passed.

## Root cause and repair

FN-9538 (`ed75d905761d8e67a571dea3267116b66163b405`) added two reviewed scheduler entries to the manifest. Its reviewed identities, fingerprints, writers, reachable states, and complete `out-of-frontier` verdict tuple were correct.

FN-9536 (`6c8004ba208dff01631cc79f505ef0cf25a6dea6`) later inserted one line in `packages/engine/src/scheduler.ts` before both calls. `git show` and `git blame` confirm that the inserted `task.overlapBlockedBy` fingerprint component shifted only the AST source locations. The exact fixed-point repair is:

| Call-site ID | Old line hint | New line hint |
| --- | ---: | ---: |
| `packages/engine/src/scheduler.ts::invalidateMismatchedFileScopeLeaseRelease::store.updateTaskAtomic::#1` | 724 | 725 |
| `packages/engine/src/scheduler.ts::revalidateFileScopeLeaseReleases>revalidated::store.updateTaskAtomic::#1` | 737 | 738 |

No call-site ID, fingerprint, writer, ordinal, frontier boundary, classification, human evidence, reachability tuple, scanned-module closure, writer surface, or aggregate count changed. The entries remain scheduler-only and `out-of-frontier`: they have no call edge from `runAiMerge`, `landWorkspaceTask`, or `landOneRepo`.

## Local verification

Before repair, with `FUSION_UPDATE_MERGE_INVENTORY` unset, the focused guard produced the exact two-line `lineHint` delta above and failed only the unchanged-rebuild assertion; seven tests passed.

After the manifest repair, the following commands completed successfully:

- Focused engine inventory guard with regeneration disabled: eight tests passed.
- Focused engine inventory guard with `FUSION_UPDATE_MERGE_INVENTORY=1`: eight tests passed.
- Fixed-point check: the regeneration left `merge-orphan-durable-write-inventory.json` unchanged.
- `pnpm lint`.
- `pnpm verify:fast`.
- `pnpm build`.

The focused guard still requires exact call-site/fingerprint bijection and final lifecycle tuples, gives missing entries `pending:classify`, and refuses unclassified `TaskStore` writers and unresolved receivers. The repair therefore restores parity without weakening the inventory's fail-closed behavior.

## Hosted-evidence rule

This local verification is not a hosted rerun. Record a later hosted pass only with its run ID and URL, source SHA, shard/job identity, retained artifact ID and digest, and the exact result of the named unchanged-rebuild assertion. Do not infer a hosted pass from this local result or from artifact metadata alone.
