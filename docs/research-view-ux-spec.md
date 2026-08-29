# Research view UX spec: layout and capability-state messaging

## Status
- **Task:** FN-4138
- **Purpose:** Consolidate the Research view UX requirements behind the known layout/rendering defects (FN-4134) and misleading web-search messaging defects (FN-4135).
- **Scope of this document:** Product/UX specification only. No source changes are made by this task.

## Source inputs and constraints

Reviewed inputs:
- `packages/dashboard/app/components/ResearchView.tsx`
- `packages/dashboard/app/components/ResearchView.css`
- `packages/dashboard/app/hooks/useResearch.ts`
- `packages/dashboard/app/components/__tests__/ResearchView.test.tsx`
- `packages/core/src/research-settings.ts`
- `packages/core/src/types.ts`
- `packages/core/src/settings-schema.ts`
- `docs/settings-reference.md`
- `AGENTS.md` dashboard styling guidance

Important current-state constraint:
- `.fusion/tasks/FN-4134/PROMPT.md` and `.fusion/tasks/FN-4135/PROMPT.md` were not present in this worktree, and board lookup did not return resolvable task records in this execution context. This spec therefore treats the current code, tests, and repo documentation as the source of truth and calls out any implementation notes that FN-4134/FN-4135 executors must reconcile.

## Problem statement

The Research view currently mixes two unrelated defect classes:

1. **Visual/layout defects**
   - The view has an under-specified large-screen scroll model and a crowded reader card structure.
   - Long selected-run content, findings, citations, events, action rows, and the stats block all live in the same reader card without a defined internal layout contract.
   - The sidebar/history column and reader column do not have equally explicit independent scroll behavior.

2. **Capability-state messaging defects**
   - The current `setupState` branch collapses multiple causes into one blocking error-style card: unavailable subsystem, disabled research, and missing provider credentials all render through `data-testid="research-state-unavailable"`.
   - This makes the UI too binary and too error-toned for cases where research is enabled but one capability is degraded.
   - The long-term direction from the existing code/tests/settings is that web search is **always on** and should never be described as disabled when it is functioning.

These two defect classes must be implemented and tested separately even though they affect the same screen.

## Current implementation baseline

### Existing selectors and structure

Current `ResearchView.tsx` exposes these stable selectors that implementation should preserve unless explicitly noted otherwise:
- `research-state-unavailable`
- `research-state-loading`
- `research-state-error`
- `research-state-empty`
- `research-state-results`
- `research-state-running`

Current structural classes that this spec references:
- `.research-view`
- `.research-view__header`
- `.research-view__layout`
- `.research-view__sidebar`
- `.research-view__reader`
- `.research-view__history`
- `.research-view__status-row`
- `.research-view__actions`
- `.research-view__findings`
- `.research-view__stats`

### Important current-state notes

- `resolveResearchSettings()` hard-codes `enabledSources.webSearch: true`.
- `ResearchView.tsx` hard-locks the `web-search` provider on (`providerLocked`), and the checkbox label reads `Web Search (always on)`.
- There is **no live `webSearchExplicitlyDisabled` branch** in the current component.
- There is **no live `data-testid="research-state-web-search-disabled"` element** in the current component. The only in-repo reference is a negative regression assertion in `ResearchView.test.tsx`.
- `research-state-running` is currently attached to the history-list container, not to a lifecycle-status element. Because existing tests may depend on it, implementers should preserve it for now unless they update tests deliberately in the same task.

## Defect inventory

### A. Visual/layout defects

Observed from the current structure/CSS:
- The reader card does not define a dedicated content body plus footer contract; selected-run details and stats are simply stacked in one column.
- Long content can crowd the stats block because `.research-view__reader` has no dedicated inner scrolling region for the selected-run content.
- Only `.research-view__history` explicitly scrolls; the reader panel does not have an equally explicit desktop/tablet scroll region.
- `.research-view__actions` allows unrestricted wrapping, so multi-button rows can fragment into visually noisy stacks around the summary/findings area.
- The mobile stack direction is clear, but the intended order and bottom-spacing behavior are not documented as UX requirements.

### B. Capability-state messaging defects

Observed from the current `setupState` behavior:
- `availability.available === false`, `effectiveSettings.enabled === false`, and `missingCredentialProvider` all funnel into the same blocking card and error styling.
- Disabled research and degraded provider availability are not currently distinguished with different UX tone.
- The card includes low-value implementation-detail copy (`Current defaults: provider ..., max sources ...`) that should not appear in primary state messaging.
- The common case must not show any copy that implies web search is disabled or unavailable when the working backend is available.

