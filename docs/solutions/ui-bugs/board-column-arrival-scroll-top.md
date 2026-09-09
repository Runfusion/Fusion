---
title: "Board columns start at the top on arrival"
date: 2026-09-09
category: ui-bugs
module: packages/dashboard/app/components/Board
problem_type: ui_bug
component: frontend_board_navigation
applies_when: "Board is mounted, reactivated from keep-alive, restored after Task Detail, or replayed after a tab reload/discard."
symptoms:
  - "Done can open on its last task instead of its first task"
  - "A retained or persisted vertical lane offset can survive navigation back to Board"
  - "Horizontal Board position must remain restored"
root_cause: vertical_lane_offsets_shared_snapshot_restore_authority
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/Board.tsx
  - packages/dashboard/app/components/Column.tsx
  - packages/dashboard/app/hooks/useBoardScrollRestore.ts
  - packages/dashboard/app/utils/boardScrollSnapshot.ts
  - FN-330
tags:
  - board
  - scroll
  - keep-alive
  - virtualization
  - session-restore
---

# Board columns start at the top on arrival

## Problem

Board navigation previously treated horizontal Board context and each column's vertical offset as one restoration contract. A Done lane could therefore reopen at its last task after Task Detail, keep-alive reactivation, or a persisted reload/discard replay. Delayed replay was especially risky because it could overwrite an earlier top alignment after workflow columns hydrated.

## Invariant

Every Board arrival is a vertical navigation boundary. On initial mount and on an `active: false → true` transition, every rendered `.column-body` starts at `scrollTop = 0`, independent of its id, workflow, traits, task count, pagination state, or viewport width. Horizontal Board, project-shell, and document offsets remain eligible for restoration.

After the boundary, ordinary task refreshes, SSE updates, and pagination must not apply the reset again. User scrolling is authoritative until the next genuine Board arrival.

## Solution

Use one column-reset primitive for both the Board arrival effect and snapshot replay. The primitive distinguishes an absent Board, a Board whose columns are still pending, and a ready Board. For every ready column it writes zero and dispatches a scroll event; the event is required because `useVirtualizedList` maintains geometry in React state and a DOM-only write would leave the rendered window near the old offset.

Snapshots retain column identities for hydration and stale-project validation, but newly captured offsets are zero. Legacy session payloads with non-zero `columnTops` remain parseable and are normalized at application time. Bounded reload replay can wait for columns and preserve horizontal context, but it can never restore a vertical offset. Existing wheel, touch, and keyboard cancellation still prevents replay from fighting user input.

## Regression coverage

Cover the shared invariant rather than the literal `done` id:

- selected-workflow and aggregate columns, including complete, non-complete, custom, empty, populated, virtualized, and paginated lanes;
- desktop and mobile widths (1200, 768, and 600);
- initial mount, keep-alive reactivation, Task Detail return, immediate reload replay, and empty-then-hydrated replay;
- absent, invalid, stale, and legacy non-zero snapshots;
- first-row virtualizer rendering after reset and preservation of later user scroll during an active data refresh;
- horizontal Board and shell restoration, bounded retry cleanup, and cancellation on user input.
