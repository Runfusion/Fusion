# fusion-plugin-grok-runtime

Grok CLI-backed provider/runtime plugin for Fusion.

## Install

This plugin ships bundled with Fusion and is auto-installed like the other
built-in runtime plugins. It shells out to an **operator-installed** `grok`
binary on PATH — Fusion never downloads or bundles the CLI itself.

- Canonical upstream repo: https://github.com/superagent-ai/grok-cli
- Docs / homepage: https://github.com/superagent-ai/grok-cli#readme
- Install script: https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh
- npm alternative: `bun add -g grok-dev` (see https://github.com/superagent-ai/grok-cli/releases)
- Binary name: `grok`
- This is a community-built project, not affiliated with xAI. No fixed
  release artifact is bundled by Fusion, so no checksum is pinned
  (`upstream-pending-verification`).

## Contract summary

- Provider ID: `grok-cli`
- Binary probe: `grok --version`
- **Auth model — API key, not OAuth/session.** Grok has no `status`/`whoami`
  subcommand. Authentication is derived from key PRESENCE only:
  1. `GROK_API_KEY` environment variable, or
  2. `~/.grok/user-settings.json` → `{ "apiKey": "..." }`
  Base URL defaults to `https://api.x.ai/v1`. A missing/unreadable/malformed
  key configuration fails closed to `authenticated: false` with an
  actionable reason — never throws.
- Model discovery: `grok models` (plain-text output, with pricing hints per
  the upstream README). The exact line shape is
  `upstream-pending-verification`, so discovery parses conservatively: the
  leading token before a ` - ` label separator, or before the first
  multi-space pricing column, is treated as the model id; ids are
  deduplicated. Output that happens to be JSON is tolerated defensively even
  though the CLI is not known to emit it.

## Enable via Settings → Authentication

1. Install the `grok` CLI and set `GROK_API_KEY` (or populate
   `~/.grok/user-settings.json`).
2. Open Settings → Authentication in the Fusion dashboard.
3. The "Grok — via Grok CLI" card shows probe status (binary found, API key
   present). Click **Enable** once the binary is available.
4. Discovered Grok models (via `grok models`) then merge into the model
   picker under the `grok-cli` provider id.

## Notes

Do not invent a `grok status`/`whoami` JSON auth contract — Grok is
API-key auth. See `AGENTS.md`'s "External-integration evidence" policy for
why the release/checksum fields above stay at
`upstream-pending-verification`.
