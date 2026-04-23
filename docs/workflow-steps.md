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

## Built-In Templates (7)

Fusion ships seven templates:

1. Documentation Review
2. QA Check
3. Security Audit
4. Performance Review
5. Accessibility Check
6. Browser Verification
7. Frontend UX Design

The **Browser Verification** template uses browser automation style checks and is designed for UI validation flows.

The **Frontend UX Design** template verifies visual polish and consistency with existing UI patterns and design tokens, including visual hierarchy, spacing/typography consistency, color/token consistency, component reuse, responsive behavior, and fit with existing design language.

## Model Overrides for Prompt Steps

A prompt-mode workflow step can specify its own model with:

- `modelProvider`
- `modelId`

If both are set, step execution uses that model; otherwise it falls back to default model selection.

## Default-On Behavior for New Tasks

Workflow step definitions support `defaultOn`.

When `defaultOn: true`, the step is preselected automatically for newly created tasks (users can still deselect it).

## Workflow Step Revision Loop

Workflow steps can request implementation revisions instead of just blocking completion.

### How It Works

When a prompt-mode workflow step agent finishes its review, it can output a **revision request** to indicate that code changes are needed:

```
REQUEST REVISION

Fix the SQL injection vulnerability in src/auth.ts. The login function does not
handle the case where the user account is locked.
```

### Behavior

When a revision is requested:

1. The executor generates a **Workflow Revision Instructions** section in the task's `PROMPT.md`
2. All step statuses are reset to `pending` for a fresh execution pass
3. The task remains in `in-progress` and a fresh executor session is scheduled
4. The agent receives the revision feedback at the start of its next session

### Feedback Format

Workflow step prompts should instruct agents to use this exact format for revision requests:

```
REQUEST REVISION

[Clear, actionable description of what needs to be fixed]
```

The revision block replaces any prior revision instructions (no accumulation).

### Hard Failures vs Revisions

Not all workflow failures are revision requests:

- **Revision requested**: Implementation needs changes → routes back to executor in-place while keeping the task in `in-progress`
- **Hard failure**: Treated as remediable until retries are exhausted; the executor injects feedback and sends the task through `todo → in-progress` for a fresh remediation pass

#### Pre-merge hard failure remediation flow

For pre-merge workflow hard failures, executor behavior is:

1. Retry the failing check up to `MAX_WORKFLOW_STEP_RETRIES` within the same execution lifecycle
2. On retry exhaustion, add a steering comment with failure details and inject a `Workflow Step Failure` section into `PROMPT.md`
3. Reopen only the last implementation step (`pending`) so prior completed work remains preserved
4. Schedule `todo → in-progress` after guard unwind, triggering a fresh executor remediation run

Tasks are not parked in `in-review` for this remediable path unless additional terminal failures occur.

#### Self-healing recovery for parked review tasks

If a task is found in `in-review` with failed pre-merge workflow results and no active executor, self-healing can auto-revive it (bounded by `maxPostReviewFixes`) by replaying the same remediation send-back flow.

## Viewing Results

Workflow status is visible in multiple places:

- **Task cards**: workflow checks are shown after normal implementation steps in the step list; each workflow row is labeled (`Workflow · Pre-merge` / `Workflow · Post-merge`) and progress counts include both implementation and workflow checks
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
