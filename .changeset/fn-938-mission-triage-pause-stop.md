---
"@gsxdsm/fusion": minor
---

Add feature triage and mission pause/stop controls for mission execution.

- **Feature Triage**: When a slice is activated, features can now be triaged into actual kb tasks via the API (`POST /api/missions/features/:featureId/triage`) and UI ("Triage" button on features, "Triage All" on slices).
- **Mission Pause**: Pause a mission (sets status to "blocked") to stop scheduling new tasks while allowing in-flight tasks to complete (`POST /api/missions/:missionId/pause`).
- **Mission Resume**: Resume a paused mission back to active status (`POST /api/missions/:missionId/resume`).
- **Mission Stop**: Stop a mission completely — sets status to "blocked" and pauses all linked tasks (`POST /api/missions/:missionId/stop`).
- **Scheduler Integration**: The scheduler now checks mission status and skips tasks belonging to blocked missions.
