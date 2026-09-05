---
"@runfusion/fusion": minor
---

summary: CLI chat sessions (claude and pi) now get per-turn project memory recall through each CLI's native channels.
category: feature
dev: Per-spawn launch-settings provider generates a scratch-dir Claude Code `UserPromptSubmit` hook (via `--settings`) or a pi `before_agent_start` extension (via `--extension`) for purpose=chat sessions only; the hook/extension POSTs the operator prompt to the new loopback `POST /api/cli-agent/memory-recall` route (same per-session TelemetryHub token auth as `/api/cli-agent/hooks`) and injects the RUFU-120 recall cue natively. Silent no-cue on any failure (202 empty), task sessions untouched, scratch dirs reclaimed on terminate/resume/boot sweep. The recall backend resolves against the project root (`createCliAgentRuntime` gains a `projectRoot` option, required with the recall endpoint — the `.fusion` dir would make recall a silent no-op). Also guards the for-test memory-recall router factory's `req.query` read (Express 5 leaves it undefined on a bare Router). This delivers the CLI path RUFU-120's changeset deferred ("intentionally untouched in v1").
