---
"@dustinbyrne/kb": minor
---

Add interactive terminal to dashboard for executing shell commands directly in the project directory

The dashboard now includes a fully functional shell terminal accessible via the terminal icon in the header. Features include:

- Real-time command output streaming via Server-Sent Events (SSE)
- Command history with Up/Down arrow navigation
- Keyboard shortcuts: Ctrl+C to kill process, Ctrl+L to clear screen
- Security validation with allowlist/blocklist for commands
- 30-second timeout for commands with automatic cleanup
- Monospace font styling with color-coded output (stdout/stderr/exit codes)
- Mobile-responsive design with safe area insets

The terminal is always available regardless of task state, making it convenient for quick git operations, package management, or debugging without leaving the dashboard.
