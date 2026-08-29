# Task Lineage Reconciliation Notes

## FN-3953 historical mismatch (GitHub-tracking vs current task)

- Historical commit subject evidence:
  - `6871c510a feat(FN-3953): enable tracking issue creation on task edit and document the...`
- Current unrelated FN-3953 evidence:
  - `f6a1862f9 feat(FN-3953): wire agent provisioning approval policy into engine tools`
- Reconciled GitHub-tracking task lineage: `FN-3874`, `FN-3940`, `FN-3943`
- Summary: raw task-ID references in historical commits can map to different board meanings over time; therefore historical attribution must use immutable lineage IDs plus persisted association records rather than display task ID alone.
- Confidence: high

## Dashboard confidence semantics (FN-3998 follow-through)

Task detail → Changes now surfaces lineage commit associations from `GET /api/tasks/:id/commit-associations` with explicit confidence labels.

- `canonical`
  - Match source: `canonical-lineage-trailer`
  - Meaning: commit carries immutable lineage trailer and is safe to treat as authoritative task attribution.
- `legacy`
  - Match source: `legacy-task-id-trailer` or `legacy-subject`
  - Meaning: attribution recovered from pre-lineage-era metadata; useful but weaker than canonical lineage identity.
- `ambiguous`
  - Match source: `manual-reconciliation`
  - Meaning: historical overlap required manual reconciliation; must remain visibly weaker in UI and should not be presented as canonical evidence.

When consuming this endpoint, prefer confidence-driven copy/visual hierarchy rather than flattening all rows into an equivalent "task commit" presentation.
