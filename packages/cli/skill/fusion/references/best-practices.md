# Best Practices for Working with Fusion

## Writing Task Descriptions

**Do:**
- State the problem AND desired outcome
- Include specific file paths, technologies, or patterns to use
- Mention what's out of scope to prevent scope creep
- Reference related tasks by ID if there are dependencies
- Include "current behavior" vs "expected behavior" for bugs

**Don't:**
- Write one-liner descriptions like "fix the bug"
- Include implementation details the AI should figure out
- Create tasks that are too large (break into smaller tasks or use missions)
- Duplicate existing tasks — check `kb_task_list` first

## Task Size Guidelines

| Size | Scope | Examples |
|------|-------|---------|
| S | Single file change, simple fix | Fix typo, update config, add CSS rule |
| M | 2-5 files, moderate complexity | Add form validation, create API endpoint |
| L | 5+ files, significant feature | New page/component, refactor module, add auth |

For work larger than L, use missions to break it into phases.

## When to Use Each Tool

| Scenario | Tool |
|----------|------|
| Quick task with clear scope | `kb_task_create` |
| Vague idea needing refinement | `kb_task_plan` |
| Large project with phases | `kb_mission_create` + hierarchy |
| Task failed, needs retry | `kb_task_retry` |
| Task needs manual intervention | `kb_task_pause` |
| Completed task needs follow-up | `kb_task_refine` |
| Clean up done tasks | `kb_task_archive` |
| Import external work | `kb_task_import_github*` |

## Dependency Management

- Declare dependencies at creation time using the `depends` parameter
- Dependencies must be valid task IDs that exist
- Tasks wait in todo until all dependencies are in done or archived
- Circular dependencies are rejected
- Use missions for complex dependency graphs across many tasks

## Working with the AI Engine

- **Don't fight the automation** — let triage, scheduler, and executor do their jobs
- **Pause if needed** — use `kb_task_pause` when you want manual control
- **Steer don't micromanage** — use steering comments (via CLI `fn task steer`) to guide the AI without rewriting the spec
- **Check progress** — use `kb_task_show` to monitor step completion
- **Let it fail and retry** — if a task fails, check the log, then `kb_task_retry`

## Mission Planning Tips

1. **Start with the mission** — define the high-level goal first
2. **Milestones are phases** — order them chronologically (what comes first?)
3. **Slices are parallel tracks** — within a milestone, what can be done independently?
4. **Features are deliverables** — each feature should map to one task
5. **Activate slices sequentially** — only activate what's ready for implementation
6. **Use auto-advance** — enable on the mission to automatically progress through slices

## Common Patterns

**Bug fix flow:**
1. `kb_task_create` with bug description (current vs expected behavior)
2. Wait for triage to generate specification
3. Monitor with `kb_task_show` until done

**Feature development flow:**
1. `kb_task_plan` to refine requirements
2. Check the task in triage → todo → in-progress
3. Review in `kb_task_show` when in-review
4. Task auto-merges to main

**Large project flow:**
1. `kb_mission_create` with project overview
2. Add milestones for each phase
3. Add slices and features for the first milestone
4. Activate first slice, create and link tasks
5. As tasks complete, features auto-complete
6. Activate next slice (or use auto-advance)

**GitHub issue triage flow:**
1. `kb_task_browse_github_issues` to see what's open
2. `kb_task_import_github_issue` for high-priority issues
3. Tasks enter triage and get AI-specified
4. Monitor board as AI works through them
