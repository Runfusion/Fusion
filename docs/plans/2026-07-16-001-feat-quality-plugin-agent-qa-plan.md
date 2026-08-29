---
title: "feat: Quality plugin v2 — post-merge agent QA, evidence packs, and the QA results board"
type: feat
status: active
date: 2026-07-16
origin: docs/plans/2026-07-14-001-feat-quality-plugin-plan.md
updated: 2026-07-16
---

# feat: Quality plugin v2 — post-merge agent QA, evidence packs, and the QA results board

## Summary

Evolve `fusion-plugin-quality` from a manual per-task QA surface into a **post-merge, agent-driven QA system**: done tasks are QA'd by an agent that resurrects the task's code in a QA worktree, browser-exercises the change, walks the suggested cases, runs targeted tests, probes adjacent surfaces for regressions, and produces an **evidence pack** (screenshots + per-case verdicts). Failures file follow-up tasks with evidence attached. The Quality hub becomes a **QA results board**: queue + verdicts, evidence gallery, CI + gate health.

## Operator interview findings (2026-07-16)

How QA actually happens today and what the operator wants next:

- **Current flow:** trusts executor/reviewer verification for most tasks; manually previews in a browser for the ones that matter.
- **Top pains:** (1) knowing *what* to check for a given task, (2) no visual evidence on landed tasks, (3) too many surfaces (terminal, Dev Server, Artifacts, PR checks).
- **Desired direction:** agent-driven QA + zero-click evidence + hub/CI depth. Explicitly *not* asking for more manual-tab polish as the priority.
- **QA timing:** **after merge (done tasks)** and in **batch sessions** — not a pre-merge gate. The done-task QA worktree path (FN-2127) is the intended substrate, not an edge case.
- **Agent session scope:** browser-exercise the change + capture evidence pack + run targeted tests + **Surface-Enumeration-bounded regression hunt** (adjacent surfaces derived from the diff: both breakpoints, shared components, sibling states — not open-ended roaming).
- **Trigger:** auto-queue on done, **setting-gated per project** (off by default), with concurrency cap and per-session budget.
- **On failure:** auto-file a follow-up bug task with evidence attached, linked to the original.
- **Hub first paint:** QA queue + verdicts, evidence gallery, CI + gate health. Test plans (U4 runner) were *not* selected — park them.
- **First slice:** prove the **agent QA engine** end-to-end on one done task (manual trigger) before building queue/auto plumbing.

## Current state (v1 audit, 2026-07-16)

From the v1 plan (2026-07-14) units:

| Unit | Status | Notes |
|------|--------|-------|
| U1 scaffold/registration/slot context | ✅ done | Full registration matrix; `TaskDetailModal` injects `taskId`/`worktree`/`projectId`/`modifiedFiles` |
| U2 schema/store | ✅ done | Dual SQLite/PG, projectId-scoped, retention pruning |
| U3 presets/runner/hub runs | ✅ done | 5 allowlisted presets, `superviseSpawn` from `@fusion/core` (shim not needed), 409 concurrency |
| U6 Task QA tab shell | ✅ done | Action-first sections; Run tests + Reports functional |
| U11 task preview server | ✅ done | Incl. **done-task QA worktrees** (`preview/task-code-worktree.ts`: `.fusion/quality-qa/<taskId>`, branch → `fusion/<id>` → `mergeDetails.commitSha`) — also used for task-scoped test runs |
| U13 suggested cases | ◐ partial | Heuristics only; checklist is display-only (no tick/copy/run-related); no AI enrichment |
| U4 test plans | ◐ partial | Store + CRUD routes; no runner, no UI — **parked by this plan** |
| U5 CI read-only | ✗ placeholder | Static text in tab; no host route |
| U12 screenshots gallery | ✗ placeholder | Static text in tab |
| U7 browser-verification toggle | ✗ not started | In-review-oriented — **deprioritized** (operator QAs post-merge) |
| U9 workflow palette | ✗ not started | **Deprioritized** for same reason |
| U10 agent QA sessions | ✗ not started | **Becomes the centerpiece of this plan** |

Known rough edges to absorb: preview sessions are an in-memory singleton (lost on restart, unlike runs); suggested-case `done` is stored but untoggleable; dead ternary in `create-routes.ts` `confirm_required` branch; `ensureQualitySchema` runs per request; all routes gated on `experimentalFeatures.qualityPlugin`.

## Product shape

