---
"@gsxdsm/fusion": patch
---

Tighten mobile bottom spacing between dashboard content and nav bar (FN-1464)

- Introduced `--mobile-nav-height` CSS variable (44px) to unify mobile bottom-spacing contract
- Reduced mobile nav bar footprint from 48px to 44px while preserving 36px touch targets
- Updated executor status bar mobile positioning to use nav-height contract variable
- Updated project content padding formulas to use unified nav-height variable
- Updated CSS regression tests to match new spacing values
