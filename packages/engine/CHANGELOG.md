# @fusion/engine

## 0.7.0

### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0
  - @fusion/pi-claude-cli@0.7.0

## 0.6.0

### Patch Changes

- @fusion/core@0.6.0
- @fusion/pi-claude-cli@0.6.0

## 0.5.0

### Patch Changes

- @fusion/core@0.5.0
- @fusion/pi-claude-cli@0.5.0

## 0.4.1

### Patch Changes

- @fusion/core@0.4.1
- @fusion/pi-claude-cli@0.4.1

## 0.4.0

### Patch Changes

- @fusion/core@0.4.0
- @fusion/pi-claude-cli@0.4.0

## 0.2.7

### Patch Changes

- @fusion/core@0.2.7

## 0.2.6

### Patch Changes

- @fusion/core@0.2.6
