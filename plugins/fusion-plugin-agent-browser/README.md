# fusion-plugin-agent-browser

First-party Fusion plugin that contributes:

- setup metadata/hooks for the `agent-browser` binary
- prompt contributions across executor/triage/reviewer/heartbeat surfaces
- agent-browser skills and workflow step templates
- optional browser helper tools

## Settings

- `enabled` (boolean, default `true`)
- `installChannel` (`stable|beta|nightly`, default `stable`)
- `commandTimeoutMs` (number, default `120000`)
- `headlessMode` (boolean, default `true`)
- `allowedDomains` (string array, default `[]`)
- `promptExecutorSystem` (string, default `"When browsing, summarize evidence with URLs."`)
- `promptExecutorTask` (string, default `"Use browser context only when needed for the task."`)
- `promptTriage` (string, default `"Mark tasks requiring browser evidence explicitly."`)
- `promptReviewer` (string, default `"Verify browser-derived claims are backed by cited pages."`)
- `promptHeartbeat` (string, default `"Keep browser interactions bounded and report failures clearly."`)
- `skillExposure` (`none|selected|all`, default `selected`)

## Setup hooks

`checkSetup()` probes `agent-browser --version` asynchronously with timeout handling and reports `installed`, `not-installed`, or `error` status via `PluginSetupCheckResult`.