## Capability-state model

The implementation must explicitly support these three states and no ambiguous fourth state.

### State A — Research disabled

**Trigger**
- `researchSettings.enabled === false`, or
- the merged effective research-enabled flag resolves false (`researchEnabled === false` / equivalent global fallback), or
- the subsystem is intentionally disabled for the project/runtime.

**Expected UX**
- If the experimental Research view feature itself is disabled, the Research nav entry may remain hidden as it does today.
- If the Research view is reachable but research is disabled, render a **single empty-state or setup-state card only**.
- Do **not** render the query form, provider checkboxes, history sidebar, results reader, or stats block.
- Tone is informational, not error-first.
- Primary CTA links directly to **Settings → Research** (`research-project`, or the relevant research settings section if global disablement is what the implementation exposes).

**Approved copy**
- Title/body copy allowed:
  - `Research is turned off for this project. Enable it in Settings → Research.`
- Optional CTA label:
  - `Open Research Settings`

**Disallowed copy**
- `Current defaults: provider ..., max sources ...`
- Any error-style wording implying the system is broken rather than turned off.

**Required test markers**
- Must appear: `research-state-unavailable`
- Must not appear: `research-state-empty`, `research-state-results`, query field, provider checklist, run-history list

### State B — Research enabled, web search unavailable

**Trigger**
- Research is enabled, but the active web-search backend is not currently usable at runtime.
- Valid causes include:
  - auth failure for the chosen backend,
  - connectivity/provider outage,
  - runtime missing required backend config,
  - any other true availability failure from the backend layer.

**Important rule**
- After FN-4135, this state must be driven by a **real runtime availability signal**, not by a user selecting a “disable web search” option.
- The settings model already points in this direction: `researchGlobalWebSearchProvider` selects a backend, while web search itself remains conceptually on.

**Expected UX**
- The view still renders normally.
- Query form, provider list, history list, reader, and stats remain available.
- The web-search provider row remains visible and reflects the real state.
- Show a **non-blocking advisory** near the provider controls or directly above the create-run form.
- The advisory explains what is unavailable, why, and how to fix it.
- Other usable research sources remain available.
- Do **not** replace the whole view with the blocking `research-state-unavailable` card for this state.

**Approved copy**
- `Web search is currently unreachable ({provider}). Other sources will still run. Open Settings → Research to review provider setup.`
- If the failure is specifically auth-related and the implementation can distinguish it:
  - `Web search is currently unreachable ({provider}) because its credentials are missing or invalid. Other sources will still run. Open Settings → Research.`

**Disallowed copy**
- `Web search is disabled`
- `Web search not enabled`
- Any copy that suggests the user intentionally turned web search off
- Any copy that blocks the full screen when other sources are still usable

**Required test markers**
- Must appear: normal form UI, provider checklist, `research-state-running` history container when runs exist
- Must not appear: full-screen `research-state-unavailable` card used for disabled research
- If implementation adds a dedicated advisory marker, it should be additive and tested directly, but existing selectors above must remain stable

### State C — Web search enabled and available

**Trigger**
- Research is enabled and the active web-search backend is available.
- This is the expected/common case.

**Expected UX**
- No disabled-state card.
- No warning/advisory banner.
- Web-search provider checkbox is visible, checked, and not presented as unavailable.
- Normal empty/loading/results states render as applicable.

**Approved copy**
- No capability warning copy.

**Disallowed copy**
- Any variant of `Web search is disabled`
- Any variant of `Web search not enabled`
- Any warning that contradicts the working backend state

**Required test markers**
- Must not appear: `research-state-unavailable`
- Must not appear: any dedicated web-search-unavailable advisory marker
- May appear depending on state: `research-state-loading`, `research-state-empty`, `research-state-results`

## Copy requirements

### Approved state copy

Only the following capability-state messaging is allowed:

- **State A**
  - `Research is turned off for this project. Enable it in Settings → Research.`
- **State B**
  - `Web search is currently unreachable ({provider}). Other sources will still run. Open Settings → Research to review provider setup.`
- **State C**
  - No capability-state message

### Copy rules

- Sentence case only.
- End full-sentence informational copy with a period.
- Use `Settings → Research` as the preferred path label in body copy.
- Use concise CTA labels (`Open Research Settings`, `Open Settings`) consistent with neighboring dashboard patterns.
- Do not expose implementation-detail diagnostics in the main empty/setup card unless they are intentionally placed in secondary expandable help.

### Long-term FN-4135 rule

Once FN-4135 lands, state B must never be triggered by a settings choice that conceptually disables web search. It may only be triggered by a real runtime/availability failure.

