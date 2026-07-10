# fusion-plugin-cursor-runtime

Cursor CLI-backed provider/runtime plugin for Fusion.

## Contract summary

- Provider ID: `cursor-cli`
- Binary probes: `cursor-agent`, then `cursor`
- Expected failure states: missing binary, missing Cursor IDE install, locked macOS keychain, unauthenticated runtime
- Model discovery: `cursor-agent models` (plain text `id - Label` output; no `--json` support) with header/tip/empty-state filtering, dedupe, and fallback metadata
- Auth status: `cursor-agent status --format json` (`isAuthenticated`), probed against the same candidate binary that succeeded `--version`

## Notes

Status/auth and model discovery behavior follows `docs/cursor-cli-contract.md`.
