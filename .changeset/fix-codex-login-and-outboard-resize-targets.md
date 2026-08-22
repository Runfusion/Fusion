---
"@runfusion/fusion": patch
---

summary: Fix OpenAI Codex login never opening a browser window, and document OAuth callback ports for Docker.
category: fix
dev: pi's `AuthPrompt` is a discriminated union (text/secret/select/manual_code); `FusionAuthStorage.login`'s interaction shim flattened all four into `onPrompt`, so Codex's opening `select` ("Browser" vs "Device code") was answered with the pasted-code wait and hung until the route's 30s kickoff timeout. The shim now dispatches by type, reviving the route's existing `onSelect`/`onManualCodeInput` handlers. Separately, FN-8766's outboard east/NE/SE resize targets are promoted from Task Detail to every desktop FloatingWindow now that FN-8015's body gutter is gone, with body-level `border-radius: inherit` replacing host clipping and phones re-asserting `overflow: hidden`.