## Responsive and layout expectations

### Desktop (>= 1024px)

Required behavior:
- Two-column layout remains: history sidebar + reader.
- Sidebar and reader have **independent scroll regions**.
- No element overlaps another.
- Reader content has a clear vertical structure:
  1. status row
  2. run title/query/summary
  3. action row
  4. findings/citations/history content
  5. stats block anchored after content within the reader flow without colliding with the content above
- Action buttons should fit on one row at common desktop widths unless the viewport is unusually narrow.
- The history sidebar search and run list remain usable without affecting reader scroll.

### Tablet (769px–1024px)

Required behavior:
- Preserve the two-column structure.
- Sidebar may narrow or condense, but must remain readable/selectable.
- Reader actions may wrap to a second row only if needed; they must not visually merge with the status row.
- No overlap, clipping, or footer collisions are permitted.

### Mobile (<= 768px)

Required behavior:
- Single-column stack.
- Sidebar content appears **above** the reader.
  - Rationale: create-run controls and history selection are the primary navigation affordances on mobile and should remain first in flow.
- Use page-level vertical scrolling.
- Preserve bottom padding with the safe-area pattern:
  - `var(--mobile-nav-height)`
  - `env(safe-area-inset-bottom, 0px)`
  - `var(--standalone-bottom-gap)`
- All interactive elements must meet the existing mobile target standard from `AGENTS.md` (minimum 36px, with existing shared touch-target conventions where applicable).
- Stats collapse to a single column.
- Button groups may stack, but spacing must remain consistent and readable.

## Styling/token requirements

Implementation must use existing dashboard tokens only.

Required token families:
- spacing: `--space-*`
- radius: `--radius-*`
- color/text/surface/border tokens: `--color-*`, `--text*`, `--surface`, `--card`, `--border`
- transitions/focus/shadows where applicable: existing shared token set from `AGENTS.md`

Implementation must not:
- introduce hardcoded colors,
- introduce hardcoded spacing that duplicates tokenized values,
- bypass the established mobile bottom-padding pattern,
- replace existing shared button/card/input styling with one-off primitives.

## Selector preservation requirements

To protect the existing test surface, FN-4134/FN-4135 implementations should preserve these current selectors unless the same task updates the tests intentionally:
- `research-state-unavailable`
- `research-state-loading`
- `research-state-error`
- `research-state-empty`
- `research-state-results`
- `research-state-running`

Implementation note:
- `research-state-running` is semantically misnamed today because it is attached to the history list container rather than a running-state indicator. Preserve it for compatibility first; rename only if the implementation task updates tests at the same time.

## Acceptance criteria

### Visual/layout AC (maps to FN-4134)

Pass/fail requirements:
- **Desktop symptom 1:** the header block and the Refresh button never overlap or force content underneath them.
- **Desktop symptom 2:** the history sidebar and reader are simultaneously visible as two columns, and scrolling the run list does not move the reader content unexpectedly.
- **Desktop symptom 3:** long findings/citations/run-history content does not visually collide with the stats block at the bottom of the reader card.
- **Desktop symptom 4:** the status row remains visually separate from the action buttons; export/cancel/retry controls do not wrap upward into the status row.
- **Tablet symptom 1:** the two-column layout remains intact through the 769px–1024px range; the sidebar may narrow, but it does not collapse under or over the reader.
- **Tablet symptom 2:** wrapped action buttons remain in their own row group and do not clip the summary or findings content.
- **Mobile symptom 1:** the view becomes a single-column stack with sidebar above reader.
- **Mobile symptom 2:** page-level scrolling works end to end, with the final content still readable above the mobile-nav/safe-area bottom padding.
- **Mobile symptom 3:** stats collapse to one column and do not sit beside or overlap findings/history content.
- The implementation uses dashboard design tokens rather than hardcoded pixel/color values.
- The mobile bottom-padding safe-area pattern remains intact.
- Existing CSS-fixture-based regression coverage is preserved and expanded as needed for the finalized layout contract.

Required regression coverage:
- CSS-fixture assertion for `.research-view__layout` desktop grid structure (`display: grid` and `grid-template-columns: minmax(0, 1fr) minmax(0, 2fr)`).
- CSS-fixture assertion for the mobile media-query stack (`.research-view__layout` switches to a single-column/flex stack at `max-width: 768px`).
- CSS-fixture assertion for `.research-view` mobile scroll behavior and safe-area bottom padding using `var(--mobile-nav-height)`, `env(safe-area-inset-bottom, 0px)`, and `var(--standalone-bottom-gap)`.
- Targeted regression coverage for the finalized reader/scroll contract and any action-row wrapping rules added by FN-4134.

