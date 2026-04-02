# Task: KB-293 - Paperclip Integration - Import/Export and companies.sh Standard

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Integration task connecting kb's agent system to the Paperclip ecosystem. Moderate blast radius affecting CLI commands and agent serialization formats. New code patterns for data transformation with validation requirements. Reversible via deletion of import/export functionality.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Implement Paperclip-compatible import/export functionality and companies.sh standard support for kb's agent system. This enables interoperability with the Paperclip ecosystem — an open-source orchestration system for agent companies.

**Paperclip Format:** Paperclip uses a declarative YAML-based format for defining "agent companies" (multi-agent systems). An agent company consists of:
- Company manifest (name, version, description)
- Agent definitions (name, role, capabilities, configuration)
- Relationships between agents (supervision, collaboration)

**companies.sh Standard:** A lightweight shell-script-based manifest format for agent portability. The standard defines:
- `COMPANY_NAME` — identifier for the agent company
- `AGENT_MANIFEST` — base64-encoded JSON array of agent definitions
- Environment variable-based configuration for portability

**Key Capabilities:**
1. **Import from Paperclip** — Convert Paperclip YAML agent definitions to kb Agent records
2. **Export to Paperclip** — Export kb agents to Paperclip-compatible YAML format
3. **companies.sh support** — Generate and parse companies.sh manifest files
4. **Cross-platform portability** — Agent definitions that work across different agent systems

## Dependencies

- **Task:** KB-283 (AgentStore and agent types — must provide Agent, AgentCreateInput types)

## Context to Read First

**Existing Agent Types (KB-283):**
- `packages/core/src/types.ts` — Agent, AgentState, AgentCapability, AgentCreateInput, AgentHeartbeatEvent types
- `packages/core/src/agent-store.ts` — AgentStore class with CRUD operations

**CLI Pattern Reference:**
- `packages/cli/src/bin.ts` — Command registration pattern
- `packages/cli/src/commands/task.ts` — Command implementations with TaskStore
- `packages/cli/src/commands/` — Command directory structure

**Paperclip Format Reference:**
Paperclip uses YAML files with this structure:
```yaml
# company.yaml
name: my-agent-company
version: "1.0.0"
description: A company of specialized agents
agents:
  - name: Code Reviewer
    role: reviewer
    capabilities: ["code-review", "security-audit"]
    config:
      model: claude-sonnet-4
      max_tokens: 4096
  - name: Task Executor
    role: executor
    capabilities: ["task-execution", "file-modification"]
    config:
      model: gpt-4o
```

## File Scope

**New Files:**
- `packages/core/src/paperclip.ts` — Paperclip types, schemas, and conversion utilities
- `packages/core/src/paperclip.test.ts` — Unit tests for conversion functions
- `packages/cli/src/commands/agent.ts` — CLI commands for agent import/export
- `packages/cli/src/paperclip-importer.ts` — Import logic from Paperclip format
- `packages/cli/src/paperclip-exporter.ts` — Export logic to Paperclip format
- `packages/cli/src/companies-sh.ts` — companies.sh manifest parser and generator

**Modified Files:**
- `packages/cli/src/bin.ts` — Add `agent import` and `agent export` commands
- `packages/core/src/index.ts` — Export Paperclip types and utilities

## Steps

### Step 1: Paperclip Type Definitions

- [ ] Create `packages/core/src/paperclip.ts` with Paperclip format types
- [ ] Define `PaperclipCompany` interface (name, version, description, agents[])
- [ ] Define `PaperclipAgent` interface (name, role, capabilities, config)
- [ ] Define `PaperclipConfig` interface (model, maxTokens, temperature, etc.)
- [ ] Define `CompaniesShManifest` interface for companies.sh standard
- [ ] Create conversion functions: `kbAgentToPaperclip()`, `paperclipToKbAgent()`
- [ ] Handle role mapping: Paperclip roles → kb AgentCapability
- [ ] Handle capability mapping: Paperclip capabilities → kb metadata
- [ ] Add Zod or similar validation schemas for Paperclip format
- [ ] Run targeted tests for type compilation (`pnpm typecheck`)

**Artifacts:**
- `packages/core/src/paperclip.ts` (new)

### Step 2: Import/Export Logic

