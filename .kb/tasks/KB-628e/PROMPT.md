# Task: KB-628e - Missions Final Integration: Testing, Documentation, and Polish

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is the final integration task that ties all previous subtasks together, adds comprehensive testing, documentation, and ensures the entire Missions system works end-to-end. It's the quality gate before considering KB-628 complete.

**Score:** 4/8 — Blast radius: 1 (mostly documentation and integration), Pattern novelty: 1 (follows existing patterns), Security: 1 (no new security concerns), Reversibility: 1 (documentation can be updated)

## Mission

Complete the Missions system by performing comprehensive end-to-end testing, updating all documentation, adding the final integration touches, and ensuring the entire feature is production-ready. This task serves as the final quality gate before the Missions system can be considered fully implemented.

## Dependencies

- **Task:** KB-628a — Database Schema, Types, and MissionStore
- **Task:** KB-628b — Mission REST API and Interview System
- **Task:** KB-628c — Dashboard UI: Mission List, Detail View, and Timeline
- **Task:** KB-628d — CLI Commands, Pi Extension, and Engine Integration

All previous subtasks must be complete before starting this final integration task.

## Context to Read First

1. `README.md` — Current project documentation to update with missions
2. `AGENTS.md` — Agent documentation that should reference missions
3. All files from KB-628a, KB-628b, KB-628c, KB-628d

## File Scope

**New Files:**
- `.changeset/missions-system-complete.md` — Final changeset for the complete feature
- `docs/missions-guide.md` (optional) — Comprehensive user guide

**Modified Files:**
- `README.md` — Add missions to feature list
- `AGENTS.md` — Document mission system for agents
- All files from previous subtasks as needed for integration fixes

## Steps

### Step 1: End-to-End Integration Test

- [ ] Perform complete manual test of the Missions system:
  - Create mission via dashboard interview
  - Verify mission appears in list with correct status
  - Open mission detail, verify hierarchy
  - Add milestones manually in detail view
  - Interview milestone to generate slices/features
  - Verify slices and features created correctly
  - Activate a slice
  - Verify tasks created in triage with missionId/sliceId
  - Move tasks through columns to done
  - Verify auto-advance activates next slice
  - Verify status rollup (slice → milestone → mission)
  - Complete entire mission
  - Archive mission
- [ ] Test CLI flow:
  - `fn mission create "CLI Test Mission"`
  - `fn mission list` — verify appears
  - `fn mission show <id>` — verify hierarchy visible
  - `fn mission add-milestone <mission> "Milestone"`
  - `fn mission add-slice <milestone> "Slice"`
  - `fn mission activate <slice>` — verify tasks created
- [ ] Test pi extension (if testable):
  - Verify mission tools appear in available tools
  - Test mission_create tool
  - Test mission_show tool

**Artifacts:**
- Integration test notes (mental or documented)

### Step 2: Fix Integration Issues

- [ ] Address any issues found during E2E testing:
  - API endpoint errors
  - UI component bugs
  - CLI command issues
  - Scheduler integration problems
  - Database constraint violations
- [ ] Common issues to watch for:
  - Foreign key constraint failures
  - Status not rolling up correctly
  - Auto-advance not triggering
  - Tasks not getting missionId/sliceId set
  - Interview sessions not persisting context
- [ ] Each fix should include test coverage

**Artifacts:**
- Bug fixes across all modified files

### Step 3: Activity Log Integration

- [ ] Ensure all mission lifecycle events are logged:
  - "mission:created" — when mission created
  - "milestone:completed" — when milestone reaches complete
  - "slice:activated" — when slice activated
  - "mission:completed" — when mission reaches complete
- [ ] Verify activity log entries include:
  - Mission ID, title
  - Timestamp
  - Actor (user or system)
  - Metadata (what changed)
- [ ] Update ActivityLogModal to display mission events:
  - Special icons for mission events
  - Click to navigate to mission detail
  - Filter by mission events

**Artifacts:**
- Activity log integration in core and dashboard

### Step 4: Notification Integration

- [ ] Extend ntfy notification system for missions:
  - Notify when milestone completed: "Milestone 'X' completed in mission 'Y'"
  - Notify when mission completed: "Mission 'Y' completed — all milestones done"
  - Notify when slice auto-advances: "Advanced to next slice in 'Y'"
- [ ] Respect user notification settings:
  - Only send if `ntfyEnabled` is true
  - Include mission/title context in notification body
- [ ] Add notification preferences for missions (optional)

**Artifacts:**
- Notification hooks in scheduler

### Step 5: Comprehensive Test Suite

