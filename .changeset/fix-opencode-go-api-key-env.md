---
"@runfusion/fusion": patch
---

Fix opencode-go model sync: pass API key to CLI and strip provider prefix from model IDs

Two bugs when using OpenCode Go as a provider:

1. **Model discovery only returned free models** — the saved Go API key was never passed as `OPENCODE_API_KEY` to the spawned `opencode models opencode --refresh` process. The CLI's internal plugin checks this env var and, when absent, disables all paid models (those with `cost.input > 0`). Only 20 free models appeared instead of all 67.

2. **API requests failed with 401** — `normalizeOpencodeGoModel` was registering models with prefixed IDs like `opencode-go/deepseek-v4-flash`. The Pi SDK sends `model.id` verbatim in API requests; the OpenCode API expects bare model names (e.g. `deepseek-v4-flash`). The prefix is now stripped during normalization.

Also deduplicates models when the CLI emits both `opencode/foo` and `opencode-go/foo` for the same model, guards against empty model IDs, and refactors the duplicated `onApiKeySaved` handler into a shared `handleOpencodeGoApiKeySaved` helper.

After this change, users must re-select their opencode-go model in Settings because model IDs have changed from prefixed to bare names.