- [ ] Create `packages/cli/src/paperclip-importer.ts`
- [ ] Implement `importPaperclipCompany(yamlPath, options)` function
- [ ] Parse YAML, validate against Paperclip schema
- [ ] Convert Paperclip agents to kb AgentCreateInput objects
- [ ] Handle duplicate agent names (append number or throw error based on options)
- [ ] Create `packages/cli/src/paperclip-exporter.ts`
- [ ] Implement `exportAgentsToPaperclip(agentIds, outputPath)` function
- [ ] Convert kb agents to Paperclip format
- [ ] Generate YAML output with proper formatting
- [ ] Handle agent selection (all agents, by role, or specific IDs)
- [ ] Run targeted tests for import/export logic

**Artifacts:**
- `packages/cli/src/paperclip-importer.ts` (new)
- `packages/cli/src/paperclip-exporter.ts` (new)

### Step 3: companies.sh Standard Support

- [ ] Create `packages/cli/src/companies-sh.ts`
- [ ] Implement `parseCompaniesSh(scriptPath)` — parse companies.sh manifest
- [ ] Extract COMPANY_NAME, AGENT_MANIFEST from shell script
- [ ] Decode base64 AGENT_MANIFEST to agent definition array
- [ ] Implement `generateCompaniesSh(companyName, agents, outputPath)`
- [ ] Encode agent definitions as base64 AGENT_MANIFEST
- [ ] Generate portable shell script with embedded manifest
- [ ] Add environment variable substitution support
- [ ] Run targeted tests for companies.sh parsing and generation

**Artifacts:**
- `packages/cli/src/companies-sh.ts` (new)
- `packages/cli/src/companies-sh.test.ts` (new)

### Step 4: CLI Commands

- [ ] Create `packages/cli/src/commands/agent.ts`
- [ ] Implement `agent import` command with options:
  - `<source>` — Path to Paperclip YAML or companies.sh
  - `--format <format>` — Explicit format (paperclip|companies-sh|auto)
  - `--dry-run` — Preview what would be imported without creating
  - `--rename <old:new>` — Rename agents during import
- [ ] Implement `agent export` command with options:
  - `[agent-id...]` — Agent IDs to export (omit for all)
  - `--format <format>` — Output format (paperclip|companies-sh)
  - `--output <path>` — Output file path (default: stdout)
  - `--role <role>` — Filter by role (executor, reviewer, etc.)
- [ ] Add auto-detection of format based on file extension (.yaml/.yml/.sh)
- [ ] Add progress output for batch operations
- [ ] Add error handling with descriptive messages
- [ ] Update `packages/cli/src/bin.ts` to register new commands
- [ ] Run targeted tests for CLI commands

**Artifacts:**
- `packages/cli/src/commands/agent.ts` (new)
- `packages/cli/src/bin.ts` (modified — new command registrations)

### Step 5: Unit Tests

- [ ] Create `packages/core/src/paperclip.test.ts`
- [ ] Test Paperclip → kb agent conversion (all fields mapped correctly)
- [ ] Test kb agent → Paperclip conversion (round-trip integrity)
- [ ] Test role mapping edge cases
- [ ] Test config parameter conversion
- [ ] Test validation (invalid YAML, missing required fields)
- [ ] Create `packages/cli/src/paperclip-importer.test.ts`
- [ ] Test importing from YAML file
- [ ] Test duplicate name handling
- [ ] Test dry-run mode
- [ ] Test error cases (file not found, invalid format)
- [ ] Create `packages/cli/src/paperclip-exporter.test.ts`
- [ ] Test exporting single agent
- [ ] Test exporting multiple agents
- [ ] Test role-based filtering
- [ ] Test YAML output formatting
- [ ] Run all new tests — must pass

**Artifacts:**
- `packages/core/src/paperclip.test.ts` (new)
- `packages/cli/src/paperclip-importer.test.ts` (new)
- `packages/cli/src/paperclip-exporter.test.ts` (new)

### Step 6: Export Integration

- [ ] Update `packages/core/src/index.ts` to export Paperclip types:
  - `PaperclipCompany`, `PaperclipAgent`, `PaperclipConfig`
  - `CompaniesShManifest`
  - Conversion functions: `kbAgentToPaperclip`, `paperclipToKbAgent`
- [ ] Update `packages/cli/src/index.ts` if it exists (or verify CLI exports)
- [ ] Verify all exports compile correctly (`pnpm typecheck`)
- [ ] Run targeted tests

