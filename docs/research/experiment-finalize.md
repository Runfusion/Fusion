# Experiment Session Finalize Workflow

## Motivation
FN-4136 identified a gap versus upstream `autoresearch-finalize`: Fusion had no workflow to split kept experiment commits into reviewable branches from a shared merge-base.

## Plan model
Finalize builds groups of kept run records, each with ordered commits and a suggested branch name. Branch names default to:

`experiment/<session-id>/<slug>-<index>`

Override schema:

```json
{
  "groups": [
    {
      "id": "segment:1",
      "title": "Latency fixes",
      "suggestedBranchName": "experiment/exp-1/latency-fixes-1",
      "runRecordIds": ["RUN-2", "RUN-5"]
    }
  ]
}
```

## Algorithm
1. Resolve merge-base from session baseline ref and integration branch.
2. Build default plan from kept runs.
3. Apply optional override and validate run IDs / branch uniqueness.
4. For each group: create branch at merge-base, checkout, cherry-pick commits in order.
5. Restore original ref.
6. Append `finalize` session record and move session to `finalized`.
7. On failure, rollback created branches and restore original ref; session remains `finalizing`.

## Error taxonomy

| Error code | CLI exit | HTTP status |
|---|---:|---:|
| `state_error` | 2 | 409 |
| `no_kept_runs` | 3 | 409 |
| `plan_error` | 4 | 400 |
| `merge_base_error` | 5 | 422 |
| `cherry_pick_conflict` | 6 | 422 |
| `branch_exists` | 7 | 409 |
| unknown/untyped | 1 | 500 |

## Recovery
If finalize fails after session status moves to `finalizing`:
1. Inspect and delete leftover branches (`git branch -D <name>`).
2. Restore session status manually via store update to `active`.
3. Re-run finalize (optionally with a plan override).

## Follow-ups
- FN-4221: dashboard finalize UI wiring.
- FN-4223: naming clarifications around research/experiment command surfaces.
- Upstream reference: `autoresearch-finalize` branch-split semantics.
