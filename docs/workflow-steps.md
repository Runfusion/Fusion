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

## Viewing Results

Task detail modal includes a **Workflow** tab when workflow data exists.

You can inspect:

- pass/fail/skipped status
- outputs/findings
- timing metadata

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
