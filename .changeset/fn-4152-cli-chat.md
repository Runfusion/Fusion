---
"@runfusion/fusion": minor
---

Add `fn chat [agent-id]` for interactive multi-turn chat with an agent from the CLI. Connects to a running `fn dashboard` / `fn serve` over its existing chat HTTP+SSE API and streams responses incrementally. Supports `--session <id>` to resume, `--url` / `--token` / `--no-auth` to target alternate servers, and stdin piping for scripted single-turn messages.