### Capability-state messaging AC (maps to FN-4135 plus this spec)

Pass/fail requirements:
- State A, B, and C are implemented as distinct, testable behaviors.
- Disabled research (state A) renders a single informational setup/empty state with approved copy and settings CTA.
- Web-search unavailability (state B) renders as a non-blocking advisory inside the normal view, not as a full-screen unavailable card.
- Working web search (state C) renders with no contradictory warning or disabled-state messaging.
- No approved UI string may say `web search is disabled` or `web search not enabled` when the backend is functioning.
- The current full-screen unavailable card is not used for the common working case.
- A regression test proves that the component never renders `data-testid="research-state-web-search-disabled"` when web search is functionally available, whether or not FN-4135 reintroduces a dedicated advisory marker during refactoring.
- The always-on web-search behavior stays aligned with Settings → Research, which already shows a non-editable Web Search row with `Always on` help text; ResearchView copy must not contradict that settings IA.
- Once FN-4135 removes any conceptual “disable web search” option, state B is only driven by real runtime availability failures.

## Task breakdown recommendation

### Recommendation: ship as two sequenced tasks

Recommended order:
1. **FN-4134 first** — layout/rendering contract
2. **FN-4135 second** — capability-state messaging/runtime-availability cleanup

### Rationale

These should remain separate because they have different implementation pressure:
- FN-4134 is primarily CSS/JSX layout behavior and visual regression coverage.
- FN-4135 is primarily state modeling, settings/capability interpretation, copy, and view-branch cleanup.
- They have different test surfaces.
- Sequencing the layout work first gives the messaging cleanup a stable visual baseline.
- Keeping them separate reduces review noise and avoids mixing responsive/UI structure changes with capability-state semantics.

## Implementation notes: gaps and task-alignment checks

The current codebase reveals one UX gap that neither referenced implementation task description is guaranteed to cover unless called out explicitly:

1. **State A vs. State B separation is not present today**
   - `ResearchView.tsx` currently routes disabled research, subsystem unavailability, and missing credentials through the same `setupState` card.
   - FN-4135 should explicitly own the split between:
     - true disabled state (blocking, single-card)
     - degraded runtime availability state (non-blocking advisory)

2. **Runtime availability signal for state B is not present in the current view contract**
   - `ResearchAvailability` currently exposes `available`, `code`, `reason`, `setupInstructions`, `supportedProviders`, and `supportedExportFormats`.
   - It does not currently expose a dedicated “web search available/unavailable but research still usable” signal.
   - FN-4135 must explicitly introduce or derive that signal from real runtime/backend failure handling rather than inferring it from provider selection alone.

3. **Settings IA is already partially aligned and must stay aligned**
   - `SettingsModal.tsx` already renders a non-editable `Web Search` source row in project Research settings with helper text: `Always on. The resolver ignores any older persisted enabledSources.webSearch=false value.`
   - FN-4135 should treat that settings row as the IA baseline and ensure ResearchView capability messaging matches it.

4. **Historical phantom selector reference**
   - `research-state-web-search-disabled` is not present in the live component.
   - If FN-4135 introduces a dedicated advisory marker, it should do so intentionally and update tests in the same task.
   - Until then, executors should treat the existing negative test reference as a regression intent, not as proof of a current DOM node.

### Task-alignment checks

- **FN-4134 alignment:** The layout portion of this spec is intentionally scoped to `ResearchView.tsx`/`ResearchView.css` structure, responsive behavior, and test coverage. That aligns with the existing repo evidence for FN-4134 as a rendering/layout task.
- **FN-4135 alignment:** The capability-state portion of this spec is intentionally scoped to research settings interpretation, capability messaging, and Research view branch behavior. That aligns with the existing repo evidence for FN-4135 as a web-search/default-state cleanup task.
- **Execution-context caveat:** In this task run, the sibling task `PROMPT.md` files were not readable from `.fusion/tasks/`, so the alignment statement above is based on current source/tests plus the repo's own references to FN-4134/FN-4135. If those sibling prompts contain narrower file-scope language, this spec should win for UX intent and the implementation task should note any required scope reconciliation in its own execution log.
- **Settings IA note:** Project Research settings already expose a non-editable `Web Search` row with `Always on` helper text. ResearchView capability copy must stay consistent with that settings language rather than reintroducing any “disabled” framing.

## Documentation/index update requirement

Add this document to `docs/README.md` under a fitting section when landing the spec. Because this is a canonical UX spec for future implementation tasks, it belongs in the docs index.
