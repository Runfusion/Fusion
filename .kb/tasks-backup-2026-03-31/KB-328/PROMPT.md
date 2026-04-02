# Task: KB-328 - Create Fusion Skill for AI Agent Interface

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves creating a comprehensive skill (SKILL.md) with multiple workflows and references. It requires proper planning to ensure the skill interface is discoverable and usable by agents, with local-only testing that doesn't depend on external publication.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Create a proper skill (SKILL.md) for Fusion (the kb AI-orchestrated task board) that allows AI agents to discover, understand, and effectively interface with the Fusion system. The skill should guide agents on when and how to use Fusion's capabilities, complementing the existing pi extension tools. This follows patterns demonstrated by existing skills like `agent-browser` and `find-skills`.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/cli/src/extension.ts` — Pi extension that registers kb tools
- `/Users/eclipxe/.agents/skills/find-skills/SKILL.md` — Example skill structure
- `/Users/eclipxe/.agents/skills/agent-browser/SKILL.md` — Example skill with clear usage patterns
- `/Users/eclipxe/.agents/skills/create-skill/SKILL.md` — Guidelines for creating skills
- `/Users/eclipxe/Projects/kb/README.md` — Full Fusion documentation
- `/Users/eclipxe/Projects/kb/AGENTS.md` — Project guidelines for AI agents

## File Scope

- `~/.agents/skills/fusion/SKILL.md` (new — the skill definition file)
- `~/.agents/skills/fusion/references/` (new — reference materials for the skill)
- `~/.agents/skills/fusion/workflows/` (new — workflow files)
- `packages/cli/src/extension.ts` (modified — if tool descriptions/guidelines need updating)
- `README.md` (modified — add skill documentation)

## Steps

### Step 1: Research and Analyze Skill Patterns

- [ ] Study existing high-quality skills (agent-browser, find-skills) for structure
- [ ] Review the pi extension tools to understand current Fusion capabilities
- [ ] Identify gaps between what agents can do and what they should know about Fusion

**Artifacts:**
- `~/.agents/skills/fusion/references/skill-patterns.md` — Analysis of good skill patterns
- `~/.agents/skills/fusion/references/fusion-capabilities.md` — Catalog of Fusion features

### Step 2: Design Fusion Skill Structure

- [ ] Define the skill's purpose, triggers, and scope
- [ ] Create the SKILL.md router pattern structure
- [ ] Design workflows for common Fusion interactions
- [ ] Decide on `allowed-tools` frontmatter (likely not needed since Fusion uses pi extension, not Bash CLI)
- [ ] Define when agents should use Fusion vs direct tools

**Artifacts:**
- `~/.agents/skills/fusion/SKILL.md` (new — main skill file with router structure)

### Step 3: Implement Core SKILL.md

- [ ] Write skill frontmatter with proper YAML format (opening `---`, fields, closing `---`)
- [ ] Create the routing section that directs to appropriate workflows
- [ ] Write the "When to Use This Skill" section
- [ ] Document Fusion concepts (tasks, columns, triage, workflow)
- [ ] Follow pure XML structure (no markdown headings in body)

**Artifacts:**
- `~/.agents/skills/fusion/SKILL.md` (modified — complete main skill content)

### Step 4: Create Task Management Workflows

- [ ] Create workflow: Creating and managing tasks
- [ ] Create workflow: Understanding task lifecycle

**Artifacts:**
- `~/.agents/skills/fusion/workflows/task-management.md` (new)
- `~/.agents/skills/fusion/workflows/task-lifecycle.md` (new)

### Step 5: Create Technical Workflows

- [ ] Create workflow: Working with task specifications (PROMPT.md)
- [ ] Create workflow: Dashboard and CLI usage patterns

**Artifacts:**
- `~/.agents/skills/fusion/workflows/specifications.md` (new)
- `~/.agents/skills/fusion/workflows/dashboard-cli.md` (new)

### Step 6: Create Reference Documentation

- [ ] Document all Fusion CLI commands
- [ ] Document task file structure (.fusion/tasks/)
- [ ] Document extension tools available to agents
- [ ] Document best practices for working with Fusion

**Artifacts:**
- `~/.agents/skills/fusion/references/cli-commands.md` (new)
- `~/.agents/skills/fusion/references/task-structure.md` (new)
- `~/.agents/skills/fusion/references/extension-tools.md` (new)
- `~/.agents/skills/fusion/references/best-practices.md` (new)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Validate SKILL.md file exists at correct path `~/.agents/skills/fusion/SKILL.md`
- [ ] Validate YAML frontmatter format (correct opening/closing `---` delimiters)
- [ ] Validate XML structure in body (no markdown headings #, ##, ###)
- [ ] Validate all referenced workflow files exist
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`

### Step 8: Documentation & Delivery

- [ ] Update README.md with skill documentation
- [ ] Add skill to AGENTS.md if relevant
- [ ] Create follow-up task if extension.ts tool updates are needed
- [ ] Verify skill is accessible at `~/.agents/skills/fusion/`

## Documentation Requirements

**Must Update:**
- `README.md` — Add section about Fusion skill under "Skills" or "Documentation"
- `~/.agents/skills/fusion/SKILL.md` — Complete skill documentation

**Check If Affected:**
- `AGENTS.md` — Update if skill changes agent workflows
- `packages/cli/src/extension.ts` — Update tool descriptions if they need clarification

## Completion Criteria

- [ ] Fusion skill exists at `~/.agents/skills/fusion/SKILL.md`
- [ ] Skill follows the router pattern with proper XML structure
- [ ] Skill includes workflows for common Fusion tasks
- [ ] Skill references are complete and accurate
- [ ] SKILL.md has valid YAML frontmatter with correct delimiters
- [ ] All workflow files are created and referenced correctly
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-328): complete Step N — description`
- **Bug fixes:** `fix(KB-328): description`
- **Tests:** `test(KB-328): description`

## Do NOT

- Modify the core Fusion engine logic
- Remove or change existing pi extension tools
- Create skills in the wrong location (must be at `~/.agents/skills/`)
- Skip the skill router pattern structure
- Use markdown headings (#, ##, ###) in skill body - use XML tags instead
- Make the skill dependent on external resources that may not exist
- Test using public skills registry (skill won't be published there)

## Testing Requirements

The skill must be tested locally to ensure:
1. SKILL.md file exists at `~/.agents/skills/fusion/SKILL.md`
2. YAML frontmatter has correct opening and closing `---` delimiters
3. Body uses pure XML structure (no markdown headings)
4. All referenced workflow files exist at their specified paths
5. All tests in `pnpm test` pass
6. Build with `pnpm build` completes successfully

## Skill Frontmatter Format

Follow this exact format for the SKILL.md frontmatter:

```yaml
---
name: fusion
description: AI-orchestrated task board (Fusion/kb) interface. Use when working with the Fusion task management system, creating or managing tasks, understanding task workflows, or interfacing with the kb dashboard.
---
```

Note: `allowed-tools` is not included because Fusion provides tools via the pi extension registration, not through Bash CLI commands like agent-browser.

## Notes on Skill Patterns

Reference skills like `agent-browser` and `find-skills` demonstrate:
- Clear skill triggers (when to use)
- Structured workflows (how to use)
- Tool integration (what tools are available)
- Progressive disclosure (loading details when needed)
- Proper YAML frontmatter with `---` delimiters
- XML structure in body (not markdown headings)

Apply these patterns to the Fusion skill.