```text
Task merges → done
  └─ (if project autoQa enabled) enqueue QA job
       └─ Agent QA session (cap N concurrent, budgeted)
            1. Resolve QA worktree (done-task resurrection path — already shipped)
            2. Install/build if needed; start preview session (free port, never 4040)
            3. Load QA script: AI-enriched suggested cases + Surface Enumeration targets from diff
            4. Browser-exercise change (agent-browser skill); capture screenshots per case
            5. Run targeted tests (file-scoped preset) into the same session record
            6. Regression hunt: adjacent surfaces only (both breakpoints, shared components, sibling states)
            7. Emit structured verdict: per-case pass/fail/blocked + evidence artifact refs + summary
       └─ Verdict lands in hub QA board + task QA tab
            ├─ pass → evidence pack visible on task (zero-click evidence)
            └─ fail → auto-file follow-up bug task (evidence attached, linked to original)
Hub = QA results board: queue/in-flight/verdicts | evidence gallery | CI + gate health
```

Invariants carried forward from v1 (unchanged): advisory only — never merge-blocking; allowlisted commands only; never port 4040; never `execSync`; compose agent-browser + artifact registry + Dev Server patterns rather than forking them; projectId isolation on every row.

New invariants:

- **Agent QA is read-only on the repo**: sessions never commit, push, merge, or mutate task lifecycle except (a) writing QA records/artifacts and (b) filing the follow-up task through the normal task-creation path.
- **Budgets are hard**: per-session wall-clock + token budget; inactivity watchdog; queue concurrency cap (default 1). Exhaustion → `blocked` verdict, never silent partial pass.
- **Auto-QA is opt-in per project** (`autoQa.enabled`, default false). Manual trigger works regardless of the auto setting.
- **Evidence lives in the artifact registry** (task-scoped image artifacts), not a parallel media store; QA records hold refs only.

## Implementation units

### V1. Agent QA session engine (manual, single task) — first slice

**Goal:** From a done task's QA tab, one click starts an agent QA session that ends with a structured verdict and at least one captured screenshot. Prove the whole loop before any queue exists.

- New `src/agent-qa/`: session orchestrator using `ctx.createInteractiveAiSession` (probe; empty-state CTA when engine factory missing), CE detach + `onProgress` + inactivity watchdog pattern.
- Session cwd = QA worktree from `resolveTaskCodeCwd` (reuse as-is); orchestrator owns preview-session start/stop around the agent run.
- System prompt: QA charter — walk the provided case list, capture screenshot evidence per case via agent-browser, run the file-scoped test preset, then Surface-Enumeration hunt (explicit target list provided, see V3), return verdict JSON `{cases: [{id, verdict: pass|fail|blocked, evidence: [artifactRef], note}], regressions: [...], summary}`.
- New store table `qa_sessions` (projectId, taskId, status queued|running|passed|failed|blocked|error|cancelled, budgets, verdict JSON, startedAt/finishedAt); routes start/get/cancel; honor mock/testMode; never log tokens.
- QA tab: "Agent QA" section becomes real — start button (done tasks included), live progress, verdict rendering.
- Tests: mocked interactive session; detach semantics; watchdog; verdict persistence; factory-missing empty state; testMode.

### V2. Evidence pack + screenshots gallery (completes U12)

**Goal:** Zero-click evidence — opening a done task's QA tab shows what the change looks like.

- Evidence capture path: agent sessions register screenshots as task-scoped image artifacts (artifact registry); QA session verdict stores artifact refs.
- Screenshots section: task-filtered artifact gallery (image MIME) + `design-preview` doc link + QA-session evidence grouped by case; thumbnails, open-in-Artifacts; actionable empty state ("Run agent QA").
- Tests: populated/empty/cross-task isolation; evidence-ref integrity when artifacts pruned.

### V3. QA script: AI-enriched suggested cases + Surface Enumeration targets (completes U13)

**Goal:** Suggested cases become the executable QA script consumed by both the operator and the agent.

- AI enrichment via short `createAiSession` pass over PROMPT + file scope + diff summary; fail-soft to existing heuristics; `method` field distinguishes heuristic/ai.
- New deterministic **surface-target derivation** from the diff (the regression-hunt bound): changed components → both breakpoints, shared hooks/components that reuse them, sibling data states — reusing the Surface Enumeration checklist taxonomy from `docs/testing.md`.
- Checklist UI becomes interactive: tick (persisted `done`), copy-all, "run related tests" wiring to the file-scoped preset. Agent verdicts auto-tick cases they cover.
- Tests: AI-failure fallback; tick persistence; target derivation from representative diffs.

### V4. Verdict → follow-up task filing

**Goal:** A failed QA verdict becomes an actionable, evidence-backed bug task without operator typing.

