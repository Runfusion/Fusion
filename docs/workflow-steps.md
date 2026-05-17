# Workflow Steps

[← Docs index](./README.md)

Workflow steps are reusable quality gates that run around task completion.

## What They Are

A workflow step is a reusable check (AI prompt or script) that can be enabled on tasks.

Common use cases:

- Documentation review
- QA/test verification
- Security scanning
- Performance checks
- Accessibility checks
- Browser-level verification

## Execution Phases

Workflow steps run in one of two phases:

- **Pre-merge** (default): runs before merge/finalization; failure blocks completion
- **Post-merge**: runs after successful merge; failure is logged but non-blocking

> **Note on Fast Mode:** When a task has `executionMode: "fast"`, pre-merge workflow steps are bypassed entirely during executor completion. Post-merge workflow steps remain active and run normally (post-merge is merger-owned and unaffected by execution mode).

## Execution Modes

- **Prompt mode**: starts an AI agent for the step
- **Script mode**: runs a named script from project settings (`settings.scripts`)

Prompt mode can run with readonly or coding-capable tool access depending on step/template configuration.

## Tool Modes

`toolMode: "readonly"` is enforced as a hard session-level allowlist. Readonly workflow-step agents can only access:

- `read`
- `grep`
- `find`
- `ls`
- `fn_web_fetch`
- `fn_task_show`
- `fn_task_list`
- `fn_insight_list`
- `fn_insight_show`
- `fn_list_agents`
- `fn_get_agent_config`

Readonly steps cannot hold `edit`, `write`, `bash`, or task/agent mutation tools. Attempts to use denied tools fail closed with `READONLY_VIOLATION` and are surfaced as a `[readonly-violation]` workflow-step failure outcome.

Use `toolMode: "coding"` for any prompt step that must modify files, run shell commands, or perform mutation actions.

## Gate Modes

Workflow steps also have a `gateMode`:

- **`gate`**: failures block merge/completion and follow normal remediation/retry flows.
- **`advisory`**: failures are recorded as `advisory_failure` and shown as polish feedback, but never block merge.

Defaults:
- all steps → `advisory` (advisory-by-default per FN-4368; opt in to `gate` per step in **Settings → Workflow Steps**).

## Built-In Templates (7)

Fusion ships seven templates:

1. Documentation Review
2. QA Check
3. Security Audit
4. Performance Review
5. Accessibility Check
6. Browser Verification
7. Frontend UX Design

