<required_reading>
- references/task-structure.md — PROMPT.md format and file structure
- references/best-practices.md — Tips for writing effective specifications
</required_reading>

<objective>
Guide the agent through creating well-specified tasks and organizing work using the mission hierarchy for complex multi-phase projects.

All tool examples in this workflow intentionally use the public `fn_*` extension namespace.
</objective>

<process>

**Writing effective task descriptions:**

The AI triage agent uses your description to write a PROMPT.md specification. Better descriptions produce better specs:

1. **State the problem** — What's broken, missing, or needed?
2. **Describe the outcome** — What should the result look like?
3. **Add constraints** — Specific technologies, patterns, or files to use
4. **Mention scope** — What's in scope and what's explicitly not

Good example:
```
"The settings page loads all user preferences in a single API call, causing 3s delays.
Split into lazy-loaded sections that fetch only when the tab is opened.
Use React Suspense for loading states. Only affect the settings page — don't
change the API endpoints themselves."
```

Bad example:
```
"Settings page is slow, fix it"
```

**Understanding the PROMPT.md specification:**

After triage, each task gets a PROMPT.md at `.fusion/tasks/{ID}/PROMPT.md` containing:

- **Mission** — What the task should accomplish
- **Steps** — Ordered implementation steps with checkboxes
- **File Scope** — Which files can be modified
- **Acceptance Criteria** — How to verify the task is complete
- **Review Level** — How much review is needed (0-3)
- **Do NOT** — Explicit constraints and boundaries
- **Testing Requirements** — What tests to write/run
- **Dependencies** — Other tasks that must complete first

The executor agent follows this specification step by step.

**Using AI-guided planning:**

For complex or vague ideas, use `fn_task_plan`:
```
fn_task_plan({ description: "Build a notification system for the app" })
```

The planning mode will:
1. Ask clarifying questions about scope, channels (email, push, in-app), users
2. Identify technical constraints and dependencies
3. Suggest breaking the work into multiple tasks if needed
4. Create a well-specified task (or multiple subtasks)

**Organizing with Missions:**

For large-scale projects spanning multiple tasks, use the mission hierarchy:

1. **Create a mission** — The high-level objective
   ```
   fn_mission_create({ title: "Build Authentication System", description: "Complete auth with login, signup, password reset, and OAuth" })
   ```

2. **Add milestones** — Major phases
   ```
   fn_milestone_add({ missionId: "M-001", title: "Database Schema" })
   fn_milestone_add({ missionId: "M-001", title: "API Endpoints" })
   fn_milestone_add({ missionId: "M-001", title: "UI Integration" })
   ```

3. **Add slices** — Parallel work units within milestones
   ```
   fn_slice_add({ milestoneId: "MS-001", title: "User Tables" })
   fn_slice_add({ milestoneId: "MS-001", title: "Token Storage" })
   ```

4. **Add features** — Individual deliverables
   ```
   fn_feature_add({ sliceId: "SL-001", title: "User model", description: "Create user table with email, password hash, timestamps" })
   fn_feature_add({ sliceId: "SL-001", title: "Session table", description: "Create session table with token, expiry, user FK" })
   ```

5. **Activate a slice** — Enable it for implementation
   ```
   fn_slice_activate({ id: "SL-001" })
   ```

6. **Link features to tasks** — Connect features to Fusion tasks
   ```
   fn_task_create({ description: "Create user model with email, password hash, and timestamps" })
   # → Created FN-101
   fn_feature_link_task({ featureId: "F-001", taskId: "FN-101" })
   ```

**Mission status flows automatically:**
- When linked tasks complete → feature status updates to done
- When all features in a slice are done → slice completes
- When all slices in a milestone are done → milestone completes
- When all milestones are done → mission completes

**Auto-advance:** Enable `autoAdvance` on a mission to automatically activate the next pending slice when the current one completes.

**Viewing mission progress:**
```
fn_mission_show({ id: "M-001" })
```
Shows the full hierarchy with status icons:
- `●` active, `○` pending, `✓` complete, `⚠` blocked

</process>

<success_criteria>
- Task descriptions are specific enough for the AI to generate a useful specification
- Complex work is broken down using missions when it spans 5+ tasks
- Mission hierarchy follows the correct nesting: Mission → Milestone → Slice → Feature → Task
- Features are linked to tasks after slice activation
</success_criteria>
