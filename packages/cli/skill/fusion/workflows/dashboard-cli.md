<required_reading>
- references/cli-commands.md — Full CLI command reference
</required_reading>

<objective>
Guide the agent through using the Fusion dashboard and CLI for operations not available via pi extension tools.
</objective>

<process>

**Starting the dashboard:**

Use the `/fn` command (registered by the pi extension):
- `/fn` or `/fn 4040` — Start dashboard + AI engine on specified port (default 4040)
- `/fn stop` — Stop the dashboard
- `/fn status` — Check if dashboard is running

The dashboard provides:
- Real-time kanban board with drag-and-drop
- Task detail modal with tabs: Details, Spec, Model, Workflow, Comments
- Git manager (commits, branches, worktrees)
- Activity log
- Settings configuration
- Workflow step manager
- Mission hierarchy view (Cmd/Ctrl+Shift+M)
- GitHub import modal
- Theme system (8+ themes, dark/light/system)

**Operations that require CLI or dashboard:**

These cannot be done with pi extension tools:

| Operation | CLI Command | Dashboard |
|-----------|-------------|-----------|
| Move task to column | `fn task move FN-001 todo` | Drag card between columns |
| Merge completed task | `fn task merge FN-001` | Click merge in task detail |
| Add steering comment | `fn task steer FN-001 "Use TypeScript"` | Comments tab in task detail |
| Add general comment | `fn task comment FN-001 "Looks good"` | Comments tab in task detail |
| View agent logs | `fn task logs FN-001 --follow` | Agent log tab in task detail |
| Change settings | `fn settings set maxConcurrent 4` | Settings modal |
| Create workflow steps | — | Workflow Steps button in header |
| Git operations | `fn git status/fetch/pull/push` | Git manager panel |

**Settings overview:**

Key settings (configure via dashboard Settings or `fn settings set`):

| Setting | Default | Description |
|---------|---------|-------------|
| `maxConcurrent` | 2 | Concurrent task execution slots |
| `autoMerge` | true | Auto-merge completed tasks to main |
| `requirePlanApproval` | false | Manual approval for AI specifications |
| `prCompletionMode` | "direct" | How tasks complete: "direct" (squash merge) or "pr-first" (GitHub PR) |
| `recycleWorktrees` | false | Pool and reuse git worktrees |
| `taskStuckTimeoutMs` | — | Timeout for detecting stuck tasks (ms) |
| `autoBackupEnabled` | false | Automatic database backups |
| `ntfyEnabled` | false | Push notifications via ntfy.sh |

**Working with GitHub PRs:**

When `prCompletionMode` is set to "pr-first":
- Completed tasks create a GitHub PR instead of direct-merging
- Use `fn task pr-create FN-001` to manually create a PR for any in-review task
- PRs can be reviewed and merged through the normal GitHub workflow

**Backup operations:**

```bash
fn backup --create         # Create a backup now
fn backup --list           # List all backups
fn backup --restore <file> # Restore from backup
fn backup --cleanup        # Remove old backups
```

**Multi-project support:**

If managing multiple projects, use `--project` flag:
```bash
fn task list --project my-app
fn task create "Fix bug" --project api-service
fn project list              # List all registered projects
fn project add my-app /path  # Register a project
fn project set-default main  # Set default project
```

</process>

<success_criteria>
- Agent knows when to direct user to dashboard vs. CLI
- Settings are configured appropriately for the project's needs
- Dashboard is accessible and running when needed
</success_criteria>
