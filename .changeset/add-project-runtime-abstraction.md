---
"@gsxdsm/fusion": minor
---

Add ProjectRuntime abstraction for multi-project support.

New exports:
- ProjectRuntime interface for project engine lifecycle
- InProcessRuntime (default) and ChildProcessRuntime (isolation) implementations
- ProjectManager for orchestrating multiple projects
- IPC protocol for child-process isolation mode
- Global concurrency enforcement across all projects
