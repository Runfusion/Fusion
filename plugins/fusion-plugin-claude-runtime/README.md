# Claude Runtime Plugin

`fusion-plugin-claude-runtime` exposes Claude Code as Fusion runtime `claude` and CLI provider `claude-cli`. It communicates through Agent Client Protocol (ACP), preserving streaming updates, tool calls, and multi-turn sessions.

The plugin uses the pinned `claude-code-cli-acp` bridge (`0.1.1`). CLI packaging stages its reviewed launcher beside the bundled plugin, while the published `@runfusion/fusion` dependency installs the matching optional native bridge for the operator's OS and CPU. The runtime never falls back to a same-named executable on `PATH`.

This is additive to Fusion's experimental `pi-claude-cli` Route A. Route A remains available; selecting the `claude` runtime explicitly selects this first-class ACP transport.

## Fusion custom-tools bridge

The `fusion-custom-tools` MCP server launches `mcp-schema-server.cjs` beside the loaded bridge module. It is kept beside `src/` for source loading and copied beside `dist/` by `pnpm build`; do not remove that postbuild copy or dist-loaded sessions will fail initialize with `handshake failed: connection closed: initialize response`.

When requested Fusion tools cannot start their bridge, the adapter emits `FUSION_TOOL_BRIDGE_FAILED: mcp-schema-server-missing` or `FUSION_TOOL_BRIDGE_FAILED: bridge-start-failed`, omits the unusable MCP entry, and the engine stores only the fixed outcome and tool count in `session:runtime-resolved` run audit metadata.
