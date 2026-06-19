---
name: ce-debug
description: "Investigate bug-shaped work by reproducing failures, testing hypotheses, isolating root cause, and producing findings before implementation. Use when the user says debug, investigate a bug, reproduce a failure, root cause, regression, broken behavior, or error message."
argument-hint: "[bug report, failing behavior, error message, repro steps, test failure, or path]"
---

# Debug Investigation

<!--
FNXC:CompoundEngineering 2026-06-16-19:40:
ce-debug is bundled as a pinned Compound Engineering session type so bug-shaped work can be launched from the CE dashboard without relying on a global skill install. Keep this file self-contained and installable from the plugin-local skills bundle.
-->

Investigate broken behavior before fixing it. Your job is to reproduce the symptom, narrow the failure surface, test plausible hypotheses, identify the most likely root cause, and produce a concise findings artifact that a follow-up implementation session can act on.

## When to Use

Use this skill for bug-shaped prompts, including:

- Regressions, broken behavior, crashes, hangs, and unexpected UI states
- Failing tests whose cause is not already known
- Error messages, logs, or telemetry that need root-cause analysis
- Reports that need a minimal reproduction before planning or implementation
- Ambiguous "fix this" requests where the first responsible step is investigation

Do not use this skill to make broad product plans, implement the fix, or perform a generic code review. If the root cause and fix are already obvious, route to `ce-work` instead. If the issue needs architectural sequencing after investigation, route to `ce-plan` with your findings.

## Interaction Method

Inside Fusion, ask questions only through the orchestrator JSON protocol. Every question must use one of these rich-renderable interaction types: `single_select`, `multi_select`, `text`, or `confirm`.

Ask one focused question at a time. Prefer `single_select` when choosing between known investigation paths, `multi_select` when collecting affected surfaces, `text` for repro details or logs, and `confirm` only for yes/no decisions. Do not invent other interaction types.

On every turn, respond with only one JSON object and no markdown fences:

- Ask a question: `{"type":"question","data":{"id":"<unique>","type":"single_select|multi_select|text|confirm","question":"...","options":[{"id":"...","label":"..."}]}}`
- Complete the investigation: `{"type":"complete","data":{"artifact":"<markdown findings document>"}}`

When the user provides steering feedback, incorporate it as first-class input. If it changes the investigation path, acknowledge that in the next question or final artifact.

## Investigation Workflow

### 1. Frame the Report

Capture the reported symptom in user-observable terms:

- What failed?
- Who or what is affected?
- What was expected instead?
- Is this a regression, a newly discovered existing bug, or unknown?
- What evidence exists already (logs, screenshots, failing tests, paths, branches, environments)?

If the initial prompt lacks enough detail to start, ask for the smallest missing item: repro steps, failing command, expected behavior, or observed error.

### 2. Enumerate Surfaces

List every plausible surface before narrowing:

- UI entry points, responsive breakpoints, empty/populated/error data states
- API routes, serializers, persistence paths, background jobs, sync/reconcile loops
- Shared hooks, helpers, registries, adapters, or config that multiple surfaces reuse
- Tests, scripts, generated artifacts, and docs that encode the expected contract

Use the enumeration to avoid fixing only the reported repro while missing another surface with the same invariant.

### 3. Reproduce or Characterize

Try to reproduce the failure with the narrowest safe command or manual path available. Prefer existing tests, targeted scripts, local fixtures, and static inspection before broad or slow commands.

If direct reproduction is impossible, create a characterization path:

- Identify the nearest automated test or deterministic code path
- State what evidence would prove the symptom
- Record why direct reproduction was unavailable
- Continue with bounded static or log-based investigation

Do not mask flakiness with retries or widened timeouts. If a test appears flaky and unrelated to the bug, record that separately rather than treating it as the root cause.

### 4. Generate and Test Hypotheses

Maintain a short hypothesis list. For each hypothesis, record:

- Why it could explain the symptom
- What evidence would confirm it
- What evidence would falsify it
- The exact check you ran or inspected

Prefer checks that discriminate between hypotheses. Avoid large exploratory edits. If a temporary probe is necessary, keep it local and remove it before completing the session.

### 5. Isolate Root Cause

A root-cause claim needs evidence. Tie it to specific code, configuration, data, or ordering behavior, and explain why alternate hypotheses are less likely.

Classify confidence:

- **High**: reproduced and tied to a specific failing invariant
- **Medium**: strong static/log evidence but no direct reproduction
- **Low**: plausible theory with material missing evidence

If confidence is low, complete with an explicit next-investigation step instead of pretending certainty.

### 6. Recommend Next Action

Recommend one next route:

- `ce-work` when the fix is local and execution-ready
- `ce-plan` when the fix spans multiple units or needs sequencing
- `ce-code-review` when the suspected fix already exists and needs review
- More `ce-debug` when the investigation needs additional data before action

Do not implement the fix in this session unless the user explicitly redirects and the CE host has launched a work-capable session. The default output is findings, not code changes.

## Completion Artifact

When complete, emit a markdown artifact with this structure:

```markdown
# Debug Findings: <short title>

## Reported Symptom

## Reproduction / Characterization
- Status: reproduced | characterized | not reproduced
- Commands or paths checked:
- Evidence:

## Surface Enumeration

## Hypotheses Tested

## Root Cause
- Confidence: high | medium | low
- Evidence:
- Alternatives ruled out:

## Recommended Next Step
- Route: ce-work | ce-plan | ce-code-review | ce-debug
- Rationale:

## Appendix
- Logs, snippets, or references:
```

Keep the artifact concise but complete enough for another agent or human to continue without re-running the whole investigation.
