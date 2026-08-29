---
title: "feat: Workflow optional steps — node-editor authoring, full-modal parity, stepwise declaration"
status: active
date: 2026-06-20
type: feat
plan_id: 2026-06-20-001-feat-workflow-optional-steps-node-editor-modal
---

# feat: Workflow optional steps — node-editor authoring, full-modal parity, stepwise declaration

## Summary

Workflows can declare **optional steps** — workflow-step templates (e.g. Browser Verification) that a
task may toggle on/off per task, with a workflow-level `defaultOn` seeding the initial state. Most of
the plumbing for this already exists on the `gsxdsm/workflow-optional-steps` branch: the IR type
(`WorkflowOptionalStep` + `WorkflowIrV2.optionalSteps`), parse-time validation, the
`resolveWorkflowOptionalSteps` resolver, the `GET /workflows/:id/optional-steps` route, the
`fetchWorkflowOptionalSteps` API client, the executor's `enabledWorkflowSteps` execution path, the
**inline quick-create card** toggles, and the **task-detail Workflow tab** edit toggles. The built-in
**coding** workflow already declares `browser-verification` as its one optional step.

This plan closes the five remaining gaps:

1. The **built-in stepwise-coding workflow** does not yet support `browser-verification` as an optional
   step — and, unlike the coding workflow, its graph has **no `workflow-step` seam node**, so even
   declaring the optional step would create a dead toggle that never executes. Both the seam node and the
   declaration are needed.
2. The **node editor's save path (`flowToIr`) silently drops `optionalSteps`** — editing any workflow in
   the visual editor and saving destroys its optional-step declaration (a real data-loss bug).
