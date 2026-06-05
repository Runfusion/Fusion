---
module: dashboard-testing
date: "2026-06-04"
problem_type: developer_experience
title: "Browser-testing the Fusion dashboard from a worktree safely (no engine, fresh bundle, free port)"
applies_when: "Running browser/E2E verification of dashboard changes from a linked worktree during a pipeline (ce-test-browser or manual agent-browser sessions)"
tags:
  - "browser-testing"
  - "fn-dashboard"
  - "worktree"
  - "stale-dist"
  - "port-4040"
  - "fusion-daemon"
---

# Browser-testing the Fusion dashboard from a worktree safely

## Context

During the step-inversion pipeline (PR #1424), browser verification of dashboard changes from a linked worktree hit three traps in sequence, two of them dangerous:

1. **`fn daemon --paused` still executed real tasks.** The daemon shares the user's central DB; within ~60s it spun up executor sessions on live tasks (racing the user's main instance — a dual-engine hazard) despite `--paused`. The `--paused` flag does not prevent engine dispatch in this path.
2. **`fn dashboard --dev` (no `--port`) bound the reserved port 4040** — the default in `packages/cli/src/bin.ts` is 4040, which is reserved for the user's own dashboard (see `dev-server-port-detect.ts: RESERVED_DASHBOARD_PORT`).
3. **The served UI bundle was stale.** `fn dashboard` serves `packages/cli/dist/client` (the CLI's own copy of the dashboard build), NOT `packages/dashboard/dist/client`. Rebuilding `@fusion/dashboard` does not update the CLI copy — newly added React Flow node types rendered as `react-flow__node-default` and foreach template children were missing from the DOM entirely, which looked exactly like a source bug (it wasn't).

## Guidance

The safe recipe for worktree browser testing:

```bash
pnpm --filter @fusion/core --filter @fusion/engine --filter @fusion/dashboard \
     --filter "@fusion-plugin-examples/*" build

FUSION_ALLOW_NESTED_PROJECT=1 FUSION_SKIP_ONBOARDING=1 \
FUSION_CLIENT_DIR=$PWD/packages/dashboard/dist/client \
node packages/cli/bin.mjs dashboard --dev --port 4101 --token cetest123 &
# open: http://localhost:4101/?token=cetest123
```

- **`fn dashboard --dev`** = web UI only, AI engine disabled. Never use `fn daemon`/`fn serve` for UI verification — they run the engine against the shared central DB.
- **Always pass `--port <free>`** (anything but 4040). The dashboard subcommand's default is the reserved 4040.
- **`FUSION_CLIENT_DIR` pointed at the fresh `packages/dashboard/dist/client`** beats the CLI's stale `packages/cli/dist/client` copy. Without it, UI changes silently don't appear.
- Killing your own spawned test server is fine; the no-kill rule protects the user's live instance on 4040.
- If the canvas "renders nothing": check the served bundle hash before debugging source — `agent-browser eval` on `document.querySelectorAll('.react-flow__node')` distinguishes "nodes absent" from "nodes mis-typed" (`react-flow__node-default` = nodeType not registered in the served bundle).

## Why This Matters

The daemon trap is a data hazard, not just wasted time: two engines on one SQLite central DB race task leases and can strand tasks in limbo. The stale-bundle trap costs hours because it perfectly mimics a source-level rendering bug — the jsdom tests pass (they test source) while the browser shows old behavior (it serves dist).

## When to Apply

Any time a pipeline or agent verifies dashboard behavior in a real browser from a worktree: ce-test-browser runs, manual agent-browser sessions, screenshot verification of editor/board changes.

## Examples

Diagnosing the stale bundle (PR #1424): source `WorkflowNodeTypes.tsx` registered `foreach`, jsdom tests green, but live DOM showed `react-flow__node-default` for the foreach node and no `steps::*` children. `grep nodeTypes` in the served `WorkflowNodeEditor-*.js` chunk showed the registry ending at `join` — a pre-U8 bundle from `packages/cli/dist/client`.