All seven built-in templates emit the structured `{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}` envelope introduced in FN-4367 (final line JSON only). The legacy `REQUEST REVISION` prose path remains as a backward-compatible fallback. See [Prompt-mode Structured Verdict Contract](#prompt-mode-structured-verdict-contract).

The **Browser Verification** template uses browser automation style checks and is designed for UI validation flows.

The **Frontend UX Design** template verifies visual polish and consistency with existing UI patterns and design tokens, including visual hierarchy, spacing/typography consistency, color/token consistency, component reuse, responsive behavior, and fit with existing design language.

> **FN-3906 + FN-4343 auto-skip behavior:** The pre-merge orchestrator auto-skips the built-in `frontend-ux-design` step before pause/defer checks when workflow relevance signals show no frontend/UI scope. It now evaluates both (1) the task diff scope and (2) declared `## File Scope` from `PROMPT.md`. Scope relevance includes extensions (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.html`, `.css`, `.scss`, `.sass`, `.less`, `.styl`), common UI path segments (`/components/`, `/app/components/`, `/dashboard/`, `/frontend/`, `/ui/`, `/styles/`, `/themes/`, `/design-system/`, `/design-tokens/`), and token/theme filenames (`tokens.(ts|js|json|css)`, `theme.(ts|js|json|css)`). If both signals are empty (or capture fails), Fusion preserves legacy behavior and runs the step.

## Plugin-Contributed Steps

Installed plugins can also provide **workflow step templates** that you enable from **Settings → Workflow Steps**, just like Fusion’s built-in quality gates.

Plugin-contributed templates appear in the same workflow-step chooser/UI as built-ins. In that chooser, plugin entries are labeled/grouped as plugin-contributed (including plugin attribution in the template metadata) so you can distinguish them from Fusion-provided templates.

Once added, plugin-contributed workflow steps behave like other steps: they support the same `prompt` or `script` execution modes, `pre-merge` or `post-merge` phases, and `defaultOn` behavior for new tasks.

For plugin installation and authoring details, see the [Plugin Authoring Guide](./PLUGIN_AUTHORING.md) (Section 16: Registering Workflow Steps).

## Creating Workflow Steps in the Dashboard

From **Settings → Workflow Steps**, clicking **Add Workflow Step** now opens a chooser first:

- **Built-in templates** are shown immediately so you can add review/QA steps with one click
- **Custom workflow step** opens the manual form for fully custom prompt/script steps

The custom path is always available, even while templates are still loading or if template loading fails.

## Model Overrides for Prompt Steps

A prompt-mode workflow step can set its own model with:

- `modelProvider`
- `modelId`

If both are set, step execution uses that model; otherwise it falls back to default model selection.

## Default-On Behavior for New Tasks

Workflow step definitions support `defaultOn`.

When `defaultOn: true`, the step is preselected automatically for newly created tasks (users can still deselect it).

## Workflow Step Revision Loop

Workflow steps can request implementation revisions instead of just blocking completion.

### How It Works

Prompt-mode workflow step output is parsed in this order:

1. Structured JSON verdict (`parseWorkflowStepVerdict`)
2. Legacy prose fallback (`inferWorkflowStepVerdictFromProse`)
3. `malformed` when neither format can be interpreted

#### Structured Verdict Output

Use a JSON object with this schema:

```json
{ "verdict": "APPROVE|APPROVE_WITH_NOTES|REVISE", "notes": "..." }
```

- Valid `verdict` values are exactly: `APPROVE`, `APPROVE_WITH_NOTES`, `REVISE`.
- `notes` is optional and defaults to `""` when missing or non-string.
- The parser checks fenced and inline JSON candidates, and the **last valid candidate wins**.

Accepted shapes:

- Fenced JSON block (supports both ``` and ```json fences):

```json
{"verdict":"REVISE","notes":"Fix auth lock handling in src/auth.ts."}
```

- Inline JSON object scanned from prose:

`Review complete. {"verdict":"APPROVE_WITH_NOTES","notes":"Looks good; consider tightening error copy."}`

Additional example:

`{"verdict":"APPROVE"}`

#### Prose Fallback

Legacy prose is still supported when structured JSON is missing:

- Output beginning with `REQUEST REVISION` (case-insensitive) maps to `REVISE`.
  - Remaining prose becomes `notes`.
  - If nothing follows, notes default to `"Revision requested"`.
- Output containing one of these phrases maps to `APPROVE` with empty notes: `approve`, `approved`, `looks good`, `no issues`, `out of scope`.

For new workflow step prompts, prefer the structured JSON contract.

#### Malformed Output

If output matches neither structured JSON nor known prose fallback patterns, Fusion records the step output as `malformed`. Operationally, this means no workflow verdict could be inferred from that response.

### Behavior

When a revision is requested:

1. Fusion scope-checks any explicit file paths named in the feedback against the task's declared `## File Scope`
2. In-scope feedback is appended to a **Workflow Revision Instructions** section in the task's `PROMPT.md`
3. Explicitly out-of-scope feedback is forked into a dependent follow-up triage task instead of mutating the original task branch
4. If both kinds are present, Fusion splits the feedback: the original task reruns only with the retained in-scope block while the follow-up captures the unrelated work
5. If no in-scope feedback remains after splitting, the original task is left untouched and continues its normal completion path while only the follow-up task is created
6. When the original task retains in-scope feedback, only the last implementation step is reopened and a fresh executor session is scheduled

### Feedback Format

Recommended (structured JSON, prompt-mode):

```json
{"verdict":"REVISE","notes":"[Clear, actionable description of what needs to be fixed]"}
```

Also valid for approvals:

```json
{"verdict":"APPROVE","notes":""}
{"verdict":"APPROVE_WITH_NOTES","notes":"Optional non-blocking feedback"}
```

Legacy fallback (still supported via prose inference):

```
REQUEST REVISION

[Clear, actionable description of what needs to be fixed]
```

The revision block replaces any prior revision instructions (no accumulation).

By default this split-and-fork behavior is enabled through the project setting `workflowRevisionForkOnScopeMismatch`. Set it to `false` to restore the legacy behavior that appends all workflow revision feedback to the original task even when it references files outside the declared File Scope.

### End-of-step file-scope invariant for prompt pre-merge steps (FN-4343)

After each successful **prompt-mode pre-merge** workflow step, Fusion runs a scope invariant check on files newly touched by that step (committed delta plus uncommitted working-tree edits):

- If declared `## File Scope` is empty, the invariant is skipped.
- If task `scopeOverride === true`, the invariant is bypassed (same semantics as merge-time scope enforcement).
- If touched files have zero overlap with declared scope, Fusion emits a scope-leak log and applies `workflowStepScopeEnforcement`:
  - `"block"` (default): mark the workflow step `failed`, request revision, and route through the normal executor revision loop.
  - `"warn"`: log the violation but allow the step to pass.
  - `"off"`: disable this pre-merge workflow-step invariant entirely.

### Executor `fn_task_done` scope-leak guard for Plan-Only tasks (FN-4482)

Fusion also enforces a completion-time scope-leak check in the executor `fn_task_done` path:

- Applies to tasks with declared `## File Scope`.
- Uses touched files from branch committed delta plus uncommitted working-tree edits at completion time.
- Emits `[scope-leak]` activity-log entries when touched files are off-scope.
  - Off-scope touched-file and declared-scope lists are truncated to the first 10 entries with `… (+N more)` when longer.
  - Log entries include `total off-scope=` and `total scope=` counters so full list sizes remain explicit.
  - In `"block"` mode, the `fn_task_done` refusal message uses the same truncated off-scope preview.
- Honors `task.scopeOverride === true` as an explicit bypass.

`planOnlyScopeLeakEnforcement` controls Review Level 1 behavior:

- `"warn"` (default): log and allow completion.
- `"block"`: refuse `fn_task_done` and ask the agent to revert off-scope paths.
- `"off"`: disable this completion-time guard.

Review Level `0` and `>=2` run in warn-only telemetry mode (never block).

### Hard Failures vs Revisions

Not all workflow failures are revision requests:

- **Revision requested**: Implementation needs changes → routes back to executor in-place while keeping the task in `in-progress`
- **Hard failure**: Treated as remediable until retries are exhausted; the executor injects feedback and sends the task through `todo → in-progress` for a fresh remediation pass

#### Pre-merge hard failure remediation flow

For pre-merge workflow hard failures, executor behavior is (gate-mode steps):

1. Retry the failing check up to `MAX_WORKFLOW_STEP_RETRIES` within the same execution lifecycle
2. On retry exhaustion, add a steering comment with failure details and inject a `Workflow Step Failure` section into `PROMPT.md`
3. Reopen only the last implementation step (`pending`) so prior completed work remains preserved
4. Schedule `todo → in-progress` after guard unwind, triggering a fresh executor remediation run

Tasks are not parked in `in-review` for this remediable path unless additional terminal failures occur.

#### Self-healing recovery for parked review tasks

If a task is found in `in-review` with failed pre-merge workflow results and no active executor, self-healing can auto-revive it (bounded by `maxPostReviewFixes`) by replaying the same remediation send-back flow.

Advisory failures are intentionally excluded from merge blocking and auto-revive.

## Viewing Results

Workflow status is visible in multiple places:

- **Task cards**: workflow checks are shown after normal implementation steps in the step list; each workflow row uses the compact `workflow` badge label (while still retaining pre/post-merge styling semantics) and progress counts include both implementation and workflow checks
- **List view (desktop + mobile)**: progress labels/bars use the same unified step model as task cards
- **Task detail modal**: includes a **Workflow** tab when workflow data exists

In the Workflow tab, you can inspect:

- pass/fail/skipped/running status
- outputs/findings
- timing metadata

### Output Rendering

Workflow step outputs support both markdown rendering and plain text modes:

- **Markdown mode** (default): Renders output with proper markdown formatting including tables, code blocks, lists, and GFM extensions (task lists, strikethrough, etc.)
- **Plain mode**: Shows raw text without markdown interpretation

Toggle between modes using the "Markdown"/"Plain" button that appears when an output is expanded.

### Expanded Output Viewer

For long outputs, click the expand icon (maximize) to open a larger viewer modal. The expanded view:

- Displays the full output in a modal overlay
- Supports the same markdown/plain toggle as the inline view
- Closes via the X button, backdrop click, or Escape key
- Syncs with the current render mode of the step

This makes it easier to read structured markdown output and long logs.

### Prompt-mode Structured Verdict Contract

Prompt-mode workflow agents should emit a trailing JSON object:

`{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`

- `verdict` and `notes` are persisted on `WorkflowStepResult` when present.
- Script-mode steps do not populate these fields.
- Backward compatibility remains for legacy prose-only responses via heuristic fallback (`REQUEST REVISION` and approval keywords).
- If neither structured JSON nor fallback prose can be interpreted, output is recorded as `malformed` (no inferable verdict) instead of hard-failing the task.

## Workflow Step APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/workflow-steps` | List workflow steps |
| `POST /api/workflow-steps` | Create workflow step |
| `PATCH /api/workflow-steps/:id` | Update step |
| `DELETE /api/workflow-steps/:id` | Delete step |
| `POST /api/workflow-steps/:id/refine` | AI-refine prompt |
| `GET /api/workflow-step-templates` | List built-in templates |
| `POST /api/workflow-step-templates/:id/create` | Materialize template as workflow step |

## Screenshot

![Workflow step manager](./screenshots/workflow-steps.png)

See also: [Task Management](./task-management.md) and [Settings Reference](./settings-reference.md).