3. The **node editor has no UI** to view or author optional steps (the user's explicit ask: "the node
   editor view also needs to show optional steps properly").
4. The **full New Task modal** (`NewTaskModal` / `TaskForm`) lacks the optional-step toggles that the
   inline quick-create card already has, so the two creation surfaces are inconsistent.
5. The **quick-add area** exposes optional steps only as inline chip toggle buttons; it should instead
   offer a dedicated **steps dropdown** for selecting/deselecting optional steps.

**Plan depth:** Standard. This is focused, additive work building on substantial existing scaffolding —
no new persistence model, no executor changes.

---

## Problem Frame

The optional-steps feature is ~70% built but has a correctness hole and two missing surfaces:

- **Data loss:** `flowToIr` (`packages/dashboard/app/components/workflow-flow-mapping.ts:435`)
  reconstructs the v2 IR from canvas nodes and re-attaches `fields` and `settings` from threaded
  arguments, but **never carries `optionalSteps`**. Any round-trip through the node editor (open custom
  workflow → save) strips the declaration. The built-in coding workflow is safe only because it is never
  re-serialized through the editor, but any user-authored or edited workflow loses optional steps on
  first save.
- **Missing authoring surface:** `WorkflowNodeEditor.tsx` has zero optional-step awareness. There is no
  way to declare which step templates are optional, or set their `defaultOn`, from the visual editor —
  the only way today is hand-editing IR.
- **Inconsistent creation surfaces:** `InlineCreateCard.tsx` fully implements optional-step toggles
  (fetches via `fetchWorkflowOptionalSteps`, seeds enabled set from `defaultOn`, sends
  `enabledWorkflowSteps` on submit). The richer `NewTaskModal` / `TaskForm` create path exposes only a
  whole-workflow dropdown.
- **Incomplete built-in parity + missing seam:** the original request asks for browser verification to be
  optional in **both** the coding and stepwise-coding built-ins; only coding has it. Critically, the
  coding IR routes through a `workflow-step` seam node (`builtin-coding-workflow-ir.ts:69`,
  `execute → workflow-step → review`) which is the only thing that makes the graph call `runWorkflowSteps`
  (`workflow-node-handlers.ts:264`). The stepwise IR has no such node, so its `enabledWorkflowSteps` are
  never executed on the main graph path — making this an executor-graph change, not just a declaration.
- **Quick-add chip UX (user-requested):** the quick-add card renders optional steps as inline chip
  toggles. The user explicitly asked for a dedicated **steps dropdown** in the quick-add area; R7/U5 honor
  that request (this is the stated goal behind R7, not an inferred redesign of a working surface).

The scope is bounded to authoring + display + creation-surface parity, **plus the stepwise seam node**
needed to make the stepwise optional step actually run. The executor's `enabledWorkflowSteps` runtime path
is wired and verified **for workflows that contain a `workflow-step` seam node** (coding); the resolver,
route, and edit-after-creation Workflow tab are already wired and covered by existing tests. This plan does
not change the executor itself beyond adding the stepwise seam node and a stepwise execution test.

---

## Requirements

- **R1** — The built-in **stepwise-coding** workflow declares `browser-verification` as an optional step,
  default OFF, matching the coding workflow, **and runs it when enabled** — which requires adding a
  `workflow-step` seam node to the stepwise graph so `enabledWorkflowSteps` actually execute.
- **R2** — Saving a workflow through the node editor **preserves** any declared `optionalSteps` (no
  round-trip data loss).
- **R3** — The node editor provides an **Optional Steps** authoring panel where a workflow author can add
  or remove optional step declarations and set each one's `defaultOn` (on/off).
- **R4** — The full **New Task modal** exposes the same optional-step toggles as the inline quick-create
  card: it loads the selected workflow's optional steps, seeds enabled state from `defaultOn`, and submits
  the chosen `enabledWorkflowSteps`.
- **R5** — Unknown/stale optional-step template ids never crash any surface (resolver already drops them;
  the new UI must follow the same defensive posture).
- **R6** — Legacy v1 workflows and workflows with no optional steps continue to serialize and render
  byte-identically (additive-only; `optionalSteps` omitted entirely when empty).
- **R7** — The quick-add area presents optional steps as a multi-select **steps dropdown** (select /
  deselect), replacing the current inline chip toggles, while preserving the same `defaultOn` seeding and
  `enabledWorkflowSteps` submit behavior.

---

## High-Level Technical Design

The optional-steps declaration flows from the workflow IR through three independent consumer surfaces.
The two new/fixed edges are the node-editor round-trip (U2/U3) and the full-modal create path (U4).

```mermaid
flowchart TD
  IR["WorkflowIrV2.optionalSteps\n[{ templateId, defaultOn? }]"]
  IR -->|resolveWorkflowOptionalSteps| RES["ResolvedWorkflowOptionalStep[]\n(name, description, icon, phase, defaultOn)"]
  RES -->|GET /workflows/:id/optional-steps| API["fetchWorkflowOptionalSteps()"]

  subgraph Authoring [Node editor — U2 + U3]
    NE["WorkflowNodeEditor state\n(optionalStepsOf)"] -->|flowToIr(... optionalSteps)| SAVE["saved IR\n(preserves optionalSteps)"]
    SAVE -.-> IR
  end

  subgraph Create [Task creation]
    API --> INLINE["InlineCreateCard\n(U5 — chips → steps dropdown)"]
    API --> MODAL["NewTaskModal / TaskForm\n(U4 — new)"]
    INLINE --> ENABLED["enabledWorkflowSteps[] on createTask"]
    MODAL --> ENABLED
  end

  subgraph Edit [Post-create]
    API --> WRT["WorkflowResultsTab\n(DONE)"]
  end

  ENABLED --> SEAM["workflow-step seam node\n(coding: present · stepwise: ADDED in U1)"]
  SEAM --> EXEC["runWorkflowSteps()\n(runs enabledWorkflowSteps)"]
```

Key boundary: the `optionalSteps` **declaration** is execution-inert — it only advertises which templates
are toggleable and seeds per-task `enabledWorkflowSteps`. But execution of those steps is **not** free:
`runWorkflowSteps` fires only when the graph reaches a `workflow-step` seam node
(`workflow-node-handlers.ts:264`). The coding IR has one; the stepwise IR does not, so U1 adds it. With
that one exception, the executor is untouched — the rest of the work is confined to declaration (core),
serialization (dashboard mapping), and UI (dashboard components).

---

## Key Technical Decisions

- **KTD-1 — Thread `optionalSteps` through `flowToIr` as an explicit parameter**, mirroring how `fields`
  and `settings` are threaded today (`workflow-flow-mapping.ts:435`). Optional steps are not graph nodes,
  so they cannot be reconstructed from the canvas; they must be passed alongside `columns`/`fields`/
  `settings` and re-attached to the v2 IR. Add an `optionalStepsOf(def)` reader mirroring `fieldsOf` /
  `settingsOf` so `WorkflowNodeEditor` can hydrate editor state from a loaded workflow.
- **KTD-2 — Treat a non-empty `optionalSteps` as a v2 signal**, like `fields`/`settings`. A workflow with
  optional steps but no custom columns still serializes as v2 with synthesized default columns. Empty/
  absent `optionalSteps` must be omitted entirely from the serialized IR (never `optionalSteps: []` or
  `null`) to preserve R6 byte-identity for legacy graphs.
- **KTD-3 — Author optional steps from a catalog of step templates, not free text.** The Optional Steps
  panel picks from `WORKFLOW_STEP_TEMPLATES` (plus plugin templates where available), storing only
  `{ templateId, defaultOn }`. Display metadata (name/description/icon/phase) is always resolved from the
  template catalog at render time — never duplicated into the IR — so the resolver stays the single source
  of truth and stale ids degrade gracefully (R5).
- **KTD-4 — Reuse the inline card's create semantics in the full modal.** `TaskForm`/`NewTaskModal` should
  load optional steps for the selected workflow, seed the enabled set from `defaultOn`, re-seed when the
  workflow selection changes, and pass `enabledWorkflowSteps` only when non-empty (matching
  `InlineCreateCard.tsx:478`). This keeps both creation surfaces behaviorally identical.
- **KTD-5 — `defaultOn` toggle is a per-declaration boolean stored on the IR**, distinct from the
  template's own `defaultOn`. The resolver already prefers the workflow declaration's `defaultOn` over the
  template default (`optionalStep.defaultOn ?? template.defaultOn ?? false`); the authoring UI writes the
  declaration-level value.

---

## Implementation Units

### U1. Add the `workflow-step` seam node + optional-step declaration to the stepwise-coding workflow

**Goal:** Make `browser-verification` a real, runnable optional step on the stepwise-coding workflow —
both declared and actually executed when enabled (R1). This is more than a one-line declaration: the
stepwise graph currently has no `workflow-step` seam node, so without one the toggle would be dead.

**Requirements:** R1, R6

**Dependencies:** none

**Files:**
- `packages/core/src/builtin-stepwise-coding-workflow-ir.ts` (modify — add `workflow-step` seam node +
  rewire edges + `optionalSteps` declaration)
- `packages/core/src/__tests__/workflow-optional-steps.test.ts` (modify — add stepwise resolver case)
- `packages/engine/src/__tests__/stepwise-workflow-parity.test.ts` or a sibling engine test (modify/create
  — **execution-level** test that an enabled step actually runs)
- Any stepwise IR snapshot/parity oracle fixture (update if a byte-identity snapshot exists — see R-5)

**Approach:**
- Add a `workflow-step` seam node to the stepwise IR mirroring `builtin-coding-workflow-ir.ts:69`
  (`{ id: "workflow-step", kind: "prompt", column: ..., config: builtinPromptConfig("workflow-step",
  "Pre-merge workflow steps") }`), and rewire the success path so it sits between the foreach `steps`
  region and `review` (i.e. `steps → workflow-step → review`, plus the `workflow-step → end`
  outcome/failure edges that the coding IR carries at `:99-116`). Confirm placement is **after** the
  foreach completes (the seam reads task-level `enabledWorkflowSteps` once, not per step-instance — see
  R-5 note).
- Add `optionalSteps: [{ templateId: "browser-verification" }]` to the stepwise IR (mirrors
  `builtin-coding-workflow-ir.ts:123`). No explicit `defaultOn` → resolves OFF.
- Confirm the IR still passes `parseWorkflowIr`.

**Patterns to follow:** `builtin-coding-workflow-ir.ts` `workflow-step` node (`:69`) and its edges
(`:97-116`); `optionalSteps` declaration (`:123`).

**Test scenarios:**
- `resolveWorkflowOptionalSteps(BUILTIN_STEPWISE_CODING_WORKFLOW_IR)` returns a single
  `browser-verification` entry (`name: "Browser Verification"`, `phase: "pre-merge"`, `defaultOn: false`).
- The stepwise IR parses without error and contains exactly one `workflow-step` seam node on the success
  path between `steps` and `review`.
- **Execution divergence (the critical test):** a stepwise-coding task with
  `enabledWorkflowSteps: ["browser-verification"]` actually invokes `runWorkflowSteps` and records a
  `workflowStepResults` entry for `browser-verification`; a sibling task with it OFF records none. This is
  the two-task divergence shape from the per-task-auto-merge learning — it guards against the dead-toggle
  failure that a resolver-only test would miss.
- Foreach interaction: the `workflow-step` seam runs **once** post-foreach, not per step-instance (R-5).

**Verification:** `pnpm --filter @fusion/core test workflow-optional-steps` plus the engine execution
test pass; the byte-identity parity oracle still passes (or its fixture is updated, R-5).

---

### U2. Preserve `optionalSteps` across the node-editor round-trip (`flowToIr`)

**Goal:** Fix the data-loss bug so saving a workflow through the node editor never drops its optional-step
declaration (R2, R6). This is the correctness prerequisite for U3.

**Requirements:** R2, R6

**Dependencies:** none (independent of U1; pairs with U3)

**Files:**
- `packages/dashboard/app/components/workflow-flow-mapping.ts` (modify — `flowToIr` signature + v2
  detection + re-attach; add `optionalStepsOf` reader)
- `packages/dashboard/app/components/__tests__/workflow-flow-mapping.test.ts` (modify/create — round-trip
  test)

**Approach:**
- Extend `flowToIr(name, nodes, edges, columns?, fields?, settings?, optionalSteps?)` with a trailing
  optional `optionalSteps?: WorkflowOptionalStep[]` parameter (keep it trailing so existing call sites
  compile).
- Include a non-empty `optionalSteps` in the v2 signal alongside `hasFields`/`hasSettings`
  (`workflow-flow-mapping.ts:454-456`), and re-attach it to the constructed v2 IR exactly where `fields`
  and `settings` are attached (`:544-561`). Omit entirely when empty/absent (R6).
- Add `optionalStepsOf(def: WorkflowDefinition): WorkflowOptionalStep[]` mirroring `fieldsOf`/`settingsOf`
  (`:946`, `:960`) — returns a deep-ish copy for v2 IRs with `optionalSteps`, `[]` otherwise. Used by U3 to
  hydrate editor state.
- **Also thread `optionalSteps` through `serializeGraph`** (`WorkflowNodeEditor.tsx:160-177`), the
  indirection that `flowToIr` is called through for dirty-tracking. `serializeGraph` is invoked by the
  dirty-check effect (`:1012`) and the load-baseline calls (`:1187`, `:1818`). If only the save path is
  threaded but `serializeGraph` is not, the loaded baseline and live snapshots both omit `optionalSteps`,
  so **editing optional steps never marks the editor dirty and the Save button never enables** — the user
  cannot persist the change. Give `serializeGraph` an `optionalSteps` parameter and pass the editor state
  at the dirty-check call and `optionalStepsOf(activeWorkflow)` at the baseline calls. (This belongs to
  U3's wiring but is called out here because it rides the same `flowToIr` seam.)

**Patterns to follow:** the `fields`/`settings` threading and `fieldsOf`/`settingsOf` readers in the same
file are the exact template to clone.

**Technical design (directional, not spec):**
```text
flowToIr(..., optionalSteps?) {
  const hasOptional = Array.isArray(optionalSteps) && optionalSteps.length > 0
  const v2 = columns?.length || hasFields || hasSettings || hasOptional
  ...
  if (v2) {
    if (hasFields)    ir.fields = ...
    if (hasSettings)  ir.settings = ...
    if (hasOptional)  ir.optionalSteps = optionalSteps.map(o => ({ ...o }))  // NEW
  }
}
```

**Test scenarios:**
- Round-trip: an IR with `optionalSteps: [{ templateId: "browser-verification", defaultOn: true }]` →
  `irToFlow` → `flowToIr(..., optionalStepsOf(def))` yields an IR whose `optionalSteps` equals the input.
- A workflow with optional steps but no custom columns/fields/settings serializes as **v2** (not v1).
- A workflow with no optional steps serializes **without** an `optionalSteps` key (no `[]`, no `null`) —
  legacy byte-identity preserved (R6).
- `optionalStepsOf` returns `[]` for a v1 IR and for a v2 IR with no `optionalSteps`.
- `optionalStepsOf` returns a copy (mutating the result does not mutate the source IR).

**Verification:** round-trip test green; existing `workflow-flow-mapping` tests unaffected.

---

### U3. Optional Steps authoring panel in the node editor

**Goal:** Let a workflow author add/remove optional-step declarations and set each one's `defaultOn` from
the visual editor, and persist them via the U2 round-trip (R3, R5).

**Requirements:** R3, R5, R6

**Dependencies:** U2 (needs `flowToIr` to accept `optionalSteps` + `optionalStepsOf` to hydrate)

**Files:**
- `packages/dashboard/app/components/WorkflowNodeEditor.tsx` (modify — add `optionalSteps` state,
  hydrate via `optionalStepsOf` on **both** load paths, render the panel inline alongside Fields/Settings,
  thread into every `flowToIr`/`serializeGraph` call site)
- `packages/dashboard/app/components/workflow-phase-badge.tsx` (create — extract `phaseBadge`; see below)
- `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx` (modify — round-trip + dirty +
  add/remove/toggle)

**Approach:**
- Add `optionalSteps` editor state to `WorkflowNodeEditor`. **Hydrate via `optionalStepsOf(activeWorkflow)`
  on both load paths:** the primary load effect AND the fragment/AI-generate load path at `:1496-1497`.
  Note: that fragment path today calls only `columnsOf`/`fieldsOf` — it omits even `settingsOf` — so
  `optionalSteps` (and settings) must be added explicitly there, not copied from the existing two-call
  pattern. Missing this re-introduces the U2 data loss on the fragment path (load empty → save strips).
- **Render the panel inline** in `WorkflowNodeEditor` as a third sibling alongside the existing Fields and
  Settings panels (same collapsible/expandable behavior and sidebar position, immediately below Settings).
  Do not extract a separate single-consumer `WorkflowOptionalStepsEditor` component/CSS file — co-locate
  the panel JSX with the Fields/Settings panels it mirrors. The panel is a list of declared optional steps,
  each showing the template's resolved name + phase chip + an on/off `defaultOn` control, an "Add optional
  step" picker sourced from `WORKFLOW_STEP_TEMPLATES` (filtering out already-declared ids), and a remove
  control per row. Store only `{ templateId, defaultOn }`; resolve display metadata from the catalog at
  render time (KTD-3).
- Thread the editor's `optionalSteps` into **every** `flowToIr(...)` AND `serializeGraph(...)` call site
  (save `:1802`/`:1818`, dirty-check `:1012`, baselines `:1187`, fragment/preview) so no save or
  dirty-tracking route bypasses the param (see U2 / R-1).
- **Unknown/stale template ids:** render a muted "Unknown step (`templateId`)" row with a remove control —
  do **not** silently skip them. Skipping would hide a declaration the user then can't remove without
  hand-editing IR; the muted row satisfies R5's "remain removable."
- **Accessibility:** the `defaultOn` control is a labeled checkbox/switch with
  `aria-label="Default on for <step name>"` and a visible focus ring; the "Add optional step" picker
  inherits keyboard behavior from the editor's existing picker pattern.

**phaseBadge extraction (F3):** `phaseBadge` is currently a non-exported module-local in
`WorkflowResultsTab.tsx:137` (takes a `t` arg). Extract it into a shared `workflow-phase-badge.tsx` helper
and re-import it in `WorkflowResultsTab`, the node-editor panel, and the U5 dropdown — rather than
duplicating the chip three times.

**Patterns to follow:** the existing Fields and Settings editor panels in the node editor (inline, not
separate components) and `TaskFieldsSection.tsx` for list-of-typed-declarations UI.

**Test scenarios:**
- Adding an optional step from the picker appends `{ templateId, defaultOn: false }`, removes it from the
  picker's available list, **and marks the editor dirty** (Save enables — guards the `serializeGraph` gap).
- Toggling a row's `defaultOn` flips the stored boolean and marks dirty.
- Removing a row deletes the declaration and returns the template to the picker.
- Editing a workflow that already declares `browser-verification`, making no change, and saving yields an
  IR whose `optionalSteps` is unchanged (round-trip through the live editor, not just `flowToIr`).
- A workflow loaded via the **fragment/generate path** preserves its `optionalSteps` on save (guards F2).
- A loaded declaration with an unknown `templateId` renders a muted removable row without crashing (R5).
- A workflow with zero optional steps saves without an `optionalSteps` key (R6).

**Verification:** new component tests green; node-editor save round-trip preserves declarations; manual
real-browser check per the worktree dashboard recipe (see Risks).

---

### U4. Optional-step toggles in the full New Task modal

**Goal:** Bring `NewTaskModal` / `TaskForm` to parity with the inline quick-create card's optional-step
toggles (R4, R5).

**Requirements:** R4, R5

**Dependencies:** **U5** — U4 consumes the shared `WorkflowOptionalStepsDropdown` built in U5 (see the
ordering decision below). U1 only enriches which workflows expose steps.

**Ordering decision (resolves the U4/U5 contradiction):** U5 builds **one** shared
`WorkflowOptionalStepsDropdown` component and lands first; U4 consumes it. U4 does **not** ship inline chip
markup that would later need migration. Both creation surfaces (quick-add card, full modal) therefore
present optional steps with the same dropdown interaction from day one — no divergent pickers.

**Files:**
- `packages/dashboard/app/components/TaskForm.tsx` (modify — load optional steps for selected workflow,
  render the shared dropdown, expose enabled-set state)
- `packages/dashboard/app/components/NewTaskModal.tsx` (modify — own the enabled-set state, include
  `enabledWorkflowSteps` in the create payload at `:243`)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modify/create)
- `packages/dashboard/app/components/__tests__/TaskForm.test.tsx` (modify/create)

**Approach:**
- In `TaskForm`, when a workflow is selected (dropdown gated by `onWorkflowIdChange`, `:1290`), call
  `fetchWorkflowOptionalSteps(effectiveWorkflowId, projectId)` and render the **`WorkflowOptionalStepsDropdown`
  (from U5)** directly below the workflow dropdown.
- Seed the enabled set from steps where `defaultOn` is true; re-seed whenever the selected workflow changes
  (clear + refetch), matching `InlineCreateCard.tsx:272-284`.
- Lift the enabled-set state to `NewTaskModal` (or expose via a `TaskForm` callback prop, consistent with
  the existing `onWorkflowIdChange` pattern) so the create handler includes
  `enabledWorkflowSteps: enabled.length ? enabled : undefined` in the `onCreateTask` payload (`:243`).
- **Loading/empty states:** while the optional-steps fetch is in flight, render a loading affordance
  consistent with whatever `InlineCreateCard` shows (a skeleton/disabled trigger, not a layout jump);
  submit stays enabled. "No workflow", undefined selection, or a workflow with no optional steps → render
  nothing (render-nothing is the committed empty-state behavior shared with U5), no `enabledWorkflowSteps`
  sent. Fetch failure → usable form, no dropdown (defensive, R5), mirroring the inline card's `.catch`.

**Patterns to follow:** `InlineCreateCard.tsx` for the state/fetch/seed/submit wiring;
`WorkflowOptionalStepsDropdown` (U5) for the presentation. Keep `data-testid` conventions.

**Test scenarios:**
- Selecting a workflow with an optional `browser-verification` step renders the dropdown with the step
  OFF by default (`defaultOn` false).
- A workflow whose optional step has `defaultOn: true` shows the step pre-selected and includes it in the
  create payload if left on.
- Selecting a step and submitting sends `enabledWorkflowSteps: ["browser-verification"]` to `onCreateTask`.
- Changing the workflow selection clears and refetches (no stale selection from the prior workflow).
- While the fetch is pending, a loading affordance shows and submit remains enabled.
- "No workflow" or a workflow with no optional steps renders no dropdown and omits `enabledWorkflowSteps`.
- Fetch failure leaves the form usable with no dropdown (R5).

**Verification:** modal/form tests green; manual real-browser create with browser-verification selected
produces a task whose detail Workflow tab shows the step enabled. Verify in a real mobile viewport (R-3).

---

### U5. Steps dropdown in the quick-add area

**Goal:** Build the shared multi-select **steps dropdown** and adopt it in the quick-add card, replacing
the inline chip toggles (R7). This component is the single optional-step picker consumed by both the
quick-add card (here) and the full modal (U4).

**Requirements:** R7, R5

**Dependencies:** none. **Lands before U4** (U4 consumes this component). Build the shared component with
both consumers in mind from the start — there is no interim chip version.

**Files:**
- `packages/dashboard/app/components/WorkflowOptionalStepsDropdown.tsx` (create — reusable multi-select
  dropdown over `ResolvedWorkflowOptionalStep[]`)
- `packages/dashboard/app/components/WorkflowOptionalStepsDropdown.css` (create)
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modify — swap the chip-toggle block at
  `:1080-1101` for the dropdown; keep existing state/seeding/submit wiring)
