---
"@gsxdsm/fusion": minor
---

Unify task comments into a single system

The task comment system has been consolidated from two separate systems (`steeringComments` and `comments`) into a single unified `comments` field using the `TaskComment` type. This simplifies the API and removes confusion about which comment type to use.

**Breaking Changes:**
- Removed `SteeringComment` type (use `TaskComment` instead)
- Removed `steeringComments` field from `Task` interface
- All comments are now stored in the unified `comments` field
- The `/api/tasks/:id/steer` endpoint still works but now uses the unified comment system internally

**Migration:**
- Legacy `steeringComments` data is automatically merged into `comments` during database read operations
- The `addSteeringComment` method now delegates to `addTaskComment` while preserving auto-refinement behavior for done tasks

**UI Changes:**
- "Steering Comments" tab heading changed to "Comments"
- Placeholder text changed from "Add a steering comment..." to "Add a comment..."
- Button text changed from "Add Steering Comment" to "Add Comment"
