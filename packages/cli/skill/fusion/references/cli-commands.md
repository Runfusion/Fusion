# Fusion CLI Commands Reference

The Fusion CLI is invoked with `fn` (short for fusion).

## Dashboard

```bash
fn dashboard                              # Start web UI + AI engine (port 4040)
fn dashboard --port 8080                  # Custom port
fn dashboard --interactive                # Interactive port selection
fn dashboard --paused                     # Start with automation paused
fn dashboard --dev                        # Development-mode dashboard + AI engine
fn dashboard --no-engine                  # Web UI only (no AI engine)
```

## Task Management

```bash
fn task create "description"              # Create task → triage
fn task create "desc" --attach file.png   # Create with attachment
fn task create "desc" --depends FN-001    # Create with dependency
fn task plan "description"                # AI-guided planning mode
fn task list                              # List all tasks by column
fn task show FN-001                       # Show task details + steps + log
fn task move FN-001 todo                  # Move task to column
fn task merge FN-001                      # Merge in-review task to main
fn task duplicate FN-001                  # Copy task to triage
fn task refine FN-001 --feedback "..."    # Create follow-up task
fn task archive FN-001                    # Move done → archived
fn task unarchive FN-001                  # Move archived → done
fn task delete FN-001 [--force]           # Soft delete (recoverable via DB)
fn task retry FN-001                      # Retry failed task → todo
fn task comment FN-001 "text"             # Add general comment
fn task comments FN-001                   # List task comments
fn task steer FN-001 "guidance"           # Add steering comment for AI
fn task pause FN-001                      # Pause automation
fn task unpause FN-001                    # Resume automation
fn task logs FN-001                       # View agent execution logs
fn task logs FN-001 --follow              # Stream logs in real-time
fn task logs FN-001 --limit 50            # Limit log lines
fn task logs FN-001 --type tool           # Filter by log type
```

## Research

```bash
fn research create --query "question"          # Create research run
fn research create --query "question" --wait   # Wait for completion
fn research list                                 # List runs
fn research ls --status failed --limit 20        # Filter by status
fn research show RR-001                          # Show one run
fn research export RR-001 --format json          # Export to JSON
fn research export RR-001 --output ./run.md      # Export to specific path
fn research cancel RR-001                        # Cancel active run
fn research retry RR-001                         # Retry failed/cancelled run
```

## Mission Management

```bash
fn mission create "Title" "Description"   # Create a new mission
fn mission list                            # List all missions
fn mission show M-001                      # Show mission hierarchy
fn mission delete M-001 [--force]          # Delete mission (cascades)
fn mission activate-slice SL-001           # Manually activate a slice
fn goals list [--status STATE]             # List goals (default: active)
fn goals create "Title" "Description"      # Create a new goal
fn goals archive G-001                     # Archive a goal
```

## GitHub Integration

```bash
fn task import owner/repo                  # Import all open issues
fn task import owner/repo --interactive    # Select issues interactively
fn task import owner/repo --limit 10       # Limit import count
fn task import owner/repo --labels bug     # Filter by labels
fn task pr-create FN-001                   # Create GitHub PR
fn task pr-create FN-001 --title "Fix"     # PR with custom title
fn task pr-create FN-001 --base main       # PR targeting specific base
```

## Git Operations

```bash
fn git status                              # Branch, commit, dirty state
fn git fetch [remote]                      # Fetch from remote
fn git pull [--yes]                        # Pull current branch
fn git push [--yes]                        # Push current branch
```

## Settings

```bash
fn settings                                # Show all settings
fn settings set maxConcurrent 4            # Update a setting
fn settings set autoMerge false            # Disable auto-merge
fn settings set prCompletionMode pr-first  # Use PR workflow
```

## Backups

```bash
fn backup --create                                      # Create project/archive + central .dump pair
fn backup --list                                        # List complete pairs and orphans with sizes
fn backup --restore fusion-pg-<timestamp>.dump           # Restore the required same-stem pair
fn backup --restore fusion-central-pg-<timestamp>.dump   # Restore central only
fn backup --cleanup                                     # Remove old pairs and abandoned crash artifacts
```

Before native backup operations, quiesce Fusion writers and competing
create/list/cleanup/restore processes; the command has no cross-process lock.
A restore validates every required archive and retains a current-state
`fusion-pre-restore-pg-*` + `fusion-central-pre-restore-pg-*` +
`fusion-migrations-pre-restore-pg-*` stem first. Project/archive restores
before central and captured migration bookkeeping. If a later group fails,
Fusion rolls every committed group back from the retained stem. Legacy
two-member stems remain restorable; Fusion then rewinds
`public.fusion_schema_migrations` from the earliest missing CREATE-TABLE
sentinel and replays pending migrations.

## Multi-Project

```bash
fn project list                            # List registered projects
fn project add my-app /path/to/app         # Register project
fn project remove my-app [--force]         # Unregister project
fn project show my-app                     # Show project details
fn project set-default my-app              # Set default project
fn project detect                          # Detect current project

# Use --project flag with any command
fn task list --project my-app
fn task create "desc" --project api
fn settings --project my-app
```

## Columns (valid values for `fn task move`)

| Column | Description |
|--------|-------------|
| `triage` | Awaiting specification |
| `todo` | Specified, waiting for execution |
| `in-progress` | Being executed by AI |
| `in-review` | Ready for merge |
| `done` | Merged to main |
| `archived` | Removed from active view |
