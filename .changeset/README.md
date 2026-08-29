# Changeset Format Guide

Each changeset file in this directory describes one user-facing change for release notes.

## Required body format

```
---
"@runfusion/fusion": minor
---

summary: Add a Command Center productivity control for LOC backfills.
category: feature
dev: Uses the new `fn_backfill_loc` tool; settings key `commandCenter.locBackfill`.
```

## Fields

| Field | Required | Description |
|-------|----------|-------------|
| `summary` | Yes | One line, user-facing, max 120 chars. Describe what changed for the operator. |
| `category` | Yes | One of: `feature`, `fix`, `breaking`, `security`, `performance`, `internal`. |
| `dev` | No | Developer or migration detail. Preserved in per-package CHANGELOGs but excluded from distilled release notes. |

## Audience

The `summary` is the only content that appears in end-user release notes by default. Write for Fusion operators — describe behavior, fixes, and what changed. Avoid internal class names, file paths, and implementation detail.

## Bump types

- `patch` — bug fixes, internal changes
- `minor` — new features, CLI additions, tools
- `major` — breaking changes

## Validation

Run `pnpm check:changesets` to validate. The linter runs in the PR-check gate and `test:gate`. Legacy freeform changesets pass with a warning during the transition period.
