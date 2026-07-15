# Fusion changelog

User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.

## 0.60.0

### Highlights
- Fixed agents silently going stale for hours despite the heartbeat repair audit
- Bundled example plugins no longer fail to enable with a missing package error
- List view popups now match Board's movable task window
- Planning Mode auto-retries a stuck AI generation before erroring
- Merger AI model is now configurable under Global and Project Models

### New
- Open tasks as popups now applies to List clicks with the same movable task window as the Board
- Planning Mode now auto-retries a stuck AI generation up to 3 times before showing an error
- Add a Plan action to planning/ideas/hold task cards that opens Planning Mode from the card
- Make the merger AI model configurable under Global and Project Models

### Fixed
- Fix bundled example plugins failing to enable with a missing @fusion/core package error
- Fix agents silently going stale for hours even though the heartbeat repair audit was running
- Settings search now surfaces Project Models Chat default settings when searching for chat

> Older releases (before 0.60.0) are archived in [`CHANGELOG-archive.md`](./CHANGELOG-archive.md).
