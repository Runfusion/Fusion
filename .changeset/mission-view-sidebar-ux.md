---
"@runfusion/fusion": patch
---

Mission view sidebar and list-card UX fixes.

- **Resizable mission sidebar**: the desktop split sidebar is now drag-resizable via a vertical handle (also keyboard-accessible with arrow keys). Width persists to `localStorage` (`fusion:mission-sidebar-width`), bounded 220–560px, default 300px. Previously fixed at ~284px with `flex-shrink: 0`.
- **Mission card title no longer truncates aggressively**: tags (autopilot zap, health badge, status pill) moved to a second row below the title so the title can use the full card width. Removed the redundant overflow-prone `Active: …` line that was sometimes spilling outside the card.
- **Single AI-driven create flow**: removed the manual `+ New Mission` button from the sidebar header and bottom footer. The Sparkles button (now labeled "Create New Mission") is the only entry point — the dead `handleCreateMission` callback and unused `activeSliceLabel` were removed too.
