# Grok CLI Contract (FN-7722)

Date: 2026-07-09

<!--
FNXC:GrokCli 2026-07-09-00:00:
FN-7715 shipped GrokRuntimeAdapter.promptWithFallback as an intentional no-op,
justified by an FNXC comment asserting "no documented non-interactive
prompt/stream subcommand" for the `grok` CLI. FN-7722 (this doc) corrects that
assumption: upstream grok-cli DOES document and implement a non-interactive
`grok --prompt <text> --format json` NDJSON event stream
(src/headless/output.ts's `createHeadlessJsonlEmitter`), and this task lands a
real streaming GrokRuntimeAdapter against that verified contract. See
"Decision" below.
-->

## Research method

- `fn_web_fetch` against the canonical upstream repository
  (https://github.com/superagent-ai/grok-cli), specifically:
  - `README.md` (headless-mode overview, feature summary).
  - `src/index.ts` (commander CLI argument parsing — the exact flag
    spellings and headless dispatch).
  - `src/headless/output.ts` (the actual NDJSON event emitter — the
    authoritative schema source, not just docs prose).
  - `src/headless/output.test.ts` (fixture-level confirmation of the emitted
    JSONL shapes, used as ground truth for this plugin's own fixture tests).
- No live `grok` binary was invoked; no field name or flag spelling in this
  document is guessed — every claim below traces to one of the four files
  above. Raw captured research (queries + verbatim schema) is preserved as
  this task's `research` task document (`fn_task_document_read` key
  `research` on FN-7722).

## Confirmed non-interactive invocation

```bash
grok --prompt "<text>" --format json
# short flags:
grok -p "<text>" --format json
```

- `-p, --prompt <prompt>` — run a single prompt headlessly, then exit.
- `--format <format>` — headless output format, `text` (default) or `json`;
  invalid values are rejected by commander's `InvalidArgumentError`
  (`parseHeadlessOutputFormat`/`isHeadlessOutputFormat` in `src/index.ts`).
- Useful companion flags confirmed in the same `program.option(...)` chain:
  `-d, --directory <dir>` (cwd), `-m, --model <model>`, `-s, --session <id>`
  (resume a saved session, or `latest`), `-k, --api-key <key>` (inline key).
- `--format json` output is **newline-delimited JSON (NDJSON/JSONL)** — one
  JSON object per line — not a single JSON document. This is directly
  confirmed by `createHeadlessJsonlEmitter()`'s `jsonLine()` helper in
  `src/headless/output.ts`, which appends `\n` after each `JSON.stringify`.

## Verified NDJSON event schema (verbatim)

Source: `HeadlessJsonEvent` union type in `src/headless/output.ts`.

```ts
type HeadlessJsonEvent =
  | { type: "step_start"; sessionID?: string; stepNumber: number; timestamp: number }
  | { type: "text"; sessionID?: string; stepNumber: number; text: string; timestamp: number }
  | {
      type: "tool_use";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      toolCall: ToolCall;
      toolResult: ToolResult;
      timing?: { startedAt?: number; finishedAt?: number; durationMs?: number };
    }
  | {
      type: "step_finish";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      finishReason: string;
      usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsdTicks?: number };
    }
  | { type: "error"; sessionID?: string; message: string; timestamp: number };
```

Notes:

- `sessionID` appears on every event type when a session id is available
  (`agent.getSessionId()`); it is simply absent from the JSON object
  otherwise (not `null`).
- `text` events are per-step, buffered assistant content — one `text` event
  per step carrying the accumulated text for that step, flushed either right
  before a tool-triggering `step_finish` or inline with a tool-less
  `step_finish`.
- **No `thinking`/`reasoning` NDJSON event exists.** The underlying
  `StreamChunk` union used internally does carry a `"reasoning"` chunk type,
  but `createHeadlessJsonlEmitter().consumeChunk()` explicitly no-ops on it
  (`case "reasoning": break;` in `src/headless/output.ts`) — reasoning
  content is never surfaced through `--format json`. This is a **confirmed
  absence**, not `upstream-pending-verification`: the Grok streaming adapter
  therefore drives `onText` only; there is no `onThinking` signal to bridge
  for this CLI path today.
- There is **no explicit terminal `done`/`result` event type**. A prompt run
  can contain multiple `step_start`/`step_finish` pairs (multi-round tool
  use); the authoritative "the run is over" signal is the headless process's
  stdout stream ending (readline `close`) / subprocess exit, mirroring how
  the Droid CLI adapter treats subprocess `close` as terminal. `error` events
  (`{ type: "error", message, timestamp }`) can also appear inline without
  necessarily ending the process.
- A **fatal, pre-JSON failure** (e.g. missing API key) is not a JSON line at
  all: `src/index.ts`'s `requireApiKey()` writes a plain `console.error(...)`
  line to stderr and calls `process.exit(1)` before any NDJSON is emitted.
  Consumers must therefore also treat a non-zero exit with no JSON output as
  a distinct failure mode from a well-formed `error` event.

## Auth / readiness

- **The `grok` CLI owns authentication end-to-end for CLI-routed execution.**
  `runHeadless()` in `src/index.ts` is only reached via
  `requireApiKey(config.apiKey)`, which resolves the key from (in order via
  `resolveConfig`/`getApiKey()`): `-k/--api-key` flag, `GROK_API_KEY` env var,
  project `.env`, or `~/.grok/user-settings.json`'s `apiKey` field. If none
  resolve, the CLI itself exits 1 with an actionable error — Fusion does not
  need to pass, see, or validate a key for this path to work, as long as the
  operator's `grok` install already has one configured by any of those
  methods.
- **Auth implication for this task:** because CLI-routed model selections let
  the `grok` binary own both auth and inference, the direct-endpoint
  `GROK_API_KEY` Fusion-visibility requirement established by FN-7711
  (built-in `xai`/`openai-completions` provider) and FN-7714 (hydrating
  `GROK_API_KEY` from `~/.grok/user-settings.json` when the env var is unset)
  becomes **unnecessary for CLI-routed selections specifically**. It remains
  necessary and unchanged for the direct xAI OpenAI-compatible path, which
  stays the default (see "What stays unchanged" below).
- This mirrors FN-7716's separate finding that Grok CLI *readiness* (probe/
  auth-status surfacing) does not require Fusion to see a key either — that
  surface (`probe.ts`, `register-auth-routes.ts`,
  `GrokCliProviderCard.tsx`) is out of scope for this task and is not
  modified here.

## Wiring (resolved — FN-7725, extended by FN-7753)

<!--
FNXC:GrokCli 2026-07-09-00:00:
FN-7725 requirement: close the wiring gap below by making GrokRuntimeAdapter
reachable through a real, exercised, additive/opt-in path, decision-first
between option (a) formalizing the agent Runtime-mode hint path vs option (b)
a new "prefer CLI runtime" settings toggle deriving the hint from a
grok-cli/* model selection. Decision: option (a). Direct xAI endpoint stays
default and unchanged.
-->

**Decision: option (a) — formalize, document, and test the existing agent
Runtime-mode picker path. Do NOT add a new settings toggle (option (b)).**
FN-7753 later closed the deferred no-key model-selection fallback without adding
that rejected UI toggle: the session seam derives the same runtime hint
automatically only when the direct endpoint cannot work because no Fusion-visible
GROK_API_KEY resolves.

**Explicit trigger:** an agent's `runtimeConfig.runtimeHint === "grok"`, set today
via the dashboard's agent **Runtime Source → Runtime** picker
(`NewAgentDialog.tsx` / `AgentDetailView.tsx`), which is populated from
`GET /api/plugins/runtimes` (already generic — surfaces every registered
plugin runtime, including the bundled Grok Runtime plugin's `runtimeId:
"grok"`, with no Grok-specific code required).

**Automatic no-key fallback (FN-7753):** when `createResolvedAgentSession()` sees
all of the following, it derives the same effective `runtimeHint: "grok"` before
calling `resolveRuntime()`:

1. no explicit runtime hint was supplied (explicit hints, including `"pi"`,
   always win);
2. the resolved execution provider is `grok-cli`;
3. Fusion cannot see a non-empty `GROK_API_KEY` either in the environment or in
   `~/.grok/user-settings.json`'s `apiKey` field; and
4. the bundled Grok Runtime plugin has registered runtime id `"grok"`.

If a Fusion-visible key exists, the direct xAI OpenAI-compatible endpoint remains
the default. If the Grok runtime is not registered, Fusion leaves the session on
the existing PI/direct path rather than inventing a separate routing mode.

**Exact seam:** `packages/engine/src/agent-session-helpers.ts`'s
`extractRuntimeHint(runtimeConfig)` reads that hint from the assigned agent's
`runtimeConfig` and threads it, as `runtimeHint`, into
`packages/engine/src/runtime-resolution.ts`'s `resolveRuntime()` — which is
totally runtime-agnostic: when the hint matches a registered plugin
`runtimeId`, `resolvePluginRuntime()` calls that plugin's `runtime.factory`
(the Grok plugin's factory returns `new GrokRuntimeAdapter()`,
`plugins/fusion-plugin-grok-runtime/src/index.ts`) and the resolved adapter
becomes the session's runtime. This same generic chain already carries
`"hermes"` and `"droid"` runtime hints end-to-end (see
`hermes-runtime-integration.test.ts`, `droid-runtime-e2e.test.ts`) — Grok's
plugin registration alone was sufficient for the chain to reach it; **no
engine or dashboard code changed for this task**, because the generic
Runtime-mode picker → `extractRuntimeHint` → `resolveRuntime` →
`resolvePluginRuntime` → plugin `factory` chain was already correct and
exercised for other plugin runtimes. FN-7725 formalizes this as the *decided*
Grok wiring, adds `packages/engine/src/__tests__/grok-runtime-routing.test.ts`
proving the chain specifically resolves `GrokRuntimeAdapter` (id `"grok"`)
and drives its `onText` streaming seam via a faked spawn (see
`runtime-adapter.ts`'s injectable `spawn` option; no live `grok` binary), and
records the decision here plus in `plugins/fusion-plugin-grok-runtime/README.md`.

**Why option (a), not (b):** option (b) (an opt-in "prefer CLI runtime"
setting deriving `runtimeHint: "grok"` from a `grok-cli/*` model selection)
would add a new `Settings` field, defaulting/resolution logic, and a
SettingsModal UI toggle (desktop + mobile) — net-new surface area for a path
that, on inspection, was **already fully wired generically** by the existing
Runtime-mode picker. Per the Decision guidance's preference for "the smaller,
additive change," formalizing + testing + documenting the already-working
path is lower risk and closes the actual gap (an *exercised* path, not just
an implemented adapter) without adding new user-facing config surface.

**Model plumbing (FN-7753):** for the automatic no-key fallback, the selected
`grok-cli/*` model id is preserved through `AgentRuntimeOptions.defaultModelId`,
normalized by stripping a leading `grok-cli/` (or `grok/`) prefix, and passed to
the CLI as `grok --model <id>` alongside `--prompt` and `--format json`.
Runtime-mode remains model-agnostic when chosen explicitly from the dashboard;
that no-model path still uses the adapter's historical `"grok/default"` session
fallback and omits `--model`.

**Why the direct xAI endpoint stays default:** a `grok-cli/*` **model** selection
continues to route through the direct xAI OpenAI-compatible endpoint
(FN-7711/FN-7714, `packages/core/src/grok-provider.ts`, `packages/engine/src/pi.ts`)
whenever Fusion can see a key. FN-7753 changes only the failing no-visible-key
case, where the direct path would otherwise hard-fail even though the installed
CLI may be authenticated by a source Fusion cannot inspect (project `.env`,
`grok -k`, OAuth/login token store, sandbox secrets, etc.).

## Decision

**Route Grok execution through the CLI: YES, as a scoped, additive
`GrokRuntimeAdapter` implementation.**

Rationale:

- The non-interactive contract is fully pinned to primary source code
  (`src/index.ts` CLI parsing + `src/headless/output.ts` emitter +
  `src/headless/output.test.ts` fixtures), not just README prose — this
  clears the External Integration Evidence bar and the "testable from
  fixture lines without a live binary" bar from the task mission — the
  parser can be fixture-tested exactly like the Droid plugin's
  `stream-parser.ts`, with no live-binary dependency in tests.
- The event schema is simple (`step_start` / `text` / `tool_use` /
  `step_finish` / `error`) and text-only for this scoped adapter (no
  `thinking` event exists to bridge), so the implementation stays narrow: a
  resilient NDJSON line parser plus an `onText` bridge, deliberately leaving
  tool-call/break-early bridging as a documented follow-up (the Droid
  adapter's much larger `provider.ts` is the effort ceiling, not the target
  shape).
- It is fully reversible: the adapter is reachable via either an explicit
  `runtimeHint === "grok"` or FN-7753's narrow no-visible-key `grok-cli`
  fallback. The direct endpoint remains the key-visible default.

## What stays unchanged

- The **direct xAI OpenAI-compatible streaming path** (base URL
  `https://api.x.ai/v1`, api type `openai-completions`, `GROK_API_KEY`
  sourced per FN-7711/FN-7714) remains the default when a Fusion-visible key
  exists. FN-7753 adds a read-only key-visibility check in
  `packages/core/src/grok-provider.ts` and derives CLI routing only when no
  such key is visible and the Grok runtime is registered.
- FN-7716's probe/auth-readiness surface (`probe.ts`,
  `register-auth-routes.ts`, `GrokCliProviderCard.tsx`) is untouched by this
  task.
- End-to-end routing was out of scope for FN-7722 and is resolved by
  FN-7725 (see "Wiring" above): decision option (a), formalizing the
  existing agent Runtime-mode picker path. No settings toggle was added.

## Follow-ups filed from this task

See the task's `fn_task_create` calls (linked from FN-7722) for:

1. ~~End-to-end routing wiring~~ — **closed by FN-7725** (see "Wiring"
   above): the agent Runtime-mode picker path was formalized, documented,
   and covered by `packages/engine/src/__tests__/grok-runtime-routing.test.ts`.
2. ~~Full tool-call bridging for `tool_use` NDJSON events~~ — **closed by
   FN-7724**: `GrokRuntimeAdapter` now bridges `tool_use` into
   `onToolStart`/`onToolEnd` (no Grok→pi tool-name mapping was added — the
   verified schema does not pin grok-cli's tool-name vocabulary, so
   names/args pass through unchanged). Break-early on `step_finish` was
   deliberately NOT adopted: this doc's own "Verified NDJSON event schema"
   notes above establish `step_finish` is a per-step boundary (a run can
   contain multiple `step_start`/`step_finish` pairs), not the run
   terminal — the adapter's terminal signal remains subprocess
   `close`/`error`, unchanged from FN-7722. See
   `plugins/fusion-plugin-grok-runtime/README.md`'s "Tool execution
   bridging (FN-7724)" section.
3. ~~Preserving a specific `grok-cli/*` model selection when routing through
   the CLI runtime~~ — **closed by FN-7753** for the automatic no-visible-key
   fallback: `createResolvedAgentSession()` derives runtime hint `"grok"` only
   when no explicit hint is set, provider is `grok-cli`, no Fusion-visible
   `GROK_API_KEY`/user-settings `apiKey` resolves, and runtime id `"grok"` is
   registered; the selected model is passed to the CLI via `--model <id>`.
   Explicit Runtime-mode remains model-agnostic by design.
