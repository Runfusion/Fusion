# Grok CLI Contract (FN-7790, updated by FN-7796)

Date: 2026-07-10

<!--
FNXC:GrokCli 2026-07-10-12:58:
FN-7796 supersedes FN-7790's streaming assumption. Operators run xAI's official Grok Build TUI (`grok 0.2.93`); its `--output-format streaming-json` path intermittently ends `stopReason:"Cancelled"` with zero `text` events, so Fusion's reliable headless prompt path invokes `grok -p <prompt> --output-format json` and parses the single `{text,stopReason,sessionId,requestId,thought}` object. A non-`EndTurn` stop reason with empty text is a concrete diagnostic, never a silent no-message response.
-->

## Ground truth

Fusion shells out to an **operator-installed** `grok` binary. The binary is not downloaded or bundled by Fusion, so the authoritative contract is the installed xAI CLI's own help/version output plus live execution on an authenticated machine.

External integration evidence:

- Canonical upstream: xAI official Grok CLI / Grok Build TUI, surfaced by the installed binary as `grok 0.2.93 (f00f96316d4b)`.
- Docs/homepage: https://grok.com/, https://docs.x.ai/, and `grok --help` / `grok agent --help` for exact flags.
- Release/download: operator-installed; Fusion resolves `grok` from PATH or `grokCliBinaryPath` and does not bundle a release artifact.
- Binary name: `grok`.
- Checksum: `upstream-pending-verification` because Fusion does not pin or download the operator's binary.

The previously documented https://github.com/superagent-ai/grok-cli contract is a different product that happens to use the same binary name. Its `grok --prompt <text> --format json` invocation is not accepted by xAI's CLI.

## Failures that shaped the contract

### Wrong-product flags (FN-7790)

The old adapter invocation fails against the real xAI binary:

```bash
grok --prompt "say hello" --format json
```

Observed result:

```text
exit 2
stdout: <empty>
stderr:
error: unexpected argument '--prompt' found

  tip: a similar argument exists: '--prompt-file'

Usage: grok --prompt-file <PATH> [PROMPT]
```

Because no renderable assistant text is produced, Fusion surfaced a blank/no-message assistant response.

### Streaming JSON cancellation with zero text (FN-7796)

FN-7790 correctly switched to xAI's real flags and streaming event union, but live triage found `--output-format streaming-json` is intermittently unreliable. The same authenticated `grok 0.2.93` binary sometimes emits only reasoning events, then ends with `stopReason:"Cancelled"` and no `text` event while still exiting 0 with empty stderr.

Live-captured shape:

```jsonl
{"type":"thought","data":"..."}
{"type":"thought","data":"..."}
{"type":"end","stopReason":"Cancelled","sessionId":"...","requestId":"..."}
```

The adapter previously saw parsed events and a successful close, accumulated empty assistant text, set no error, and produced a silent no-message bubble. The reliable replacement is the single-object JSON contract below.

## Confirmed non-interactive invocation used by Fusion

Use xAI Grok Build TUI's single-turn prompt mode with **single-object JSON**:

```bash
grok -p "<text>" --output-format json
# equivalent long prompt flag:
grok --single "<text>" --output-format json
```

Supported companion flags used by Fusion:

- `-p, --single <PROMPT>` — run a single prompt, print the response, and exit. This does not require interactive stdin.
- `--output-format <plain|json|streaming-json>` — Fusion uses `json` for reliable headless prompts.
- `-m, --model <MODEL>` — optional concrete model id. Fusion omits this for the model-less `grok/default` Runtime-mode path.
- `--cwd <CWD>` — optional working directory. This replaces the wrong-product `--directory` flag.

Other observed flags include `--prompt-file <PATH>`, `--prompt-json <JSON>`, `-s/--session-id <UUID>`, `--sandbox <PROFILE>`, `--system-prompt-override <PROMPT>`, and `--max-turns <N>`, but Fusion's adapter does not currently use them.

## Reliable JSON response schema

`--output-format json` emits one final JSON object rather than an NDJSON stream. Observed shape:

```ts
interface GrokJsonResponse {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  thought?: string;
}
```

Example:

