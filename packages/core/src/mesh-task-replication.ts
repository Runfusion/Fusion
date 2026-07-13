/*
FNXC:PostgresCutover 2026-07-12:
Mesh task replication is REMOVED — all replication is handled at the
PostgreSQL level (nodes share the database). This module used to carry the
replicated-create payload builders/matchers; only buildBootstrapPrompt
survives because task creation, comments, and title/description sync use it
to write the human-visible PROMPT.md stub.
*/

export function buildBootstrapPrompt(taskId: string, title: string | undefined, description: string): string {
  const heading = title ? `${taskId}: ${title}` : taskId;
  return `# ${heading}\n\n${description}\n`;
}