- `packages/dashboard/app/components/InlineCreateCard.css` (modify — remove now-unused chip styles)
- `packages/dashboard/app/components/__tests__/WorkflowOptionalStepsDropdown.test.tsx` (create)
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` (modify — assert dropdown
  behavior replaces chip behavior)

**Approach:**
- Build `WorkflowOptionalStepsDropdown` as a controlled multi-select: props are the resolved optional
  steps, the enabled `templateId` set, and an `onToggle(templateId)` callback. The open panel lists each
  step with a checkbox, name, phase chip (shared `phaseBadge` from U3's extraction), and description. It
  owns only open/close UI state — selection stays lifted in the parent (`InlineCreateCard`'s existing
  `enabledOptionalStepIds`).
- **Trigger label matrix (committed):** no steps available → render nothing; steps available, zero
  selected → `"Steps: none"`; N selected → `"Steps: N selected"`. Use the same strings in both consumers.
- **Empty state (committed):** render **nothing** when the selected workflow has no optional steps
  (matches `InlineCreateCard`'s current no-chip-block behavior and U4's empty-state choice — both surfaces
  identical). No disabled-placeholder variant.
- **Accessibility / keyboard (committed):** trigger is a button with `aria-haspopup` + `aria-expanded`;
  the panel is `role="listbox"` labeled via `aria-labelledby` pointing at the trigger; each option is
  `role="option"` with `aria-checked`. Escape closes and returns focus to the trigger; Enter/Space on the
  trigger toggles open; arrow keys move focus between options; outside-click closes. Inherit this behavior
  from `CustomModelDropdown.tsx` rather than re-implementing.
- **Positioning:** render the panel via a portal (appended to `document.body`) so it is not clipped by the
  modal's `overflow` boundary when reused in U4. Verify it anchors to the trigger in both the card and the
  modal.
- Swap the inline chip block in `InlineCreateCard` (`:1080-1101`) for the dropdown, passing the existing
  `optionalSteps`, `enabledOptionalStepIds`, and `toggleOptionalStep` (`:292`). Leave the fetch/seed/submit
  wiring (`:272-284`, `:478`) untouched — only the presentation changes. Unknown/stale ids are already
  filtered by the resolver (R5).

**Patterns to follow:** `CustomModelDropdown.tsx` for trigger+panel, portal positioning, keyboard nav, and
outside-click-close; the shared `phaseBadge` (U3) for the phase chip; keep `InlineCreateCard`'s existing
`data-testid` conventions so current tests migrate cleanly.

**Test scenarios:**
- Trigger label reflects state: `"Steps: none"` with steps available and none selected; `"Steps: 1
  selected"` with one selected; renders nothing when no optional steps exist.
