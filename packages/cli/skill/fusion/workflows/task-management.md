<required_reading>
- references/extension-tools.md — Full tool parameters and return values
- references/best-practices.md — Tips for writing good task descriptions
</required_reading>

<objective>
Guide the agent through creating, viewing, and managing tasks on the Fusion board using pi extension tools.
</objective>

<process>

**Creating a task:**

1. Use `kb_task_create` with a clear, descriptive message
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
kb_task_create({
  description: "The login form doesn't validate email format before submission. Add client-side email validation that shows an inline error message when the email is invalid. Use the existing form validation pattern from the signup form.",
  depends: ["KB-042"]
})
```

**AI-guided planning for complex tasks:**

Use `kb_task_plan` when the idea is vague or complex. The AI will:
1. Ask clarifying questions about scope, constraints, and approach
2. Help break down the work into actionable pieces
3. Create the task with a refined description

**Listing tasks:**

Use `kb_task_list` to see the board:
- No params → all tasks grouped by column
- `column: "in-progress"` → filter to specific column
- `limit: 5` → limit tasks shown per column

**Viewing task details:**

Use `kb_task_show` with the task ID:
- Shows steps with progress indicators (✓ done, ▸ in-progress, – skipped)
- Shows prompt preview (truncated to 500 chars)
- Shows recent log entries (last 5)

**Managing task state:**

| Action | Tool | Notes |
|--------|------|-------|
| Pause automation | `kb_task_pause` | Stops scheduler and executor from touching the task |
| Resume automation | `kb_task_unpause` | Re-enables automated processing |
| Retry failed task | `kb_task_retry` | Clears error, moves back to todo |
| Duplicate task | `kb_task_duplicate` | Creates fresh copy in triage |
| Refine completed task | `kb_task_refine` | Creates follow-up task with dependency on original |
| Archive done task | `kb_task_archive` | Moves from done → archived |
| Restore archived task | `kb_task_unarchive` | Moves from archived → done |
| Delete task | `kb_task_delete` | Permanent — cannot be undone |

**Attaching files:**

Use `kb_task_attach` with the task ID and file path:
- Supports images: png, jpg, gif, webp
- Supports text: txt, log, json, yaml, csv, xml
- Files are copied to `.fusion/tasks/{ID}/attachments/`

**Importing from GitHub:**

1. Browse issues first: `kb_task_browse_github_issues({ owner: "org", repo: "repo" })`
   - Shows issue numbers, titles, labels
   - Marks already-imported issues with ✓
2. Import specific issue: `kb_task_import_github_issue({ owner: "org", repo: "repo", issueNumber: 42 })`
3. Bulk import: `kb_task_import_github({ ownerRepo: "org/repo", limit: 20 })`

</process>

<success_criteria>
- Task created with clear description that enables good AI specification
- Dependencies declared correctly (task IDs exist and are valid)
- Task state managed appropriately (pause for manual intervention, retry for failures)
- GitHub issues imported without duplicates
</success_criteria>
