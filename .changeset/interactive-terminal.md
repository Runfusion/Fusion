---
"@dustinbyrne/kb": minor
---

Add interactive terminal to dashboard

The dashboard now includes a fully interactive shell terminal where users can execute commands directly in the project's working directory. Features include:

- Real-time command execution with output streaming via SSE
- Command history with Up/Down arrow navigation
- Support for common commands: git, npm/pnpm/yarn, ls, cat, cd, clear, etc.
- Command validation to block dangerous operations (rm -rf /, etc.)
- Process kill support (Ctrl+C)
- Clear screen (Ctrl+L)
- Terminal accessible regardless of task state
