---
category: architecture
module: engine
tags:
  - triage
  - release-safety
  - authorization
problem_type: security
applies_when:
  - triage finalizes tasks that mention package release or publish commands
  - agents or automation can create follow-up tasks
---

# Release-class triage requires explicit user authorization

## Problem

Autonomous agents can draft tasks that mention release mechanics such as `pnpm release --yes`, `scripts/release.mjs`, changeset publish, npm publish, semver tags, or release-version commits. Without a triage boundary, an agent-authored release task can be dispatched to execution and reach publish-class commands without a user intentionally authorizing the release.

## Solution

Release authorization is enforced as a pure triage gate before finalize dispatch moves work to `todo`:

1. Classify release-class tasks from the combined title, description, and prompt text.
2. For release-class tasks, require a user-authored source (`dashboard_ui`, `quick_chat`, `chat_session`, or `cli`).
3. Require the prompt marker `**Release Authorized By User:** yes` for those user-authored sources.
4. Fail closed for unknown, internal, API, imported, duplicated, refined, workflow, recovery, research, cron, and agent-authored sources.

The marker alone is intentionally insufficient. A non-user source that embeds the marker remains blocked because agents and integrations can write prompt text.

## Verification

Use the pure classifier tests in `packages/engine/src/__tests__/triage-release-authorization.test.ts` to cover the invariant without store, network, or timer dependencies. The test matrix should include the FN-6469 incident shape, all documented release signal patterns, all user-authored sources, representative non-user sources, marker parsing, and non-release pass-through behavior.