- Opening the panel and checking a step calls `onToggle` and adds it; unchecking removes it.
- A step with `defaultOn: true` shows pre-checked on first open (seeded by the parent).
- Submitting the quick-add card with a step selected sends `enabledWorkflowSteps: ["browser-verification"]`
  (existing submit path unchanged).
- Keyboard: Escape closes and refocuses the trigger; arrow keys move option focus; outside-click closes
  without losing selection.
- The panel is not clipped when rendered inside an `overflow:hidden` container (portal positioning).

**Verification:** dropdown + inline-card tests green; manual real-browser check that the quick-add dropdown
selects/deselects, keyboard nav works, and the created task reflects the chosen steps. Verify the open
panel in a real mobile viewport (R-3).

---

## Scope Boundaries

**In scope:**
- Stepwise-coding built-in optional-step declaration (U1).
- Node-editor round-trip preservation + authoring panel (U2, U3).
- Full New Task modal optional-step parity (U4).
- Quick-add steps dropdown replacing inline chips (U5).

**Already built (verify-only, no changes):**
- IR types + parse validation (`workflow-ir-types.ts`, `workflow-ir.ts`).
- `resolveWorkflowOptionalSteps` (`workflow-optional-steps.ts`) and its route/API client.
- Inline quick-create card fetch/seed/submit wiring (`InlineCreateCard.tsx`) — presentation changes in U5,
  but the optional-steps load, `defaultOn` seeding, and submit payload are reused as-is.
