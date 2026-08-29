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
- Duplicate existing tasks — check `fn_task_list` first

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
| Quick task with clear scope | `fn_task_create` |
| Vague idea needing refinement | `fn_task_plan` |
| Large project with phases | `fn_mission_create` + hierarchy |
| Task failed, needs retry | `fn_task_retry` |
| User explicitly requests manual control | `fn_task_pause` |
| Completed task needs follow-up | `fn_task_refine` |
| Clean up done tasks | `fn_task_archive` |
| Import external work | `fn_task_import_github*` |

## Dependency Management

- Declare dependencies at creation time using the `depends` parameter
- Dependencies must be valid task IDs that exist
- Tasks wait in todo until all dependencies are in done or archived
- Circular dependencies are rejected
- Use missions for complex dependency graphs across many tasks

## Working with the AI Engine

- **Don't fight the automation** — let triage, scheduler, and executor do their jobs
- **Pause only on explicit user request** — use `fn_task_pause` for user-driven manual control, never as agent failure or blocker handling
- **Steer don't micromanage** — use steering comments (via CLI `fn task steer`) to guide the AI without rewriting the spec
- **Check progress** — use `fn_task_show` to monitor step completion
- **Let it fail and retry** — if a task fails, check the log, then `fn_task_retry` or create a focused follow-up task instead of pausing it

## Mission Planning Tips

1. **Start with the mission** — define the high-level goal first
2. **Milestones are phases** — order them chronologically (what comes first?)
3. **Slices are parallel tracks** — within a milestone, what can be done independently?
4. **Features are deliverables** — each feature should map to one task
5. **Activate slices sequentially** — only activate what's ready for implementation
6. **Use auto-advance** — enable on the mission to automatically progress through slices

## Common Patterns

**Bug fix flow:**
1. `fn_task_create` with bug description (current vs expected behavior)
2. Wait for triage to generate specification
3. Monitor with `fn_task_show` until done

**Feature development flow:**
1. `fn_task_plan` to refine requirements
2. Check the task in triage → todo → in-progress
3. Review in `fn_task_show` when in-review
4. Task auto-merges to main

**Large project flow:**
1. `fn_mission_create` with project overview
2. Add milestones for each phase
3. Add slices and features for the first milestone
4. Activate first slice, create and link tasks
5. As tasks complete, features auto-complete
6. Activate next slice (or use auto-advance)

**GitHub issue triage flow:**
1. `fn_task_browse_github_issues` to see what's open
2. `fn_task_import_github_issue` for high-priority issues
3. Tasks enter triage and get AI-specified
4. Monitor board as AI works through them

## Agent Management and Delegation

Agents are AI workers in the Fusion system. Each agent has a role, state, and position in an organizational hierarchy. Use the agent management tools to discover, inspect, delegate to, and manage agents.

**Discovering available agents:**
1. `fn_list_agents` — see all agents, optionally filter by role or state
2. `fn_agent_show` — get full details about a specific agent (including hierarchy)
3. `fn_delegate_task` — create and assign a task to the chosen agent

**Checking team structure before delegation:**
1. `fn_agent_org_chart` — visualize the full org tree
2. `fn_agent_show` — inspect a specific agent's capabilities and reports
3. `fn_delegate_task` — assign work to the appropriate agent

**Delegation patterns:**
- **Delegate to reports** — an agent delegates to agents that report to it (downward delegation)
- **Delegate to peers** — an agent delegates to another agent at the same level (lateral delegation)
- **Delegate to other teams** — use `fn_agent_org_chart` to understand cross-team structure
- Always verify the target agent is not ephemeral/runtime before delegating

**Recovery — re-delegating stalled work:**
1. `fn_agent_stop` — pause the stalled agent
2. `fn_list_agents` — find an available agent to take over
3. `fn_delegate_task` — create a new task for the replacement agent
4. The original task can be refined or the new task can depend on it

**Agent lifecycle states:**
- `idle` — agent is available for work
- `active` — agent is running and available for heartbeat cycles
- `running` — agent is currently executing a task
- `paused` — agent has been stopped (use `fn_agent_start` to resume)
- `error` — agent encountered an error
