---
title: "feat: Workflow editor consolidation — primary entry, step migration, import/export, AI design"
type: feat
status: completed
date: 2026-06-04
depth: deep
origin: none (solo planning bootstrap)
---

# feat: Workflow editor consolidation — primary entry, step migration, import/export, AI design

## Summary

Make the graph node editor the single workflow surface: the header/mobile entry opens it directly and the legacy `WorkflowStepManager` is retired; legacy `WorkflowStep` records auto-migrate into a template library (fragments + a combined default workflow); workflow creation gains a template picker; workflows and templates round-trip as JSON files; and an in-editor "design with AI" affordance plus verified agent-tool exposure make workflows fully agent-authorable. Engine execution semantics are untouched.

---

## Problem Frame

The node editor is feature-rich (cards, success/failure edges, auto-layout, dialogs — plan 002) but buried: the Header's "Workflow Steps" button opens the legacy flat-steps `WorkflowStepManager`, and the graph editor is only reachable through a hand-off button inside it. Two parallel models confuse users: flat per-step records with `enabled`/`defaultOn` flags feeding per-step checkboxes in `TaskForm`, versus graph `WorkflowDefinition`s selected per task. Steps authored in the legacy screen have no representation in the editor; built-ins are the only "templates"; nothing imports or exports; and although `fn_workflow_*` agent tools exist in the executor, there is no user-facing AI authoring affordance and chat/planning-agent exposure is absent (they pass no workflow tools today).

---

## Scope Boundaries

### In scope
- Entry-point rewire (Header desktop + overflow, MobileNavBar) → node editor; full retirement of `WorkflowStepManager`.
- Steps→IR converter; idempotent migration of user-authored steps into fragments + a combined default workflow; `kind` discriminator on workflow definitions.
- Template picker on workflow creation; dynamic palette templates (fragments, built-in step templates, plugin-contributed step templates); safe fragment insertion.
- JSON import/export for workflows and fragments (built-ins exportable), with approval-flag stripping at the write boundary.
- `POST /api/workflows/design` AI endpoint + in-editor affordances; wire `fn_workflow_*` into chat/planning lanes via `customTools`.
- Workflow-centric `TaskForm`: per-step checkboxes replaced by a workflow picker, with a create-time `workflowId` path.

