<required_reading>
- references/task-structure.md — File structure and storage details
</required_reading>

<objective>
Help the agent understand how tasks flow through the Fusion board, what happens at each stage, and how to interpret task state.
</objective>

<process>

**Column flow:**

```
Triage → Todo → In Progress → In Review → Done → Archived
```

Each column transition is driven by the AI engine or user action:

**Triage (specification)**
- Task enters triage when created via `kb_task_create`
- The **TriageProcessor** reads the project context and writes a full PROMPT.md specification
- Specification includes: steps, file scope, acceptance criteria, review level, size estimate
- If `requirePlanApproval` is enabled, task stays in triage as "awaiting-approval" until manually approved
- After specification (and approval if required), task moves to **todo**

**Todo (scheduling)**
- The **Scheduler** watches the todo column
- Resolves dependency graphs — tasks with unmet deps wait
- Respects concurrency limits (default: 2 concurrent tasks)
- When deps are satisfied and a slot is available, moves task to **in-progress**

**In Progress (execution)**
- The **TaskExecutor** creates a git worktree for isolation
- Spawns a pi agent session with coding tools scoped to the worktree
- For each step in the PROMPT.md:
  1. Plan the implementation
  2. Review the plan (if review level requires it)
  3. Execute the plan
  4. Review the code (if review level requires it)
- If workflow steps are enabled, they run sequentially after all main steps
- On completion, task moves to **in-review**

**In Review (merge)**
- Task work is complete and ready for merge
- Depending on settings:
  - `prCompletionMode: "direct"` — Auto squash-merge to main (default)
  - `prCompletionMode: "pr-first"` — Creates a GitHub PR for manual review
- After merge, task moves to **done**

**Done**
- Work is merged to main branch
- Task is available for archival via `kb_task_archive`
- Can be refined with `kb_task_refine` to create follow-up work

**Archived**
- Removed from active board view
- Can be restored with `kb_task_unarchive`
- Can be cleaned up to free disk space (removes task directory, keeps metadata)

**Task statuses (within any column):**

| Status | Meaning |
|--------|---------|
| (none) | Normal state |
| `paused` | Automation suspended — scheduler/executor skip this task |
| `failed` | Execution error — use `kb_task_retry` to reset |
| `awaiting-approval` | Spec complete, waiting for manual approval (triage only) |

**Review levels:**

| Level | Description |
|-------|-------------|
| 0 | No reviews |
| 1 | Plan review only |
| 2 | Plan + code review |
| 3 | Full review (plan + code + tests) |

The AI triage agent sets the review level based on task complexity and risk assessment.

**Dependencies:**

- Tasks can depend on other tasks (by task ID)
- Dependent tasks wait in todo until all dependencies are in **done** or **archived**
- Circular dependencies are prevented
- Use `depends` parameter on `kb_task_create` to declare dependencies

**Interpreting `kb_task_show` output:**

```
KB-042: Fix login validation
Column: In Progress · Size: M · Review: 2

Steps (2/5):
  [✓] 0: Research existing patterns
  [✓] 1: Add email validation
  [▸] 2: Add error display component  ◀  (current step)
  [ ] 3: Write tests
  [ ] 4: Update documentation

Log (last 3):
  14:30  Step 1 completed → Code review passed
  14:32  Step 2 started
  14:35  Plan approved for step 2
```

- `[✓]` = done, `[▸]` = in progress, `[–]` = skipped, `[ ]` = pending
- `◀` marks the current step
- Log shows recent activity with timestamps

</process>

<success_criteria>
- Agent understands which column a task is in and why
- Agent can interpret task status, steps, and progress
- Agent knows when to intervene (pause, retry, refine) vs. let automation handle it
</success_criteria>
