# ACP Runtime Plugin Notes

## External Integration Evidence

`claude-code-cli-acp` is a bundled third-party bridge used by the Claude Route-B ask path.

- Canonical upstream repo URL: https://github.com/moabualruz/claude-code-cli-acp
- Docs / homepage URL: https://github.com/moabualruz/claude-code-cli-acp#readme
- Release / download URL: npm package `claude-code-cli-acp` (version `0.1.1`) — https://www.npmjs.com/package/claude-code-cli-acp
- Binary / CLI name: `claude-code-cli-acp`
- Checksum: `sha512-qpfRGOXkOs9mqI7oumsGistWisyXcCC0r7ng7wdLvGMIORdzHjmUUa+94Jftgr/NYAVnAUe6N7kimD8PaO3D5g==` (from `pnpm-lock.yaml` for `claude-code-cli-acp@0.1.1`)
- Pinned-commit spot-review: tag `v0.1.1` points to commit `c93f4f4ca449f451d9f3b7db536caf4060883da9` (annotated tag `ca33404fc1128d6a88a55b248f042f70b4bc9f9a`, unsigned). License Apache-2.0; reviewed behavior is that the bridge runs `claude` through a PTY, reads transcript JSONL, exposes an ACP server over stdio, and requires `@anthropic-ai/claude-code` installed + authenticated.

Do not replace this with a PATH-resolved binary for the bundled Claude profile; tests and setup should reject substitutes outside the plugin-owned `node_modules` tree.
