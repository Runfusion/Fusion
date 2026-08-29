# Upstream provenance

This package is a vendored fork of:

- **Upstream**: https://github.com/rchern/pi-claude-cli
- **Forked at version**: `0.3.1` (see `package.json`)
- **Forked on**: 2026-04-23

The original project is MIT-licensed; the full license text is preserved in
`LICENSE` alongside this file. All copyrights noted in the original source
are retained.

## Why a fork

`pi-claude-cli` is a load-bearing runtime extension for Fusion's "Route AI
through Claude CLI" feature. Vendoring lets us:

1. Bump its peer dependency on `@earendil-works/pi-coding-agent` in lockstep
   with Fusion's own version (upstream tracked `^0.52.0`; Fusion needs
   `^0.62.0`).
2. Fix bugs without waiting for upstream release cadence.
3. Wire the extension into the monorepo's build, typecheck, and test
   pipeline.
4. Ship it bundled with `@runfusion/fusion` so users don't have to
   `npm install -g pi-claude-cli` manually.

## Syncing from upstream

This is a soft fork — we do not track upstream automatically. When upstream
releases a change worth adopting:

1. `git diff` the upstream ref against this directory.
2. Hand-apply the relevant parts (most of our modifications are localized to
   `package.json` — peer-dep pins, package name scoping).
3. Update "Forked at version" above.

There is no `git subtree` relationship — upstream's git history is not
preserved here. Attribution is via this file plus the retained `LICENSE`.