```json
{
  "text": "Hello",
  "stopReason": "EndTurn",
  "sessionId": "019f4d81-8fb1-7f11-98ca-5ae00654b518",
  "requestId": "bb7952e2-f1bc-4574-b409-5cc568817fe5",
  "thought": "The user wants me to say hello in one word..."
}
```

Mapping in Fusion:

- `thought` → `onThinking(thought)` when non-empty.
- `text` → `onText(text)` and accumulated assistant content when non-empty.
- `sessionId` → `session.sessionId` when present.
- subprocess `close` remains the authoritative promise resolution point because it carries exit status/stderr diagnostics.

Live reliability evidence from FN-7796: `grok -p "say hello in one word" --output-format json` returned real text with `stopReason:"EndTurn"` on 4/4 direct runs, and the built `GrokRuntimeAdapter` carried real text through `onText`/persisted assistant content on 3/3 end-to-end runs against the real binary.

## Streaming JSON event schema (not the primary prompt path)

`--output-format streaming-json` emits one JSON object per line:

```ts
type GrokStreamingJsonEvent =
  | { type: "thought"; data: string }
  | { type: "text"; data: string }
  | { type: "end"; stopReason?: string; sessionId?: string; requestId?: string };
```

Successful captured tail:

```jsonl
{"type":"thought","data":" one"}
{"type":"thought","data":"-"}
{"type":"thought","data":"word"}
{"type":"thought","data":" greeting"}
{"type":"thought","data":"."}
{"type":"text","data":"Hello"}
{"type":"text","data":"!"}
{"type":"end","stopReason":"EndTurn","sessionId":"019f4d1e-2582-70e0-a174-c8774782ab01","requestId":"2233f1dc-e9ad-4ae4-8221-caa6afade07f"}
```

Fusion does not use streaming-json as the primary headless prompt path because it intermittently produces the cancelled/no-text shape documented above. Parser support remains only to keep diagnostics and regression tests concrete if captured streaming output appears in buffered stdout.

## Other output formats

`--output-format plain` prints renderable response text, but does not expose `sessionId`, `requestId`, `stopReason`, or `thought`.

## Model discovery

`grok models` is plain text, not JSON. Observed shape:

```text
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
```

Fusion parses the bullet list conservatively and exposes ids under provider `grok-cli` when the `useGrokCli` toggle is enabled.

## Auth and readiness

The CLI owns authentication for CLI-routed execution. Fusion's readiness probe uses `grok --version`; a passing probe proves only that a compatible-looking binary exists, not that the prompt path is authenticated or serviceable. The prompt path is proven by a real `grok -p ... --output-format json` run.

Fusion-visible `GROK_API_KEY` remains relevant for the direct xAI OpenAI-compatible endpoint. For CLI-routed sessions, Fusion does not need to see a key as long as the operator-installed CLI is authenticated by its own supported mechanism.

## Runtime routing

The Grok runtime adapter is reached when:

1. an agent explicitly sets `runtimeConfig.runtimeHint === "grok"`; or
2. the FN-7753/FN-7758 no-visible-key fallback derives the same runtime hint for a `grok-cli/*` default/fallback provider selection and the bundled Grok Runtime plugin is registered.

The selected `grok-cli/<id>` or `grok/<id>` model is normalized to `<id>` and passed to the CLI as `-m <id>`. The explicit no-model Runtime-mode path keeps `grok/default` and omits `-m`.

## Diagnostics and empty-output invariant

The adapter preserves the resolve-never-reject runtime contract while surfacing concrete diagnostics:

- spawn failure → `session.state.errorMessage` and diagnostic `onText`.
- non-zero subprocess close with no text → stderr/exit diagnostic.
- code-0 close with no parseable JSON response → wrong-binary/interactive-EOF diagnostic.
- parseable response with no text and `stopReason !== "EndTurn"` → stop-reason diagnostic, e.g. `Grok CLI ended with stopReason Cancelled and produced no assistant text.`
- parseable `EndTurn` response with no assistant text → legitimate silent response, not a diagnostic.
- text emitted before a noisy/non-zero close → keep the assistant text and avoid replacing it with an error.

This invariant prevents the original blank/no-message symptom while still allowing genuinely empty model turns.
