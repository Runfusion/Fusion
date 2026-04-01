---
"@fusion/dashboard": minor
---

Add multi-project UX with overview page, drill-down, and setup wizard

- New Project Overview page showing all registered projects in a responsive grid with health metrics
- Project selector dropdown in header for quick context switching (appears when 2+ projects)
- Project drill-down into per-project task views with back navigation to overview
- Setup wizard for first-run project registration with auto-detection and manual entry flows
- Global activity feed with project attribution badges when viewing all projects
- Project health polling with active tasks, running agents, and completion counts
- Empty states and loading skeletons for better UX during data fetching
- Keyboard navigation support in project selector (arrow keys, enter, escape)
- LocalStorage persistence for wizard state (resume capability) and view preferences
