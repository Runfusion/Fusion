# Claude Runtime Plugin

`fusion-plugin-claude-runtime` exposes Claude Code as Fusion runtime `claude` and CLI provider `claude-cli`. It communicates through Agent Client Protocol (ACP), preserving streaming updates, tool calls, and multi-turn sessions.

The plugin uses the pinned `claude-code-cli-acp` bridge (`0.1.1`). CLI packaging stages its reviewed launcher beside the bundled plugin, while the published `@runfusion/fusion` dependency installs the matching optional native bridge for the operator's OS and CPU. The runtime never falls back to a same-named executable on `PATH`.

This is additive to Fusion's experimental `pi-claude-cli` Route A. Route A remains available; selecting the `claude` runtime explicitly selects this first-class ACP transport.
