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

## Execution Modes

- **Prompt mode**: starts an AI agent for the step
- **Script mode**: runs a named script from project settings (`settings.scripts`)

Prompt mode can run with readonly or coding-capable tool access depending on step/template configuration.

## Built-In Templates (6)

Fusion ships six templates:

1. Documentation Review
2. QA Check
3. Security Audit
4. Performance Review
5. Accessibility Check
6. Browser Verification

The Browser Verification template uses browser automation style checks and is designed for UI validation flows.

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

- **Revision requested**: Implementation needs changes → routes back to executor
- **Hard failure**: Unrecoverable issue → moves to `in-review` with `failed` status

Use revision requests when the implementation is wrong but fixable. Use hard failures only for genuine blockers (e.g., required files are missing, test infrastructure is broken).

## Viewing Results

Task detail modal includes a **Workflow** tab when workflow data exists.

You can inspect:

- pass/fail/skipped status
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
