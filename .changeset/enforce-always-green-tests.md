---
"@gsxdsm/fusion": patch
---

Enforce always-green test-suite instructions for executor agents

Strengthen executor-facing instructions so agents are explicitly required to keep the repository test suite green before completion, even when failures appear pre-existing or unrelated to the current task. This prevents "unrelated failure" deferrals from accumulating technical debt.

Changes:
- Added explicit language to EXECUTOR_SYSTEM_PROMPT requiring resolution of ALL test failures, including those that appear unrelated or pre-existing
- Added same language to buildExecutionPrompt completion block for runtime execution prompts
- Updated built-in executor and senior-engineer prompt templates in @fusion/core to mirror the engine runtime instructions
- Added regression tests to verify the policy language is present in execution prompts