- On `failed` verdict (auto mode) or via "File follow-up" button (manual): create a bug task through the normal task-creation path — title from failing case, body with **Original symptom / Exact reproduction / evidence artifact links**, link to the original task (dependency/reference), evidence attached.
- Setting `autoQa.fileFollowUps`: `auto` | `draft-confirm` | `off` (default `auto` per interview, but respect global testMode).
- Never reopen/move the original task; never touch merge state.
- Tests: filing payload shape; dedup (same case doesn't file twice across re-runs); off/draft modes.

### V5. QA queue: auto-trigger on done, batch sweep, budgets

**Goal:** Setting-gated projects get every done task QA'd automatically; any project can run a batch sweep.

- Queue table + worker loop inside the plugin (supervised, resumable on restart — persist queue rows, reconcile in-flight on boot); enqueue hook on task→done transition (plugin lifecycle hook or poll fallback); concurrency cap (default 1, max 2); per-session budget settings.
- Batch sweep: hub action "QA last N done tasks" → enqueues; idempotent (skip tasks with a fresh verdict unless forced).
- Settings: `autoQa.enabled` (per project, default false), `autoQa.concurrency`, `autoQa.sessionBudget{Ms,Tokens}`, `autoQa.fileFollowUps`.
- QA-worktree hygiene: cap live QA worktrees, prune oldest on enqueue (bounded, prefix-scoped — never temp-root walks).
- Tests: gating off by default; cap enforcement; restart reconciliation; idempotent sweep.

### V6. Hub → QA results board (+ CI/gate health, completes U5)

**Goal:** First paint answers "what shipped, was it QA'd, did anything break?"

- Board layout: **QA queue + verdicts** (awaiting / in-flight / recent verdicts with evidence links, filter by pass/fail) | **evidence gallery** (recent screenshots across tasks, click → task QA tab) | **CI + gate health** (host-owned read route reusing dashboard GitHub auth for open-PR check rollups + default-branch gate status; auth/empty/429 states; read-only).
- Keep existing run history reachable; park Plans UI behind an overflow section (store/CRUD kept, runner still unbuilt — explicitly deferred).
- Tests: board states (empty project, queue drained, failures present); CI route auth empty states; no plugin import of dashboard-private GitHub client.

### V7. Hardening + polish (absorbs v1 rough edges)

- Persist preview sessions (or reconcile-on-boot kill+mark), replacing the in-memory-only singleton.
- Fix dead `confirm_required` ternary; memoize schema init per store instance.
- Graduation criteria for the `experimentalFeatures.qualityPlugin` gate (documented; flip is a separate operator decision).
- Settings/docs/CONCEPTS updates (Agent QA Session, QA Verdict, Evidence Pack, QA Queue); FNXC comments on budgets, read-only session posture, follow-up filing policy; changeset (`minor`) when the published surface ships.

## Phasing

| Phase | Units | Ship gate |
|-------|-------|-----------|
| A — Prove the loop | V1 | Manual agent QA on a done task yields verdict + screenshot |
| B — Evidence + script | V2, V3 | Zero-click evidence on QA'd tasks; cases drive both human and agent QA |
| C — Close the loop | V4 | Failed verdicts file linked, evidence-backed follow-ups |
| D — Scale | V5, V6 | Opt-in projects auto-QA every done task; hub is the results board |
| E — Polish | V7 | Rough edges gone; docs/changeset shipped |

## Explicitly parked (from v1 plan)

- U4 plan runner + plans UI (operator did not select; CRUD substrate kept)
- U7 browser-verification toggle and U9 workflow palette (pre-merge-oriented; this plan is post-merge)
- Pre-merge QA gating of any kind (advisory promise unchanged)
- Pixel-diff/visual-regression product; multi-provider CI; Actions log streaming

## Risks

| Risk | Mitigation |
|------|------------|
| Agent QA cost blowup | Off by default; per-project opt-in; concurrency cap; hard session budgets; `blocked` on exhaustion |
| False-positive follow-up spam | Dedup per case+task; `draft-confirm` mode; evidence required in every filed task |
| QA worktree disk growth | Live-worktree cap + prune on enqueue (prefix-scoped) |
| Agent mutates repo/tasks | Read-only session charter + tool posture; only artifact/QA-record writes + task-creation seam |
| Preview/build fails on resurrected code | `blocked` verdict with build log evidence, not `failed`; surfaces as actionable in board |
| Regression hunt scope creep | Deterministic target list from diff (V3); agent may not add targets beyond budget |
