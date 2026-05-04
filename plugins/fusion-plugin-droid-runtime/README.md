# Droid Runtime Plugin

First-class Droid plugin package under `plugins/fusion-plugin-droid-runtime`.

## What this package is

- Canonical home for Droid runtime/provider plugin code.
- Installable from dashboard **Settings → Plugins → Fusion Plugins → Bundled Plugins** via path `./plugins/fusion-plugin-droid-runtime`.
- Plugin identity is stable: `fusion-plugin-droid-runtime`.

## Migration context

- FN-3261 established this package as the official landing zone so Droid plugin work does not need ad-hoc layouts.
- Runtime/provider logic that used to live in `packages/droid-cli` is now owned here; `@fusion/droid-cli` remains a compatibility shim surface where needed.

## Key IDs

- Runtime ID: `droid`
- Provider ID: `droid-cli`
