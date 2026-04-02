# Skill Patterns Analysis

## Patterns Observed from High-Quality Skills

### 1. Router Pattern (create-skill)

- SKILL.md acts as a router with `<routing>` section
- Maps user intent to specific workflow files
- Essential principles are inline in SKILL.md (always loaded)
- Workflows have `<required_reading>`, `<process>`, `<success_criteria>`
- References contain reusable domain knowledge

### 2. Command Reference Pattern (agent-browser)

- Core workflow presented upfront (navigate → snapshot → interact → re-snapshot)
- Essential commands with examples inline
- Common patterns section for frequent use cases
- Deep-dive references linked at the bottom via table
- Templates for ready-to-use scripts
- Uses `allowed-tools` for Bash commands

### 3. Search & Discover Pattern (find-skills)

- Simple single-file skill (no router needed)
- Clear "When to Use" triggers section
- Step-by-step guidance for common flow
- Fallback guidance when primary path fails
- Tips section for optimization

## Key Takeaways for Fusion Skill

1. **Use router pattern** — Fusion has multiple distinct workflows (task management, lifecycle, specs, dashboard/CLI)
2. **No `allowed-tools` needed** — Fusion tools are registered via pi extension, not Bash CLI
3. **Inline essential concepts** — Task columns, workflow overview in SKILL.md
4. **Progressive disclosure** — SKILL.md routes to workflows, workflows reference detailed docs
5. **Pure XML structure** — No markdown headings (#, ##, ###) in body
6. **Triggers section** — Clear when-to-use criteria
7. **Under 500 lines** — Keep SKILL.md concise, split to workflows/references
