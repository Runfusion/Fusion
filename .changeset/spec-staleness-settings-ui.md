---
"@gsxdsm/fusion": patch
---

Add spec staleness controls to dashboard settings UI

- New "Enable specification staleness enforcement" checkbox in Settings → Scheduling section
- Numeric input for "Stale Spec Threshold (hours)" with automatic hours ↔ milliseconds conversion
- Threshold input disabled when enforcement toggle is off
- Previously configured threshold preserved when toggling off/on
- Helper text explains the conversion formula and default (6 hours = 21,600,000 ms)
- Regression tests cover defaults, display conversion, boundary cases, and payload semantics
- Updated README and settings-reference.md documentation