- Task-detail Workflow tab edit toggles (`WorkflowResultsTab.tsx`).
- Executor `enabledWorkflowSteps` execution path — **but only for workflows that contain a `workflow-step`
  seam node** (coding). The stepwise workflow lacks one; U1 adds it. Do not treat the executor as fully
  "done" for stepwise until the U1 execution test passes.
- POST/PATCH `/tasks` acceptance of `enabledWorkflowSteps`.

### Deferred to Follow-Up Work
- Generalizing optional-step authoring to **plugin-contributed** step templates in the picker (use the
  built-in `WORKFLOW_STEP_TEMPLATES` catalog for now; plugin template merging can follow once the picker
  needs it).
- A reusable "per-task workflow facet override" abstraction unifying optional steps, auto-merge, and
  column-agent overrides — strong `/ce-compound` candidate after this lands, not part of this change.

**Out of scope:**
- Any executor/runtime behavior change. Optional steps remain execution-inert; the runtime already honors
  `enabledWorkflowSteps`.
- New persistence/migrations. Optional steps ride the existing IR (`optionalSteps`) and the existing
  `tasks.enabledWorkflowSteps` column — no schema bump.

---

## Risks & Dependencies

- **R-1 — Missed `flowToIr` / `serializeGraph` call site (data loss OR dead Save button).** `flowToIr` is
  reached both directly (save `:1802`/`:1818`) and through `serializeGraph` (`:160-177`), which the
  dirty-check effect (`:1012`) and load baselines (`:1187`) call. A missed **save** site drops the
  declaration; a missed **serializeGraph** site means optional-step edits never mark the editor dirty, so
  Save never enables and the change can't be persisted. *Mitigation:* grep every `flowToIr(` AND
  `serializeGraph(` call in `WorkflowNodeEditor` and thread the param at each (save, dirty-check,
  baselines, fragment/preview); the U3 dirty + round-trip-through-editor tests guard both failure modes.
