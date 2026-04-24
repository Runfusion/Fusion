<required_reading>
- references/extension-tools.md — Full tool parameters and return values
- references/best-practices.md — Tips for writing good task descriptions
</required_reading>

<objective>
Guide the agent through creating, viewing, and managing tasks on the Fusion board using pi extension tools.

Use only the public `fn_*` extension tools in this workflow. Do not substitute internal engine runtime tools like `task_create`, `task_update`, `task_log`, or `task_done`.
</objective>

<process>

**Creating a task:**

1. Use `fn_task_create` with a clear, descriptive message
   - Include the problem AND the desired outcome
   - Be specific — the AI triage agent uses your description to write the specification
   - Optionally add dependencies with the `depends` parameter

2. The task enters **triage** where the AI auto-generates a PROMPT.md with:
   - Steps, file scope, acceptance criteria
   - Review level assessment
   - Size estimate (S/M/L)

3. After specification, the task moves to **todo** and waits for the scheduler

Example:
```
fn_task_create({
  description: "The login form doesn't validate email format before submission. Add client-side email validation that shows an inline error message when the email is invalid. Use the existing form validation pattern from the signup form.",
  depends: ["FN-042"]
})
```

**AI-guided planning for complex tasks:**

Use `fn_task_plan` when the idea is vague or complex. The AI will:
1. Ask clarifying questions about scope, constraints, and approach
2. Help break down the work into actionable pieces
3. Create the task with a refined description

**Listing tasks:**

Use `fn_task_list` to see the board:
- No params → all tasks grouped by column
- `column: "in-progress"` → filter to specific column
- `limit: 5` → limit tasks shown per column

**Viewing task details:**

Use `fn_task_show` with the task ID:
- Shows steps with progress indicators (✓ done, ▸ in-progress, – skipped)
- Shows prompt preview (truncated to 500 chars)
- Shows recent log entries (last 5)

**Managing task state:**

| Action | Tool | Notes |
|--------|------|-------|
| Pause automation | `fn_task_pause` | Stops scheduler and executor from touching the task |
| Resume automation | `fn_task_unpause` | Re-enables automated processing |
| Retry failed task | `fn_task_retry` | Clears error, moves back to todo |
| Duplicate task | `fn_task_duplicate` | Creates fresh copy in triage |
| Refine completed task | `fn_task_refine` | Creates follow-up task with dependency on original |
| Archive done task | `fn_task_archive` | Moves from done → archived |
| Restore archived task | `fn_task_unarchive` | Moves from archived → done |
| Delete task | `fn_task_delete` | Permanent — cannot be undone |

**Attaching files:**

Use `fn_task_attach` with the task ID and file path:
- Supports images: png, jpg, gif, webp
- Supports text: txt, log, json, yaml, csv, xml
- Files are copied to `.fusion/tasks/{ID}/attachments/`

**Importing from GitHub:**

1. Browse issues first: `fn_task_browse_github_issues({ owner: "org", repo: "repo" })`
   - Shows issue numbers, titles, labels
   - Marks already-imported issues with ✓
2. Import specific issue: `fn_task_import_github_issue({ owner: "org", repo: "repo", issueNumber: 42 })`
3. Bulk import: `fn_task_import_github({ ownerRepo: "org/repo", limit: 20 })`

</process>

<success_criteria>
- Task created with clear description that enables good AI specification
- Dependencies declared correctly (task IDs exist and are valid)
- Task state managed appropriately (pause for manual intervention, retry for failures)
- GitHub issues imported without duplicates
</success_criteria>
