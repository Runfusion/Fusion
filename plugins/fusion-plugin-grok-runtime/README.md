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
- **Auth model — the `grok` CLI owns its own authentication; Fusion does
  not require a Fusion-visible API key to enable/use it (FN-7716).** Grok
  has no `status`/`whoami` subcommand, so Fusion probes binary availability
  only and treats a working binary as "ready" (`authenticated: true`). The
  CLI itself resolves credentials from more sources than Fusion can see
  (`GROK_API_KEY` env var, a project `.env`, `grok -k <key>`,
  `GROK_BASE_URL`, sandbox secrets, etc.). Fusion additionally probes two of
  those locations — the `GROK_API_KEY` env var and
  `~/.grok/user-settings.json` → `{ "apiKey": "..." }` — purely as a
  **non-blocking informational hint** (`apiKeyDetected`); it never gates
  Enable or the authenticated state, and a missing/unreadable/malformed
  settings file degrades gracefully (never throws). The direct xAI
  OpenAI-compatible streaming path (base URL `https://api.x.ai/v1`) still
  uses `$GROK_API_KEY` when present, independent of the CLI provider.
- Model discovery: `grok models` (plain-text output, with pricing hints per
  the upstream README). The exact line shape is
  `upstream-pending-verification`, so discovery parses conservatively: the
  leading token before a ` - ` label separator, or before the first
  multi-space pricing column, is treated as the model id; ids are
  deduplicated. Output that happens to be JSON is tolerated defensively even
  though the CLI is not known to emit it.

## CLI streaming execution path (FN-7722)

In addition to model discovery/probe, this plugin's `GrokRuntimeAdapter` can
stream a real Grok response through the CLI itself:

```bash
grok --prompt "<text>" --format json
```

- `--format json` emits newline-delimited JSON (NDJSON) — one JSON object
  per line — with event types `step_start`, `text`, `tool_use`,
  `step_finish`, and `error` (verified against upstream source, not just
  docs prose; see `docs/grok-cli-contract.md`).
- The adapter parses that stream (`src/stream-parser.ts`) and drives
  `onText` as `text` events arrive. There is no `thinking`/`reasoning` event
  in the verified schema, so `onThinking` is never invoked for this path.
- **Tool execution bridging (FN-7724):** each verified `tool_use` event
  (`toolCall`/`toolResult`/`timing`) additionally drives `onToolStart(toolName,
  args)` / `onToolEnd(toolName, isError, result)`, mirroring the Droid
  plugin's `DroidCallbacks` shape. `toolName`/`args` are
  `toolCall.function.name` / parsed `toolCall.function.arguments`;
  `isError` derives from `toolResult.success === false`. No Grok→pi
  tool-name/arg translation is applied — the verified contract does not pin
  grok-cli's specific tool-name vocabulary (unlike Droid's Claude-shaped
  names), so names/args pass through unchanged. `step_finish` is a per-step
  boundary (a run can contain multiple), not the run terminal, so it does
  not finalize the adapter's promise; only subprocess `close`/`error` does,
  unchanged from FN-7722.
- **Auth implication:** because the `grok` binary resolves its own
  credentials for this path (env var, project `.env`, `grok -k`, or
  `~/.grok/user-settings.json`), a CLI-routed selection needs **no
  Fusion-visible `GROK_API_KEY`** — unlike the direct xAI
  OpenAI-compatible streaming path (`https://api.x.ai/v1`), which still
  requires one. When Fusion auto-routes a no-key `grok-cli/*` model selection
  through this adapter (FN-7753), the selected model id is passed to the CLI
  with `--model <id>`.
- This adapter is reached either when an agent explicitly sets
  `runtimeConfig.runtimeHint === "grok"` or when FN-7753's no-visible-key
  `grok-cli/*` fallback derives that hint automatically. See "Routing Grok
  through the CLI runtime (FN-7725 / FN-7753)" below and
  `docs/grok-cli-contract.md` for the full contract and decision record.

## Routing Grok through the CLI runtime (FN-7725 / FN-7753)

By default, selecting a `grok-cli/*` **model** for an agent/task routes through
the **direct xAI OpenAI-compatible endpoint** (`https://api.x.ai/v1`,
FN-7711/FN-7714) whenever Fusion can see a `GROK_API_KEY` (environment or
`~/.grok/user-settings.json` `apiKey`). If no Fusion-visible key resolves and
the Grok Runtime plugin is registered, Fusion automatically routes that session
through the `grok` CLI runtime instead, letting the CLI own auth end-to-end.

To route a specific agent's execution through the `grok` CLI's own
non-interactive streaming mode (`grok --prompt --format json`) instead:

1. Open the agent in the dashboard (**New Agent** or an existing agent's
   detail view).
2. Under **Runtime Source**, choose **Runtime** instead of **Built-in
   Model**.
3. Select **Grok Runtime** from the runtime dropdown (sourced from
   `GET /api/plugins/runtimes`, which lists every installed plugin runtime
   including this one).
4. Save. The agent's `runtimeConfig.runtimeHint` is now `"grok"`; every
   session that agent drives (as an assigned executor, column agent, or
   child agent) resolves through `packages/engine/src/runtime-resolution.ts`
   to this plugin's `GrokRuntimeAdapter` instead of the default pi runtime.

**Automatic fallback precedence (FN-7753):** explicit runtime hint >
Fusion-visible key/direct endpoint > automatic CLI fallback. The fallback is
only derived when no explicit runtime hint is set, the provider is `grok-cli`,
no Fusion-visible key resolves, and runtime id `"grok"` is registered. The
selected model is normalized from `grok-cli/<id>` (or `grok/<id>`) to `<id>`
and sent as `--model <id>`.

**Known limitation:** explicit Runtime-mode is still model-agnostic — it does
not carry a specific `grok-cli/*` model id through to the adapter, so
`GrokRuntimeAdapter.createSession()` falls back to `"grok/default"` and omits
`--model`. Built-in Model selections preserve the model either through the
direct endpoint (when a key is visible) or through the FN-7753 automatic CLI
fallback (when no key is visible).

## Enable via Settings → Authentication

1. Install the `grok` CLI and authenticate it by any method it supports
   (env var, project `.env`, `grok -k`, etc.) — Fusion does not need to see
   the key.
2. Open Settings → Authentication in the Fusion dashboard.
3. The "Grok — via Grok CLI" card shows probe status. Click **Enable** once
   the binary is available; a non-blocking hint appears only if Fusion did
   not detect a key, noting the direct xAI streaming path uses
   `GROK_API_KEY` when present.
4. Discovered Grok models (via `grok models`) then merge into the model
   picker under the `grok-cli` provider id.

## Notes

Do not invent a `grok status`/`whoami` JSON auth contract — readiness is
derived from binary availability, mirroring the Cursor CLI provider. See
`AGENTS.md`'s "External-integration evidence" policy for why the
release/checksum fields above stay at `upstream-pending-verification`.