- **R-2 — Stale dashboard bundle masks UI changes.** `fn dashboard` serves `packages/cli/dist/client`,
  not the dashboard worktree dist, so new editor/modal UI can appear "missing" when it's a stale bundle.
  *Mitigation:* verify with the worktree recipe — build all four packages, point `FUSION_CLIENT_DIR` at
  the dashboard worktree dist, run on a non-4040 port with `--dev` (never `fn daemon`/`serve`). Respect
  the port-4040 kill guards.
  (`docs/solutions/developer-experience/browser-testing-dashboard-from-worktree-safely.md`)
- **R-3 — Mobile toggle layout regression.** Per-task toggle switches on the board have a history of
  real-browser-only mobile failures (document horizontal scroll → blank dashboard) invisible to jsdom.
  *Mitigation:* the new toggles live in the create modal/inline card and the node editor, not on board
  cards, but verify the modal toggles in a real mobile viewport.
  (`docs/solutions/ui-bugs/mobile-auto-merge-toggle-document-scroll-blank.md`)
- **R-4 — v2-detection / byte-identity drift.** Incorrectly treating empty `optionalSteps` as a v2 signal
  would upgrade legacy v1 workflows and break R6 byte-identity. *Mitigation:* gate the v2 signal on
  **non-empty** `optionalSteps` and omit the key entirely when empty; cover with the U2 "no optional
  steps serializes without the key" test.