- [ ] Ensure all packages have passing tests:
  - `packages/core` — MissionStore tests from KB-628a
  - `packages/dashboard` — API and component tests
  - `packages/engine` — Scheduler integration tests from KB-628d
  - `packages/cli` — Command tests from KB-628d
- [ ] Run full test suite: `pnpm test`
  - ZERO failures allowed
  - Fix any regressions immediately
- [ ] Add integration tests (optional but recommended):
  - Test full mission lifecycle in single test
  - Verify all components work together

**Artifacts:**
- All test files passing

### Step 6: TypeScript Type Checking

- [ ] Run `pnpm typecheck` in all packages:
  - `packages/core` — must pass
  - `packages/dashboard` — must pass
  - `packages/engine` — must pass
  - `packages/cli` — must pass
- [ ] Fix all type errors
- [ ] Ensure no `any` types introduced without justification
- [ ] Verify all mission types are properly exported

**Artifacts:**
- Zero type errors across all packages

### Step 7: Build Verification

- [ ] Run `pnpm build` — must complete successfully
- [ ] Verify all new files are included in build outputs
- [ ] Check that no build warnings related to missions
- [ ] Test CLI binary: `pnpm build:exe` (if applicable)
- [ ] Verify dashboard builds: `pnpm --filter @fusion/dashboard build`

**Artifacts:**
- Successful build

### Step 8: README.md Updates

- [ ] Add Missions section to `README.md`:
  - Brief description of what missions are
  - Four-level hierarchy explanation
  - Key features: interview system, auto-advance, timeline
  - Simple usage example
- [ ] Update feature list:
  - Add "📊 Large-scale project planning with Missions" to features
- [ ] Update command reference section:
  - Add `fn mission` commands to CLI reference
- [ ] Keep it concise — link to AGENTS.md for detailed documentation

**Artifacts:**
- `README.md` (modified)

### Step 9: AGENTS.md Updates

- [ ] Add comprehensive Missions section to `AGENTS.md`:
  - Concept explanation: Mission → Milestone → Slice → Feature → Task
  - When to use missions vs. regular tasks
  - How to create missions (interview process)
  - Slice activation and task creation flow
  - Auto-advance behavior
  - Status rollup rules
- [ ] Document dashboard UI:
  - How to open mission list
  - How to use mission detail view
  - How to use timeline
  - How to filter board by mission
- [ ] Document CLI:
  - All `fn mission` commands with examples
  - Common workflows
- [ ] Document pi extension:
  - Mission tools available to agents
  - When agents should suggest missions
- [ ] Document for developers:
  - MissionStore API
  - Database schema
  - Event types

**Artifacts:**
- `AGENTS.md` (modified)

### Step 10: Changeset Creation

- [ ] Create comprehensive changeset:
  ```bash
  cat > .changeset/missions-system-complete.md << 'EOF'
  ---
  "@fusion/core": minor
  "@fusion/dashboard": minor
  "@fusion/engine": minor
  "@gsxdsm/fusion": minor
  ---
  
  Introduce Missions: a four-level hierarchical planning system for large-scale projects.
  
  ## What's New
  
  ### Core Infrastructure
  - New SQLite tables: `missions`, `milestones`, `slices`, `mission_features`
  - MissionStore with full CRUD operations and status rollup
  - Mission types: Mission, Milestone, Slice, MissionFeature
  
  ### Dashboard UI
  - Mission list modal with progress overview
  - Mission detail view with hierarchical tree
  - Mission timeline visualization (Gantt-style)
  - AI-driven interview system for mission and milestone planning
  - Board filtering by mission, milestone, or slice
  - Header progress indicator for active mission
  - Drag-and-drop reordering for milestones and slices
  
  ### CLI
  - `fn mission create` — Create new mission
  - `fn mission list` — List all missions
  - `fn mission show` — Display mission hierarchy
  - `fn mission activate` — Activate slice (create tasks)
  - `fn mission add-milestone` — Add milestone
  - `fn mission add-slice` — Add slice
  - `fn mission add-feature` — Add feature
  - `fn mission delete` — Delete mission
  
  ### Engine Integration
  - Slice activation and auto-advance
  - Status rollup through hierarchy
  - Activity log and notification integration
  
  ### Pi Extension
  - `mission_create`, `mission_list`, `mission_show` tools
  - `mission_activate_slice`, `mission_add_milestone` tools
  
  ## How to Use
  
  1. Open dashboard and click "Missions" in header
  2. Click "New Mission" and describe your goal
  3. Complete the AI interview to generate milestones
  4. Drill into milestones and interview to create slices/features
  5. Activate slices to create tasks
  6. Complete tasks — auto-advance handles the rest
  
  Or use CLI: `fn mission create "Build new auth system"`
  EOF
  ```

