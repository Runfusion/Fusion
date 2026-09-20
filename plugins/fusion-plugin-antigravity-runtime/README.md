# Google Antigravity runtime

This bundled Fusion runtime drives an operator-installed `agy` binary through its non-ACP NDJSON print mode. It never downloads the binary or reads its credentials.

When approved Fusion tools are requested, the runtime stages one unique `fusion-custom-tools-*` entry with the documented `agy mcp` commands. The entry is journaled outside project worktrees and removed on disposal; uncertain MCP state disables tools and preserves the operator configuration.