- **R-5 — Stepwise IR is a byte-identity parity oracle; adding the seam node may shift snapshots.** The
  stepwise IR is documented as the `execute`-seam byte-identity parity oracle. Adding a `workflow-step`
  seam node (U1) changes the graph, so any snapshot/parity fixture asserting the stepwise node/edge set
  will need updating, and the foreach interaction must be confirmed (the seam must run **once** after the
  foreach completes, not per step-instance — the learnings flag subgraph-walking as the #1 pitfall).
  *Mitigation:* place the seam node after the foreach `steps` region on the success path; update the parity
  fixture deliberately; add the U1 foreach-interaction test.

---

## Sources & Research

- Backend/core state map: `WorkflowOptionalStep` + `WorkflowIrV2.optionalSteps`
  (`packages/core/src/workflow-ir-types.ts:314-339`), resolver
  (`packages/core/src/workflow-optional-steps.ts`), coding declaration
  (`packages/core/src/builtin-coding-workflow-ir.ts:123`), executor path
  (`packages/engine/src/executor.ts` `executeWorkflowSteps`).
- UI state map: inline card toggles (`packages/dashboard/app/components/InlineCreateCard.tsx:113-1101`),
  edit toggles (`packages/dashboard/app/components/WorkflowResultsTab.tsx:332-488`), workflow picker
  (`packages/dashboard/app/components/TaskForm.tsx:1290`), modal create payload
  (`packages/dashboard/app/components/NewTaskModal.tsx:243`), route
  (`packages/dashboard/src/routes/register-workflow-routes.ts:317-329`), serialization gap
  (`packages/dashboard/app/components/workflow-flow-mapping.ts:435-562`, `:946-963`).
- Institutional learnings: per-entity override blast-radius and per-task auto-merge override precedent
  (`docs/solutions/architecture-patterns/per-entity-execution-principal-override-blast-radius.md`,
  `docs/solutions/logic-errors/per-task-auto-merge-override-ignored-by-trigger-gates.md`) — informed the
  decision to keep optional steps execution-inert rather than adding executor branches; worktree browser
  testing and mobile toggle gotchas as above.