**Artifacts:**
- `.changeset/missions-system-complete.md` (new)

### Step 11: Performance Validation

- [ ] Test with realistic data:
  - Mission with 5 milestones
  - Each milestone with 3-4 slices
  - Each slice with 3-5 features
  - Verify dashboard remains responsive
- [ ] Database query performance:
  - `getMissionWithHierarchy` should complete in <100ms
  - List queries should use appropriate indexes
- [ ] UI performance:
  - Mission detail modal opens quickly
  - Tree expansion is smooth
  - Timeline renders without lag
- [ ] Optimize if needed:
  - Add database indexes if queries are slow
  - Implement pagination if needed (unlikely for initial release)

**Artifacts:**
- Performance validation complete

### Step 12: Accessibility Check

- [ ] Verify dashboard UI accessibility:
  - Mission list: keyboard navigation works
  - Mission detail: screen reader announces hierarchy
  - Timeline: has aria-labels
  - All buttons have proper labels
- [ ] Verify interview modal accessibility:
  - Questions are announced properly
  - Form inputs have labels
  - Focus management works
- [ ] Color contrast:
  - Status badges meet WCAG contrast requirements
  - Progress bars are distinguishable

**Artifacts:**
- Accessibility validation complete

### Step 13: Mobile Responsiveness

- [ ] Test dashboard on mobile viewport:
  - Mission list: cards stack properly
  - Mission detail: tree is usable on small screens
  - Timeline: scrolls horizontally if needed
  - Header indicator: collapses appropriately
- [ ] Touch interactions:
  - Drag-and-drop works on touch devices (or use reorder buttons)
  - Tap targets are large enough
- [ ] Responsive breakpoints:
  - <640px: mobile layout
  - 640-1024px: tablet layout
  - >1024px: desktop layout

**Artifacts:**
- Mobile validation complete

### Step 14: Final Code Review

- [ ] Review all files changed across KB-628 subtasks:
  - Code quality and consistency
  - Naming conventions
  - Error handling
  - Comments and documentation
- [ ] Check for:
  - Console.log statements that should be removed
  - TODO comments that need resolution
  - Dead code or unused imports
  - Duplicate code that could be refactored
- [ ] Ensure all files end with newlines
- [ ] Ensure consistent formatting

**Artifacts:**
- Code review complete, any issues fixed

### Step 15: Final Documentation Review

- [ ] Review all documentation:
  - README.md accurate and complete
  - AGENTS.md comprehensive and clear
  - Changeset describes feature well
  - JSDoc comments present on public APIs
- [ ] Check for:
  - Broken links
  - Outdated references
  - Typos or grammar issues
  - Unclear explanations

**Artifacts:**
- Documentation review complete

### Step 16: Final Testing & Delivery

> ZERO test failures allowed. This is the final quality gate.

- [ ] Run complete test suite one final time: `pnpm test`
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Run build: `pnpm build`
- [ ] Verify changeset is present and valid
- [ ] Create final commit: `feat(KB-628e): complete Missions final integration`
- [ ] Move parent task KB-628 to "done" column
- [ ] Archive all subtask PROMPT.md files if desired

## Documentation Requirements

**Must Update:**
- `README.md` — Add missions to feature list and CLI reference
- `AGENTS.md` — Comprehensive mission system documentation
- `.changeset/missions-system-complete.md` — Complete feature changeset

**Check If Affected:**
- `ROADMAP.md` — Mark missions as complete
- `RELEASING.md` — Note the new feature for next release

## Completion Criteria

- [ ] All 16 steps complete
- [ ] End-to-end testing passed
- [ ] All tests passing (ZERO failures)
- [ ] Typecheck passing (ZERO errors)
- [ ] Build passing
- [ ] README updated with missions
- [ ] AGENTS.md updated with comprehensive documentation
- [ ] Changeset created
- [ ] Performance validated
- [ ] Accessibility validated
- [ ] Mobile responsive
- [ ] Code reviewed and polished
- [ ] Parent task KB-628 can be moved to done

## Git Commit Convention

- **Step completion:** `feat(KB-628e): complete Step N — description`
- **Bug fixes:** `fix(KB-628e): description`
- **Tests:** `test(KB-628e): description`
- **Documentation:** `docs(KB-628e): description`

## Do NOT

- Skip the end-to-end integration test
- Skip fixing issues found during testing
- Skip documentation updates
- Rush through the final quality gate
- Skip performance or accessibility validation
- Leave TODO comments unresolved
- Forget to create the changeset
