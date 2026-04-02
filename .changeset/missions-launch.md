---
"@gsxdsm/fusion": minor
---

Add Missions system for large-scale project planning.

The Missions system provides a hierarchical planning structure:
- **Mission** — High-level goals and projects
- **Milestone** — Major phases within missions  
- **Slice** — Parallel work areas within milestones
- **Feature** — Individual deliverables linked to tasks

**New Features:**
- SQLite database schema for mission hierarchy with automatic status rollup
- MissionStore with full CRUD operations and event emissions
- REST API endpoints for mission CRUD operations
- Dashboard UI: mission list, hierarchical detail view, timeline visualization
- CLI commands: `fn mission create`, `list`, `show`, `delete`, `activate-slice`
- Pi extension tools for chat-based mission management
- Engine integration: automatic slice activation when linked tasks complete

**Usage:**
- Press Cmd/Ctrl+Shift+M in dashboard to open missions
- Use interview mode for AI-assisted mission planning
- Link features to tasks for automatic progress tracking