**Artifacts:**
- `packages/core/src/index.ts` (modified — new exports)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — all packages must compile
- [ ] Manual test: Import sample Paperclip YAML → verify agents created
- [ ] Manual test: Export kb agents → verify valid Paperclip YAML generated
- [ ] Manual test: Generate companies.sh → verify script is executable
- [ ] Manual test: Parse companies.sh → verify agents extracted correctly
- [ ] Verify CLI help text for new commands
- [ ] Ensure no TypeScript errors in new or modified files

### Step 8: Documentation & Delivery

- [ ] Add JSDoc comments to all public functions in `paperclip.ts`
- [ ] Add JSDoc comments to import/export functions
- [ ] Document role mapping in code comments (Paperclip → kb)
- [ ] Create changeset for the new feature:
```bash
cat > .changeset/paperclip-integration.md << 'EOF'
---
"@dustinbyrne/kb": minor
"@kb/core": minor
---

Add Paperclip-compatible import/export and companies.sh standard support.
Enables interoperability with Paperclip ecosystem for agent company definitions
and cross-platform agent portability.
EOF
```

## Implementation Details

### Paperclip Format Specification

**Company Manifest (company.yaml):**
```yaml
name: string           # Company identifier (required)
version: string        # Semantic version (required)
description: string    # Human-readable description (optional)
agents:                # Array of agent definitions (required)
  - name: string       # Agent display name (required)
    role: string       # Agent role: triage|executor|reviewer|merger|scheduler|custom (required)
    capabilities:      # Array of capability strings (optional)
      - string
    config:            # Agent-specific configuration (optional)
      model: string    # AI model identifier
      maxTokens: number
      temperature: number
      thinkingLevel: off|minimal|low|medium|high
    metadata:          # Additional key-value pairs (optional)
      key: value
```

### Role Mapping

| Paperclip Role | kb AgentCapability |
|----------------|-------------------|
| triage | triage |
| executor | executor |
| reviewer | reviewer |
| merger | merger |
| scheduler | scheduler |
| custom | custom |
| code-reviewer | reviewer |
| task-executor | executor |
| * (unknown) | custom |

### companies.sh Format

**Structure:**
```bash
#!/bin/bash
# Agent Company Manifest
# Generated by kb Paperclip Integration

COMPANY_NAME="my-company"
AGENT_MANIFEST="ewogICJhZ2VudHMiOiBb..."

# Environment-based configuration
export KB_AGENT_MODEL="${KB_AGENT_MODEL:-claude-sonnet-4}"
export KB_AGENT_TIMEOUT="${KB_AGENT_TIMEOUT:-300}"
```

**AGENT_MANIFEST Encoding:**
- Base64-encoded JSON array of PaperclipAgent objects
- Decoded format: `[{"name":"...","role":"...","capabilities":[...],"config":{...}}]`

### Import Process

1. Detect format (YAML or companies.sh)
2. Parse source file
3. Validate against schema
4. Convert to kb AgentCreateInput
5. Create agents via AgentStore
6. Log results

### Export Process

1. Load agents from AgentStore (by ID or filter)
2. Convert to Paperclip format
3. Generate output (YAML or companies.sh)
4. Write to file or stdout

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Paperclip import creates valid kb agents
- [ ] Paperclip export produces valid YAML
- [ ] companies.sh generation creates executable scripts
- [ ] companies.sh parsing extracts agent definitions
- [ ] CLI commands work with proper help text
- [ ] Changeset file included in commit

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-293): complete Step N — description`
- **Bug fixes:** `fix(KB-293): description`
- **Tests:** `test(KB-293): description`

Example:
```
feat(KB-293): complete Step 1 — add Paperclip type definitions
feat(KB-293): complete Step 2 — implement import/export logic
feat(KB-293): complete Step 3 — add companies.sh support
feat(KB-293): complete Step 4 — add CLI commands
feat(KB-293): complete Step 5 — add unit tests
feat(KB-293): complete Step 6 — export Paperclip types
feat(KB-293): complete Step 8 — add changeset and documentation
```

## Do NOT

- Skip tests — import/export logic needs comprehensive coverage
- Skip validation — always validate Paperclip format before import
- Allow duplicate agent names without explicit handling
- Break existing agent store functionality
- Skip JSDoc comments on public APIs
- Skip the changeset (this is a new feature, needs minor version bump)
- Implement bidirectional sync (out of scope — this is one-time import/export)
- Modify Paperclip's format specification (adapt to it, don't change it)