### Deferred to Follow-Up Work
- Removing the `WorkflowStep` records/routes/engine path itself — steps remain the compiled execution substrate (`materializeWorkflowSteps`, `enabledWorkflowSteps`); only their authoring UI is retired.
- Per-node "Refine with AI" inside the editor inspector (the legacy manager's refine button dies with it; whole-graph AI design covers v1).
- AI design retry/repair loops and streaming/detached turns (sync v1; upgrade path noted in KTD-6).
- Cross-project template gallery beyond file import/export; workflow versioning/history.
- Mobile-optimized canvas authoring.
- Schema-level rejection of trust-escalating config fields in `parseWorkflowIr` (point-fixed at import/design boundaries here; systemic enforcement is a follow-up).

### Outside this product's identity
- Changing how compiled steps execute, the seam model, or `parseWorkflowIr`/compiler semantics. Migration and import produce artifacts the existing validators accept; they never relax validation.

---

## Requirements

**Entry & consolidation**
- R1 — The Header button (desktop + overflow) and MobileNavBar item open the node editor directly; labels say "Workflows". No surface routes through the legacy manager.
- R2 — `WorkflowStepManager` is fully removed: component, tests, `useModalManager` state (`workflowStepsOpen`/`open`/`close`, `anyModalOpen` membership), `onOpenGraphEditor` hand-off, and `App.tsx`/`AppModals.tsx` wiring. `/api/workflow-steps` routes and step records remain (execution substrate). Removal lands only after R3's picker has replaced the per-step checkboxes (no release window with neither surface).
- R3 — `TaskForm`'s per-step checkbox list is replaced by a workflow picker: project default preselected and badged "(default)"; "No workflow" listed first; built-ins + user workflows (fragments excluded); loading placeholder while definitions fetch; helper text explains what the selected workflow runs. Selection is applied at create time via a new `workflowId` create parameter materialized server-side inside the task-creation transaction (see KTD-4). An empty/new project shows a CTA into the editor.

**Templates & migration**
- R4 — A pure steps→IR converter produces a valid v1 IR from a `WorkflowStep[]` (seams encoded per the `linear()` convention; `phase` honored, with undefined phase mapping to pre-merge; the merge seam always emitted); compiling the produced IR yields steps equivalent to the input over all compiler-visible fields (round-trip parity).
- R5 — On first editor open per project, user-authored steps (excluding `WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX`-tagged rows) migrate idempotently: **every** user step (enabled or not) → a single-node fragment; the **defaultOn** set → one combined "Migrated steps" workflow; when that set is non-empty the migrated workflow becomes the project default (preserving "new tasks run these" behavior). Enabled-but-optional steps remain available as fragments. Source steps are marked migrated; re-runs and concurrent opens create no duplicates. After a migration that produced anything, the editor shows a one-time dismissible notice explaining where steps went, and the migrated workflow carries a system description ("Converted from your legacy workflow steps").
- R6 — Workflow definitions carry `kind: "workflow" | "fragment"`; fragments never appear in task workflow pickers, default-workflow selection, or compile/selection paths.
- R7 — Workflow creation offers a template picker: blank, built-in workflows, and user workflows as starting points — copies with fresh IDs, never references. Each entry shows name, description, and node count; the copy's default name is the source name + " copy" and inherits the source description. With no user workflows, the picker shows blank + built-ins only.
- R8 — The editor palette gains a Templates section grouped into Fragments / Built-in steps / Plugin steps subsections (alphabetical within groups; a filter input appears when the combined list exceeds 8 entries; plugin entries carry the owner badge). Entries insert pre-configured nodes; insertion remaps node IDs and pre-validates seam duplication, surfacing conflicts as a persistent inline error in the palette section.

**Import/export**
- R9 — Any workflow or fragment (including built-ins) exports as a JSON envelope (format marker, schema version, kind, name, description, ir, layout) via file download. Export is disabled while the canvas is dirty (tooltip: save first); the export affordance notes that files contain full prompt/command text.
- R10 — Import validates the envelope and IR server-side at the write boundary; always mints a fresh ID (stripping `builtin:`); suffixes the name on collision; **strips `cliSkipApproval`/`autoApprove` from all node configs** (flagged in the response so the UI can notify); rejects IRs referencing unavailable traits/columns with a message naming the missing trait; warns (without blocking) when a script node's `scriptName` is absent from the target project. Envelopes with `schemaVersion` ≤ the server's are accepted; newer are rejected with a version message. Invalid files never persist partial state. Validation failures render as a persistent inline error near the import affordance (not a toast); the file input resets either way.

**AI & agents**
- R11 — "Design with AI" takes a prompt (and, for the edit flow, the persisted workflow read server-side by ID — the client never posts IR) and returns a server-validated IR with the same approval-flag stripping as import; failures and interpreter-only results reuse the existing banner triage; the canvas is never replaced without the dirty guard, and never on failure. The affordance shows an in-flight state (disabled control + spinner + `aria-busy`) and a client-side cancel; the route is rate-limited like the other AI routes.
- R12 — `fn_workflow_create/update/delete/list/get/select` are verifiably exposed to the task executor (existing), and to chat and planning lanes via `createFnAgent`'s `customTools`, with a guard test asserting all six tool names per lane.

---

## Key Technical Decisions

- KTD-1 — **Fragments are `WorkflowDefinition`s with a `kind` column, stored as parseable full IRs.** Add `kind TEXT NOT NULL DEFAULT 'workflow'` to `workflows` (`addColumnIfMissing`, SCHEMA_VERSION 108→109). A fragment's IR is a normal `start → nodes → end` v1 graph so `parseWorkflowIr` validates it unchanged; insertion strips `start`/`end` and remaps IDs. `createWorkflowDefinition` gains `input.kind` in both the definition object and the INSERT column list; fragment IRs are pure v1 so `downgradeIrToV1IfPure` leaves them intact. **Caching:** `listWorkflowDefinitions` keeps caching the full merged set; the `kind` filter applies to the returned slice after the cache read — never cache a filtered result (the single unconditional cache would otherwise poison unfiltered consumers).
- KTD-2 — **Steps→IR converter is the literal inverse of the compiler, proven by round-trip — and its blind spots are named.** New pure `stepsToWorkflowIr(steps)` in `@fusion/core` inverts `nodeToStepInput` field-by-field and encodes seams exactly as `linear()` does. Parity covers exactly the compiler-visible fields (`name/mode/phase/gateMode/prompt/scriptName/toolMode/modelProvider/modelId`); `enabled`/`defaultOn`/`templateId` are **not** compiler-visible and are handled by migration policy (KTD-3), not the converter. Undefined `phase` maps to pre-merge; the merge seam is always emitted. A comment at both `nodeToStepInput` and the converter requires extending parity when fields are added.
- KTD-3 — **Migration is lazy, server-side, marker-idempotent — and preserves defaultOn semantics via the project default.** `POST /api/workflows/migrate-legacy-steps` runs on first editor open inside `transactionImmediate` (write lock before the unmigrated-rows SELECT, matching `selectTaskWorkflow`'s pattern); each source row is stamped with `migratedFragmentId`. Representation policy: every user step → fragment (composable reuse in the palette); the **defaultOn** subset → the combined "Migrated steps" workflow (these were the steps that ran automatically on new tasks); if that subset is non-empty the migrated workflow is set as the project default so new-task behavior is preserved. Enabled-but-optional steps deliberately do NOT join the combined workflow — their per-task opt-in granularity maps to "insert the fragment" or "pick a different workflow", not to always-on execution. The combined workflow is a migration-continuity artifact (the TaskForm landing path for legacy users); fragments are the reusable pieces — that division is the payoff of the dual representation.
- KTD-4 — **TaskForm goes workflow-centric with a create-time `workflowId` parameter (user decision + feasibility correction).** `selectTaskWorkflow` requires an existing task ID and is NOT reusable at create time; instead, task-create input gains `workflowId?: string`, and the store materializes the selection inside the same task-creation transaction (mirroring the existing `materializeDefaultWorkflowSteps` + `pendingWorkflowSelection` + `writeTaskWorkflowSelection` default-workflow block at store.ts ~3974-4035). No create-then-select window exists, so the executor can never pick up a task with the wrong step set. `enabled`/`defaultOn` flags stop being user-facing.
- KTD-5 — **Import/export follows the Settings JSON pattern with a versioned envelope and trust-boundary stripping.** Client: `createObjectURL` download / `FileReader` upload. Server: `POST /api/workflows/import` validates envelope marker + schema version (≤ current accepted; newer rejected) + `parseWorkflowIr` + trait availability before any write; strips `cliSkipApproval`/`autoApprove` from node configs (these flags bypass the CLI first-run approval gate — the only user-visible gate on arbitrary command execution — and must not survive an untrusted file boundary); collision policy = fresh ID always, name suffix ` (imported)`.
- KTD-6 — **AI design reuses the refine-route pattern — synchronous, output-extracted, validated, stripped, canvas-safe, rate-limited.** `POST /api/workflows/design` constructs a one-shot tool-less agent via the `createFnAgent` DI seam (module-level `__setCreateFnAgentForDesign` co-located with the route), planning-lane model, system prompt that emits IR JSON (vocabulary per `fn_workflow_create`'s description). The accumulated text passes through the repo's existing JSON-from-text extraction helper (planning/agent-generation precedent — models fence and wrap JSON) before `parseWorkflowIr` + compile triage (interpreter-only via the message-suffix convention) + approval-flag stripping. For the edit flow the route takes a `workflowId` and reads the persisted IR from the store — the client never posts IR (removes the injection vector and matches how compile/selection routes work). Rate-limited 10/hour like `/ai/refine-text`. A detached-turn upgrade (observable-long-running pattern) is the documented path if design ever grows tools.
- KTD-7 — **Agent exposure is wired via `customTools`, not assumed.** `fn_workflow_*` live only in the task executor's toolset today; chat (`tools: "coding"`, no customTools) and planning (`customTools: createPlanningBoardTools`) gain the workflow tool factories through `createFnAgent`'s `customTools` option with a scoped store handle. A guard test asserts all six tool names per intended lane. Tool handlers parse args defensively (string-JSON accepted).
- KTD-8 — **Plugin step templates surface as a palette subsection.** The editor fetches `WORKFLOW_STEP_TEMPLATES` + the plugin template registry (client fn `fetchPluginWorkflowStepTemplates` already exists — currently consumed by the manager; it survives U3's deletion) and renders preset single nodes with config prefilled via the converter's field mapping.

---

## High-Level Technical Design

### Consolidation map

```mermaid
flowchart TB
  subgraph Entry
    HB[Header button + overflow] --> NE
    MN[MobileNavBar item] --> NE
    TF[TaskForm workflow picker] -->|workflowId at create| CT
  end
  subgraph Editor[WorkflowNodeEditor]
    NE[Canvas + palette]
    TP[Create: template picker]
    PAL[Palette Templates:<br/>Fragments / Built-in steps / Plugin steps]
    IE[Import / Export JSON]
    AI[Design with AI]
  end
  subgraph Server[dashboard src/]
    MIG[POST /workflows/migrate-legacy-steps]
    IMP[POST /workflows/import - strip approval flags]
    DES[POST /workflows/design - createFnAgent DI,<br/>JSON extract, strip, rate-limit]
  end
  subgraph Core[@fusion/core]
    CONV[stepsToWorkflowIr - inverse of compiler]
    WD[(workflows + kind)]
    WS[(workflow_steps + migratedFragmentId)]
    CT[create-time workflowId materialization]
  end
  NE --> MIG --> CONV
  CONV --> WD
  MIG -->|stamp + set project default| WS
  IE --> IMP --> WD
  AI --> DES -->|validated IR| NE
  TP --> WD
  PAL --> WD
  X[WorkflowStepManager] -.retired after TaskForm picker ships.-> NE
```

### Steps→IR conversion and migration policy (directional)

```
WorkflowStep[] (user-authored)                 migration output
──────────────────────────────                 ────────────────────────────
every step ───────────────▶ fragment           kind=fragment, start→node→end
defaultOn steps ──────────▶ combined workflow  kind=workflow "Migrated steps"
                                                + becomes project default
enabled-but-optional ─────▶ fragment only      (opt-in granularity → palette)

converter: pre-merge nodes → [execute][review][merge seams] → post-merge → end
  seams per linear(): config.seam, success chain, failure→end
  phase undefined → pre-merge; merge seam always emitted
contract: compileWorkflowToSteps(stepsToWorkflowIr(steps)) ≡ steps
          over compiler-visible fields (enabled/defaultOn are policy, not parity)
```

### Import envelope (directional)

```
{ "fusionWorkflowExport": 1, "schemaVersion": <SCHEMA_VERSION at export>,
  "kind": "workflow" | "fragment", "name", "description", "ir", "layout" }

import: envelope check → version gate (≤ current ok, newer 409)
        → parseWorkflowIr → trait availability (422 naming trait)
        → strip cliSkipApproval/autoApprove (flag in response)
        → scriptName existence warning (non-blocking)
        → fresh id (strip builtin:) → name collision suffix → create
        any failure → 4xx, zero writes; UI shows persistent inline error
```

---

## Implementation Units

### U1. `kind` discriminator + steps→IR converter (core)

**Goal:** Storage and conversion foundations: fragments distinguishable from workflows; a proven inverse of the compiler.
**Requirements:** R4, R6.
**Dependencies:** none.
**Files:**
- `packages/core/src/db.ts` (modify) — `kind` column on `workflows`, `migratedFragmentId` column on `workflow_steps` (both `addColumnIfMissing`); `SCHEMA_VERSION` 108→109.
- `packages/core/src/workflow-definition-types.ts` (modify) — `kind` on `WorkflowDefinition`/`Input`.
- `packages/core/src/store.ts` (modify) — `createWorkflowDefinition` accepts `input.kind`, includes it in the definition object AND the INSERT column list (default `workflow`); confirm fragment IRs survive `downgradeIrToV1IfPure`; `listWorkflowDefinitions({ kind? })` filtering the returned slice AFTER the cache read (cache always holds the full merged set); fragments excluded from task-selection/default-workflow consumers; `selectTaskWorkflow` rejects fragment IDs.
- `packages/core/src/workflow-steps-to-ir.ts` (new) — `stepsToWorkflowIr(steps, name)`, `stepToFragmentIr(step)`; inverse of `nodeToStepInput`; seams per `linear()`; undefined phase → pre-merge; parity-extension comments at both sites.
- `packages/core/src/index.ts` (modify) — re-exports.
- `packages/core/src/__tests__/workflow-steps-to-ir.test.ts` (new), `packages/core/src/__tests__/workflow-definition-store.test.ts` (extend).
**Approach:** Additive, forward-only migration. Fragment IRs are full parseable graphs (KTD-1). Converter is pure, no I/O.
**Patterns to follow:** `addColumnIfMissing` (db.ts ~3795); `linear()` builder; `compileWorkflowToSteps`/`nodeToStepInput` as the inversion source of truth.
**Test scenarios:**
- Covers R4: round-trip parity — mixed pre/post-merge steps with prompt/script/gate modes, model overrides, toolMode → `compileWorkflowToSteps(stepsToWorkflowIr(steps))` reproduces every compiler-visible field.
- All-phase-undefined step set → parseable IR with the canonical seam pipeline; round-trips to phase `pre-merge`.
- Produced IR passes `parseWorkflowIr`; seams once each, execute→review→merge order, seam `failure → end` edges.
- Empty step list → minimal valid IR; post-merge-only set → nodes after the merge seam.
- `stepToFragmentIr` → `start → node → end`, parseable, config mirrors the step.
- Covers R6: kind=fragment persists and round-trips (INSERT includes kind); `listWorkflowDefinitions({kind:"fragment"})` returns only fragments; calling filtered-then-unfiltered (and reverse) returns correct sets both times (cache-poisoning regression); task-selection list excludes fragments; `selectTaskWorkflow(fragmentId)` rejects; fragment IR unchanged by `downgradeIrToV1IfPure`.
- Migration 109 applies on a v108 DB and is idempotent on re-run.

### U2. Lazy idempotent step migration (server + core)

**Goal:** Existing user steps become fragments + a combined default workflow, exactly once per project, with user awareness.
**Requirements:** R5.
**Dependencies:** U1.
**Files:**
- `packages/core/src/store.ts` (modify) — `migrateLegacyWorkflowSteps()`: `transactionImmediate` (write lock before the unmigrated-rows SELECT); every unmigrated user step → fragment; defaultOn subset → combined "Migrated steps" workflow with the system description; sets project default workflow when that subset is non-empty; stamps `migratedFragmentId`.
- `packages/dashboard/src/routes/register-workflow-routes.ts` (modify) — `POST /api/workflows/migrate-legacy-steps` returning `{migrated, skipped, combinedWorkflowId?}`.
- `packages/dashboard/app/components/WorkflowNodeEditor.tsx` (modify) — fire the migration call once on editor open (refetch list after); non-fatal on error (404 tolerated if the route ships later); when `migrated > 0`, show a one-time dismissible notice (persisted dismissal, localStorage) explaining where steps went.
- `packages/dashboard/src/routes/__tests__/workflow-migrate-route.test.ts` (new), `packages/core/src/__tests__/workflow-step-migration.test.ts` (new).
**Approach:** KTD-3 representation policy. No deletion of step records. Zero user steps → no-op, no combined workflow, no notice.
**Execution note:** exercise the real store seam in route tests — do not mock store methods the route depends on (mock-masked dead-wiring learning).
**Test scenarios:**
- Covers R5: defaultOn + enabled-optional + disabled steps + one compiled-prefixed row → 3 fragments; combined workflow contains ONLY the defaultOn step; project default set to the migrated workflow; compiled row untouched; all sources stamped.
- No defaultOn steps → fragments created, NO combined workflow, project default unchanged.
- Second run → `{migrated: 0, skipped: n}`, no new definitions (idempotency).
- Two sequential invocations racing the marker → definitions created once (transactionImmediate honored).
- Zero user steps → no-op.
- Editor: notice shown once when migrated > 0; dismissal persists; absent when migrated = 0.

### U3. Entry rewire + retire WorkflowStepManager

**Goal:** Node editor is the only workflow surface; the legacy manager is gone — with no coverage gap.
**Requirements:** R1, R2.
**Dependencies:** U1, U6 (the TaskForm picker must land before or with the manager's removal — no release window where users can neither author steps nor pick workflows). U2 must merge before release so the editor's migrate call has a route, but does not gate this unit's landing (the call is non-fatal).
**Files:**
- `packages/dashboard/app/components/Header.tsx` (modify) — button (~1601) + overflow item (~1947) → `openWorkflowEditor`, label `t("header.workflows", "Workflows")`.
- `packages/dashboard/app/components/MobileNavBar.tsx` (modify) — more-menu item (~592) → editor.
- `packages/dashboard/app/hooks/useModalManager.ts` (modify) — remove `workflowStepsOpen`/`openWorkflowSteps`/`closeWorkflowSteps` + `anyModalOpen` membership.
- `packages/dashboard/app/App.tsx`, `packages/dashboard/app/components/AppModals.tsx` (modify) — drop wiring + `onOpenGraphEditor`.
- `packages/dashboard/app/components/WorkflowStepManager.tsx` + `.css` + tests (delete). The `fetchPluginWorkflowStepTemplates`/`fetchWorkflowStepTemplates` client fns it consumed live in `app/api` and survive (consumed by U9).
- `packages/dashboard/app/components/__tests__/AppModals.test.tsx`, Header/MobileNavBar tests (modify).
**Approach:** Surface Enumeration: Header desktop, Header overflow, MobileNavBar more-menu, AppModals mount, useModalManager state + `anyModalOpen`, App.tsx props, `onOpenGraphEditor`. `/api/workflow-steps` routes, the refine route, and `WORKFLOW_STEP_TEMPLATES` exports stay.
**Test scenarios:**
- Covers R1: Header button opens the node editor; desktop + overflow + mobile more-menu.
- Covers R2: no `WorkflowStepManager` references remain; `anyModalOpen` correct with the editor open; `openWorkflowSteps` no longer exported (type-level).
- Mobile breakpoint: more-menu item opens the editor.

### U4. Template picker on workflow creation (editor)

**Goal:** Creation starts from a previewable template choice.
**Requirements:** R7.
**Dependencies:** U1 (kinds); U8 (shares fresh-ID copy helpers).
**Files:**
- `packages/dashboard/app/components/WorkflowNodeEditor.tsx` (modify) — create dialog gains a template step: a focus-trapped option list (arrow-key navigable; each entry shows name, description, node count) of blank / built-ins / user kind=workflow definitions; selecting seeds a fresh-ID copy (name = source + " copy", description inherited).
- `packages/dashboard/app/components/WorkflowNodeEditor.css` (modify).
- `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx` (extend).
**Approach:** Copies via the U8 ID-remap helpers applied to the whole graph. With no user workflows: blank + built-ins only. The migrated workflow appears with its system description.
**Test scenarios:**
- Covers R7: create-from-builtin seeds a copy (fresh IDs, same node count, name "X copy", description inherited); builtin stays read-only; blank unchanged.
- Picker entries render name/description/node count; empty-user-workflow state lists blank + builtins.
- Fragments never appear in the picker.
- Keyboard: arrow navigation + Enter selects (a11y).

### U5. Import/export (server + editor)

**Goal:** Workflows and fragments round-trip as files, safely.
**Requirements:** R9, R10.
**Dependencies:** U1.
**Files:**
- `packages/dashboard/src/routes/register-workflow-routes.ts` (modify) — `GET /api/workflows/:id/export`, `POST /api/workflows/import` per KTD-5 (strip approval flags + response flag; scriptName warning; version gate ≤ current).
- `packages/dashboard/app/components/WorkflowNodeEditor.tsx` (modify) — Export button (disabled while dirty, tooltip "Save to export"; enabled for built-ins; tooltip notes files contain full prompt/command text), Import affordance (sidebar; keyboard-accessible trigger for `<input type="file" accept=".json">`; persistent inline error region for validation failures; toast only for network errors; input resets after any attempt; notice when approval flags were stripped).
- `packages/dashboard/app/api/legacy.ts` (modify) — client fns.
- `packages/dashboard/src/routes/__tests__/workflow-import-export.test.ts` (new), `__tests__/WorkflowNodeEditor.test.tsx` (extend).
**Approach:** Envelope per HTD. Server is the sole validator. Export reads the persisted definition (dirty-guard makes stale export impossible).
**Test scenarios:**
- Covers R9: export → import reproduces ir/layout/description semantically; fragment kind preserved; export blocked while dirty (button disabled).
- Covers R10: name collision → suffixed; builtin export → fresh non-builtin editable ID; missing envelope marker → 400; malformed IR → 422 + parser message, zero writes; unknown trait → 422 naming the trait; `schemaVersion` older → accepted; newer → 409 version message; CLI node with `cliSkipApproval: true` → persisted node lacks the field and the response flags the strip; script node with unknown scriptName → 200 + warning field.
- Editor: validation failure renders the inline error (not a toast) and the list is unchanged; success refreshes + activates; strip notice shown when flagged.

### U6. Workflow-centric TaskForm + create-time workflowId

**Goal:** Tasks pick a workflow, applied atomically at creation.
**Requirements:** R3.
**Dependencies:** U1 (fragment exclusion). (U2's migrated workflow appears automatically once present — runtime ordering, not a build dependency.)
**Files:**
- `packages/core/src/types.ts` + `packages/core/src/store.ts` (modify) — `workflowId?: string` on the task-create input; materialization inside the creation transaction mirroring the default-workflow block (`materializeDefaultWorkflowSteps`/`pendingWorkflowSelection`/`writeTaskWorkflowSelection`, store.ts ~3974-4035); explicit `workflowId` overrides the project default; fragment IDs rejected.
- `packages/dashboard/src/routes` task-create route (modify) — accept + pass `workflowId`.
- `packages/dashboard/app/components/TaskForm.tsx` (modify) — replace the per-step checkbox section (~280, ~330-339, ~1331-1337) with the workflow dropdown (states per R3); remove `fetchWorkflowSteps` usage; empty-workflow-list CTA into the editor.
- `packages/dashboard/app/components/__tests__/` TaskForm tests (extend), `packages/core/src/__tests__/` task-create tests (extend).
**Approach:** The engine path is untouched — materialization writes `enabledWorkflowSteps` exactly as the default-workflow path does, in the same transaction, so no executor-pickup race exists. `selectTaskWorkflow` remains the post-create path only.
**Test scenarios:**
- Covers R3: create with `workflowId` → task's `enabledWorkflowSteps` populated within the creation write (no intermediate empty state observable); explicit pick overrides project default; "No workflow" → no custom steps; fragment ID → rejected.
- Dropdown: loading placeholder; "(default)" badge on the project default; "No workflow" listed first; fragments absent; built-ins present.
- Empty project → CTA opens the editor.
- Regression: per-step checkboxes gone; no `fetchWorkflowSteps` call remains in TaskForm.

### U7. AI design route (server)

**Goal:** Prompt → validated, stripped, rate-limited IR.
**Requirements:** R11 (server half).
**Dependencies:** U1.
**Files:**
- `packages/dashboard/src/routes/register-workflow-routes.ts` (modify) — `POST /api/workflows/design` `{prompt, workflowId?}` per KTD-6: module-level `__setCreateFnAgentForDesign` DI seam co-located with the route; planning-lane model; tool-less; JSON-from-text extraction via the existing helper (planning/agent-generation precedent); `parseWorkflowIr` + compile triage (`interpreterOnly` flag) + approval-flag stripping; `workflowId` read from the store (client never posts IR); rate limit 10/hour mirroring `/ai/refine-text`; bounded prompt length.
- `packages/dashboard/src/routes/__tests__/workflow-design-route.test.ts` (new).
**Execution note:** route tests use the DI seam with a fake agent — no real model calls.
**Test scenarios:**
- Covers R11: fake agent returns valid linear IR → 200 `{ir, interpreterOnly:false}`; branching IR → 200 `{interpreterOnly:true}`; fenced/prose-wrapped JSON → still extracted and 200; invalid JSON / IR failing `parseWorkflowIr` → 422 + message, nothing persisted; IR containing `cliSkipApproval` → returned IR lacks it + strip flag set.
- `workflowId` flow: route reads the persisted IR; unknown ID → 404.
- Rate limit: 11th call within the window → 429.
- Over-length prompt → 400.

### U8. Fragment insertion + graph-copy helpers (mapping layer)

**Goal:** Pure, tested primitives for inserting fragments and copying graphs.
**Requirements:** R8 (helper half), R7 (copy helpers).
**Dependencies:** U1.
**Files:**
- `packages/dashboard/app/components/workflow-flow-mapping.ts` (modify) — `insertFragment(nodes, edges, fragmentIr, position)` (strips start/end, remaps all node IDs to fresh `newNodeId`s, rewires internal edges), `fragmentSeamConflicts(fragmentIr, nodes)`, `copyIrWithFreshIds(ir, layout)`.
- `packages/dashboard/app/components/__tests__/workflow-flow-mapping.test.ts` (extend).
**Approach:** Pure-helper-first so jsdom limits don't bite; consumed by U4 (copies) and U9 (palette insertion).
**Test scenarios:**
- Covers R8: `insertFragment` remaps every node ID (no collisions), strips start/end, preserves internal edges/config; double-insert → disjoint ID sets.
- Fragment containing a `merge` seam vs a graph that has one → `fragmentSeamConflicts` flags it.
- `copyIrWithFreshIds` → same structure, all-new IDs, layout keys remapped consistently.

### U9. Palette Templates section (editor)

**Goal:** The template library is insertable from the palette.
**Requirements:** R8.
**Dependencies:** U1, U8. (U2's fragments appear once migrated — runtime ordering.)
**Files:**
- `packages/dashboard/app/components/WorkflowNodeEditor.tsx` (modify) — Templates palette section: Fragments / Built-in steps / Plugin steps subsections (alphabetical; filter input when combined > 8; plugin owner badges); entries keyboard-activatable (Enter/Space) with descriptive aria-labels; fragment insertion via U8 with the persistent inline conflict error in the section; preset step nodes via the converter field mapping; section collapsed state persisted.
- `packages/dashboard/app/api/legacy.ts` (modify) — fragments fetch (kind param); reuse existing `fetchWorkflowStepTemplates`/`fetchPluginWorkflowStepTemplates`.
- `packages/dashboard/app/components/WorkflowNodeEditor.css` (modify).
- `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx` (extend).
**Test scenarios:**
- Covers R8: three subsections render with their sources; plugin entry carries owner badge; inserting a step template adds a node with prefilled config; inserting a fragment with a seam conflict → inline error, no insertion; filter input appears above 8 combined entries and filters across groups.
- Empty fragment library → Fragments subsection hidden.
- Builtin active → insertion disabled (read-only gating).
- Keyboard activation inserts (a11y).

### U10. Design-with-AI editor affordances

**Goal:** Prompt-to-workflow UX in both entry points.
**Requirements:** R11 (client half).
**Dependencies:** U7.
**Files:**
- `packages/dashboard/app/components/WorkflowNodeEditor.tsx` (modify) — create dialog: an optional "Describe it instead" textarea (placeholder with an example prompt) before template selection — submitting designs a new workflow from the result; toolbar: "Design with AI" opens a popover panel (textarea + submit) targeting the active workflow via `workflowId`; proposed replacement applies only through the dirty-guard confirm. In-flight: control disabled + spinner + `aria-busy`, client-side cancel (abort the fetch); failure → server message inline, canvas untouched; `interpreterOnly` → existing info banner on the seeded graph; strip notice when flagged.
- `packages/dashboard/app/components/WorkflowNodeEditor.css` (modify).
- `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx` (extend).
**Test scenarios:**
- Covers R11: mocked design success in create dialog → new workflow seeded from returned IR; toolbar flow over a dirty canvas → discard confirm first, cancel keeps edits.
- Mocked 422 → inline error, canvas untouched.
- In-flight state: control disabled, aria-busy set; cancel aborts and re-enables.
- interpreterOnly result → info banner visible.

### U11. Agent-lane exposure (engine)

**Goal:** Chat and planning agents can author workflows; drift-guarded.
**Requirements:** R12.
**Dependencies:** none (independent; lands first safely).
**Files:**
- `packages/dashboard/src/chat.ts` (modify, ~1288/1612) — pass `fn_workflow_*` factories via `createFnAgent`'s `customTools` (chat passes none today — introduce the array) with the scoped store.
- `packages/dashboard/src/planning.ts` (modify, ~842) — append the workflow tool factories to the existing `customTools: [...createPlanningBoardTools(store)]`.
- `packages/engine/src/__tests__/agent-workflow-tools-exposure.test.ts` (new) — asserts all six names (`fn_workflow_create/update/delete/list/get/select`) per lane: executor, chat, planning.
- Touched tool handlers (verify) — defensive arg parsing (string-JSON accepted).
**Approach:** Grep every `fn_workflow_` registration surface first and mirror all hits (drift learning).
**Test scenarios:**
- Covers R12: exposure test enumerates executor + chat + planning toolsets and asserts `fn_workflow_create/update/delete/list/get/select` membership in each; fails when any lane loses one.
- Chat lane: customTools array introduced without disturbing existing chat tool behavior (existing chat tests stay green).
- A workflow tool invoked with stringified-JSON args still parses.

---

## Risks & Dependencies

- **Migration writes to user DBs.** Additive only (2 columns, new rows, marker stamps, one project-default settings write); `transactionImmediate`; idempotent by stored marker; nothing deleted or rewritten.
- **defaultOn policy is a behavior interpretation.** Mapping defaultOn → combined-workflow-as-project-default preserves "new tasks run these" but collapses per-task uncheckability into workflow choice + fragments. Named in release notes; the migration test suite pins the policy.
- **Round-trip fidelity gaps.** Parity covers compiler-visible fields only — by design; `enabled`/`defaultOn`/`templateId` are policy-handled. Extend parity when `nodeToStepInput` gains fields (comments at both sites).
- **Trust boundary.** `cliSkipApproval`/`autoApprove` bypass the CLI approval gate; import and design strip them (R10/R11). Systemic schema-level rejection is an explicit follow-up. Exported files contain full prompt/command text — disclosure note on the export affordance.
- **Removal blast radius.** U3's Surface Enumeration is the sweep list; U3 is gated on U6 to avoid the no-surface window.
- **Import strictness vs. portability.** Unknown traits block (422 naming trait + owning plugin); unknown scriptNames warn without blocking — scripts are project-settings content the user can add after import.
- **AI output variance.** JSON extraction + server validation bound the failure mode to a clean 422; retry/repair deferred. Synchronous route bounded by rate limit + prompt-length cap; detached-turn upgrade documented.
- **Registration drift** (agent tools, palette template sources): grep-and-mirror; U11 guard test.
- **Mid-migration TaskForm state.** A user can open TaskForm before ever opening the editor — they see built-ins (+ any existing workflows) until migration runs on first editor open; acceptable, noted here so it isn't mistaken for a bug.
- **Changeset:** user-facing feature in the bundled CLI → `@runfusion/fusion` minor changeset.

---

## System-Wide Impact

- **Schema:** SCHEMA_VERSION 108→109 (two additive columns).
- **Engine:** no execution-semantics change; chat/planning lanes gain workflow tools (additive).
- **Existing users:** flat steps keep executing on existing tasks; the step-authoring UI is replaced by migrated workflows/fragments; defaultOn behavior is preserved via the migrated project default; TaskForm visibly changes (workflow picker) — release-notes worthy, plus the in-editor one-time migration notice.
- **Plugins:** contributed step templates move to the editor palette; plugin API unchanged.

---

## Sources & Research

- `packages/dashboard/app/components/WorkflowStepManager.tsx` (surface inventory: form fields ~718-963, templates tab + plugin templates ~185-200, refine ~830-844, onOpenGraphEditor ~430).
- `packages/dashboard/app/components/Header.tsx` (~1601, ~1947), `MobileNavBar.tsx` (~592), `useModalManager.ts` (~180, ~199, ~348-351), `AppModals.tsx` (~377-400), `TaskForm.tsx` (~242, ~280, ~330-339, ~1331-1337).
- `packages/core/src/workflow-compiler.ts` (`compileWorkflowToSteps` ~200, `nodeToStepInput` ~162-189 — emits neither `enabled` nor `defaultOn`), `builtin-workflows.ts` (`linear()` ~25-44), `store.ts` (`createWorkflowDefinition` ~12238 — fixed INSERT, no name uniqueness; `listWorkflowDefinitions` ~12289 — single unconditional cache; `selectTaskWorkflow` ~13266 — requires task id; default-workflow materialization ~3974-4035; `materializeWorkflowSteps` ~13230; `transactionImmediate` precedent), `db.ts` (`SCHEMA_VERSION = 108` ~152, `addColumnIfMissing` ~3795), `types.ts` (`WorkflowStep` ~510-548 — `enabled` required, `defaultOn` optional; `WORKFLOW_STEP_TEMPLATES` ~772; task-create input carries only `enabledWorkflowSteps`).
- `packages/dashboard/src/routes.ts` (refine route + `__setCreateFnAgentForRefine` ~370, ~3019-3092 — free-text accumulation, no JSON extraction; rate limits on `/ai/refine-text` ~1717), `register-workflow-routes.ts`; JSON-from-text extraction precedent in `planning.ts`/agent-generation.
- `packages/engine/src/agent-tools.ts` (`fn_workflow_*` ~1007-1365), `executor.ts` (~5687-5694 toolset; `cliSkipApproval`/`autoApprove` gate ~4576-4581), `packages/dashboard/src/chat.ts` (`tools: "coding"`, no customTools ~1288/1612), `planning.ts` (`customTools` ~842).
- Import/export precedent: `SettingsModal.tsx` (~1625-1671, ~7662), `register-agent-import-export-generation-routes.ts`, `AgentImportModal.tsx` (~246-257, ~495-507).
- Learnings: `docs/solutions/integration-issues/bundled-plugin-registration-drift.md`, `docs/solutions/integration-issues/branch-group-single-pr-synthetic-id-dead-wiring.md`, `docs/solutions/architecture-patterns/observable-long-running-agent-turns-through-blocking-plugin-route-seam.md`, `docs/solutions/architecture-patterns/mass-migration-agent-fleet-orchestration.md`.
- Prior plans: `docs/plans/2026-06-03-001-feat-executable-custom-workflows-node-editor-plan.md`, `docs/plans/2026-06-04-002-feat-node-editor-visual-edge-upgrade-plan.md`.
