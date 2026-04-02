---
"@fusion/dashboard": minor
---

Add Mission Manager UI to the dashboard. The Mission hierarchy system (Missions → Milestones → Slices → Features → Tasks) now has a full dashboard interface with:

- **Target icon button** in the header to open the Mission Manager
- **Mission list view** showing all missions with status badges
- **Full hierarchy editor** for viewing and editing:
  - Milestones with drag-friendly reordering
  - Slices with activate/deactivate controls
  - Features with task linking (link/unlink to kb tasks)
- **Status management** for all hierarchy levels
- **Auto-advance toggle** for automatic slice progression
- **Inline editing** with keyboard support (Enter to save)
- **Delete confirmations** to prevent accidental deletions
- **Task linking** modal to connect features to existing tasks

The Mission system enables high-level project planning with hierarchical breakdown into implementable work units that can be linked directly to kb tasks.
