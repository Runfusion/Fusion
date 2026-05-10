# @fusion/droid-cli

Compatibility-shim package for Fusion's Droid integration extension entrypoint.

Runtime/provider internals live in:
- `@fusion-plugin-examples/droid-runtime` (`plugins/fusion-plugin-droid-runtime`)

This package preserves the historical pi extension entrypoint and wires runtime helpers into the real extension surface (`registerProvider`, `session_start` tool activation, model discovery, and MCP handoff) so existing imports continue to work.

## Testing boundary

- `packages/droid-cli/src/__tests__/index.test.ts` owns integration coverage for this shim entrypoint (`index.ts`) and verifies provider registration and wiring behavior.
- Runtime internals (`streamViaCli`, CLI process handling, MCP schema generation, parsing, etc.) remain covered in the plugin package tests under `plugins/fusion-plugin-droid-runtime`.
