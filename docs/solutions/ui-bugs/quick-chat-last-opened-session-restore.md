---
title: "Quick Chat last-opened session restore"
date: 2026-06-17
category: ui-bugs
module: packages/dashboard/app/components/QuickChatFAB
problem_type: ui_bug
component: frontend_quick_chat
applies_when: "Quick Chat restores direct chat sessions after reloads, project switches, or a cold FAB open while session fetching is still in flight."
symptoms:
  - "Opening Quick Chat restores an older or seemingly random direct thread"
  - "The wrong thread often shares the same agent or model target as the intended last-opened session"
  - "The persisted last-session localStorage key is overwritten before the real session list restore can run"
root_cause: automatic_same_target_resolution_raced_persisted_id_restore
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/components/QuickChatFAB.tsx
  - packages/dashboard/app/hooks/useQuickChat.ts
  - packages/dashboard/app/hooks/quickChatLastSessionStorage.ts
  - FN-3972
  - FN-4235
  - FN-4430
  - FN-6510
tags:
  - quick-chat
  - session-restore
  - localstorage
  - same-target-collision
  - regression-test
---

# Quick Chat last-opened session restore

## Problem

Quick Chat stores the last opened direct session in `fusion:quick-chat-last-session:<projectId>`. A cold open can request sessions and models at the same time. If automatic target initialization (`switchSession` / `startModelChat`) runs before the session list returns, it can resolve a same-target session from the server, set it active, and trigger the hook's active-session persistence effect. That overwrites the persisted id before the restore effect can find the user's exact last-opened session.

This failure is easy to miss when tests only use different targets. The important repro has two active sessions sharing the same agent or model target, with the persisted session not being the newest/touched one for that target.

## Solution

Treat the persisted id as the source of truth until the initial direct-session restore has either used it or proven it stale.

- While a persisted last-session id exists and the initial session fetch is still loading, do not run automatic target initialization.
- When a session is restored from the list, skip the first automatic same-target switch. Restore is id-specific; same target is not equivalent.
- For stale or missing persisted ids, rank fallback sessions by `lastMessageAt` before `updatedAt` so metadata-only updates do not displace the latest real conversation.
- Keep chat rooms separate from direct-session restore; room active state should not feed the last direct-session key.

## Regression coverage

Use DOM tests around `QuickChatFAB` for the real symptom because the race spans component restore effects, model/agent target selection, and the `useQuickChat` persistence effect.

Cover:

- Agent-backed and model-backed same-target collisions.
- Delayed session fetches where auto-init would previously clobber `localStorage`.
- Valid, stale/missing, and archived persisted ids.
- Empty/single/multiple session lists.
- Fresh render, warm close/reopen, project switch, desktop FAB, and mobile FAB paths.
- Hook-level same-target replay (`selectSession` followed by `switchSession` for the same target) so the active id and persisted id remain the selected session.
