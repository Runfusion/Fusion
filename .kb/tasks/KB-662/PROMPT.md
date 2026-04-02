# KB-662

Build a dashboard UI for the Mission hierarchy system. The API routes already exist (`mission-routes.ts`), but the frontend has no UI to create/view/edit Missions, Milestones, Slices, and Features.

Required features:
- Missions list and creation UI (in header or sidebar)
- Mission detail view with full hierarchy display (Milestones → Slices → Features)
- CRUD operations for all hierarchy levels
- Link features to tasks
- Auto-advance slice activation controls
- Mission interview state for AI-assisted planning

The MissionStore provides:
- Mission (title, description, status, autoAdvance)
- Milestone (title, description, dependencies, orderIndex)
- Slice (title, description, status)
- Feature (title, description, acceptanceCriteria, taskId)

API endpoints already exist at `/api/missions/*`
