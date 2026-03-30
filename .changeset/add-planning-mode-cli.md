---
"@dustinbyrne/kb": minor
---

Add `kb task plan` command for interactive AI-guided task planning

The new planning mode guides users through an AI-driven conversation to transform vague ideas into well-specified tasks. The CLI asks clarifying questions, gathers requirements, and generates a structured task summary.

Usage:
  kb task plan [description] [--yes]

Features:
- Interactive Q&A with multiple question types (text, single_select, multi_select, confirm)
- Multi-line text input support (type DONE to finish)
- Automatic task creation from planning summary
- --yes flag for non-interactive task creation
- Rate limit and error handling
- Extension tool `kb_task_plan` for pi integration
