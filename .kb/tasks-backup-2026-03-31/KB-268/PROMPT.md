# Task: KB-268 - Add Workflow Step Templates

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused feature adding pre-defined workflow step templates on top of the workflow step infrastructure. It requires API endpoint, template definitions, and UI integration, but follows straightforward patterns from existing code.

**Score:** 3/8 — Blast radius: 1 (single feature area), Pattern novelty: 0 (follows existing CRUD patterns), Security: 1 (user-selectable templates), Reversibility: 1 (additive only)

## Mission

Add pre-defined workflow step templates that users can add with one click instead of creating from scratch. Templates include common quality gates like "Documentation Review", "QA Check", and "Security Audit". Each template comes with a pre-crafted prompt that can be used as-is or customized after creation.

**Key capabilities:**
1. **Built-in templates** — Define common workflow step templates with high-quality prompts
2. **One-click creation** — Users can add a template to their workflow steps instantly
3. **Customizable after creation** — Templates are copied as editable workflow steps
4. **Template gallery UI** — Browse templates in the Workflow Step Manager

## Dependencies

- **Task:** KB-218 (Add Global Workflow Steps for Post-Implementation Review) — The workflow step infrastructure (types, store methods, API routes, and UI manager) must be complete before implementing templates

## Context to Read First

### Workflow Step Infrastructure (from KB-218)
- `packages/core/src/types.ts` — `WorkflowStep` and `WorkflowStepInput` interfaces
- `packages/core/src/store.ts` — `createWorkflowStep`, `listWorkflowSteps` methods
- `packages/dashboard/src/routes.ts` — Workflow step API endpoints (GET, POST, PATCH, DELETE)

### Template Patterns to Follow
- `packages/core/src/types.ts` — `ModelPreset` interface shows a template pattern with id, name, and optional fields
- `packages/dashboard/app/components/SettingsModal.tsx` — Shows pattern for managing reusable configurations

### UI Component Patterns
- `packages/dashboard/app/components/WorkflowStepManager.tsx` — Where templates UI will be integrated
- `packages/dashboard/app/api.ts` — Frontend API client patterns for workflow steps

## File Scope

### Core Types (if not added by KB-218)
- `packages/core/src/types.ts` (modified) — Add `WorkflowStepTemplate` interface

### API Layer
- `packages/dashboard/src/routes.ts` (modified) — Add GET `/api/workflow-step-templates` endpoint
- `packages/dashboard/src/routes.test.ts` (modified) — Add tests for template endpoint

### UI Components
- `packages/dashboard/app/components/WorkflowStepManager.tsx` (modified) — Add templates section with "Add from Template" functionality
- `packages/dashboard/app/components/WorkflowStepManager.test.tsx` (modified) — Add tests for template UI
- `packages/dashboard/app/api.ts` (modified) — Add `fetchWorkflowStepTemplates()` and `createWorkflowStepFromTemplate()` functions

### Documentation
- `AGENTS.md` (modified) — Document available workflow step templates

## Steps

### Step 1: Define Workflow Step Templates

Create the template definitions and types for built-in workflow step templates.

- [ ] Add `WorkflowStepTemplate` interface to `packages/core/src/types.ts` (if not present from KB-218):
  ```typescript
  export interface WorkflowStepTemplate {
    id: string;                    // Unique template identifier (e.g., "doc-review")
    name: string;                  // Display name (e.g., "Documentation Review")
    description: string;             // Short description for UI
    prompt: string;                // Full agent prompt template
    category: string;              // Grouping category (e.g., "Quality", "Security")
    icon?: string;                 // Optional icon identifier for UI
  }
  ```

- [ ] Define built-in templates array in `packages/core/src/types.ts`:
  ```typescript
  export const WORKFLOW_STEP_TEMPLATES: WorkflowStepTemplate[] = [
    {
      id: "documentation-review",
      name: "Documentation Review",
      description: "Verify all public APIs, functions, and complex logic have appropriate documentation",
      category: "Quality",
      icon: "file-text",
      prompt: `You are a documentation reviewer. Review the completed task and verify documentation quality.

Review Criteria:
1. All new public functions, classes, and modules have JSDoc comments or equivalent documentation
2. Complex logic has inline comments explaining the "why" not just the "what"
3. README files are updated if the task changes user-facing behavior
4. CHANGELOG or release notes are considered for significant changes
5. Type definitions are documented for public APIs

Files to Review:
- Review all files modified in the task worktree
- Focus on public API surface area
- Check test files for test documentation

Output Requirements:
- If documentation is adequate: call task_done() with success status
- If documentation is missing: list specific files and functions that need documentation using task_log()
- Provide specific suggestions for what documentation should be added`,
    },
    {
      id: "qa-check",
      name: "QA Check",
      description: "Run tests and verify they pass, check for obvious bugs",
      category: "Quality",
      icon: "check-circle",
      prompt: `You are a QA tester. Verify the task implementation by running tests and checking for bugs.

Test Execution:
1. Run the project's test suite (use pnpm test, npm test, or the configured test command)
2. Verify all tests pass
3. If tests fail, analyze whether failures are related to the task changes

Code Review:
1. Review the changes for obvious bugs or edge cases
2. Check error handling is appropriate
3. Verify input validation is present where needed
4. Look for common issues: null pointer risks, off-by-one errors, race conditions

Output Requirements:
- If all tests pass and no bugs found: call task_done() with success status
- If tests fail: provide detailed failure information via task_log()
- If bugs are found: describe the bug, affected files, and suggested fix via task_log()`,
    },
    {
      id: "security-audit",
      name: "Security Audit",
      description: "Check for common security vulnerabilities and anti-patterns",
      category: "Security",
      icon: "shield",
      prompt: `You are a security auditor. Review the task changes for common security vulnerabilities.

Security Checklist:
1. **Injection vulnerabilities** — Check for SQL injection, command injection, XSS via unsanitized user input
2. **Secrets and credentials** — Ensure no hardcoded passwords, API keys, tokens, or private keys
3. **Unsafe eval** — Check for eval(), new Function(), or similar dangerous patterns
4. **Path traversal** — Verify file path handling prevents directory traversal attacks
5. **Insecure deserialization** — Check for unsafe parsing of untrusted data
6. **Authentication/Authorization** — Verify access controls are properly implemented
7. **Dependency risks** — Note any new dependencies that might have known vulnerabilities

Files to Review:
- All modified files in the task
- Configuration files that might contain secrets
- Areas handling user input or external data

Output Requirements:
- If no security issues found: call task_done() with success status
- If issues found: describe each vulnerability with specific file paths, line numbers, and severity via task_log()
- Provide remediation suggestions for each issue`,
    },
    {
      id: "performance-review",
      name: "Performance Review",
      description: "Check for performance anti-patterns and optimization opportunities",
      category: "Quality",
      icon: "zap",
      prompt: `You are a performance reviewer. Analyze the task changes for performance implications.

Performance Checklist:
1. **Algorithmic complexity** — Check for O(n²) or worse patterns that could bottleneck
2. **N+1 queries** — Look for database queries in loops
3. **Memory leaks** — Check for unclosed resources, event listeners, or accumulating caches
4. **Unnecessary re-renders** — For UI code, check for inefficient React/Angular/Vue patterns
5. **Bundle size** — Note if large dependencies are added unnecessarily
6. **Async patterns** — Verify proper use of async/await, Promise.all for parallel work
7. **Caching opportunities** — Identify where caching could improve performance

Files to Review:
- All modified files, focusing on hot paths and frequently executed code
- Database query files
- API endpoints and route handlers

Output Requirements:
- If performance is acceptable: call task_done() with success status
- If issues found: describe each issue with specific file paths and suggested optimizations via task_log()`,
    },
    {
      id: "accessibility-check",
      name: "Accessibility Check",
      description: "Verify UI changes meet accessibility standards (WCAG 2.1)",
      category: "Quality",
      icon: "eye",
      prompt: `You are an accessibility reviewer. Check UI changes for WCAG 2.1 compliance.

Accessibility Checklist:
1. **Keyboard navigation** — Ensure all interactive elements are keyboard accessible
2. **ARIA labels** — Check that screen reader announcements are appropriate
3. **Color contrast** — Verify text meets minimum contrast ratios (4.5:1 for normal text)
4. **Focus indicators** — Ensure visible focus states for keyboard navigation
5. **Alt text** — Check that images have meaningful alternative text
6. **Form labels** — Verify all inputs have associated labels
7. **Semantic HTML** — Check that proper HTML elements are used (buttons not divs)

Files to Review:
- Modified UI components
- CSS/styling changes
- New HTML templates or JSX

Output Requirements:
- If accessibility requirements are met: call task_done() with success status
- If issues found: describe each issue with specific file paths, WCAG guideline references, and remediation steps via task_log()`,
    },
  ];
  ```

- [ ] Export templates from `packages/core/src/index.ts` if needed

**Artifacts:**
- `packages/core/src/types.ts` (modified — adds template interface and definitions)
- `packages/core/src/index.ts` (modified — exports)

### Step 2: Add Templates API Endpoint

Add API endpoint to fetch available workflow step templates.

- [ ] Add GET `/api/workflow-step-templates` endpoint to `packages/dashboard/src/routes.ts`:
  - Returns the `WORKFLOW_STEP_TEMPLATES` array
  - No authentication required (read-only)
  - Response: `{ templates: WorkflowStepTemplate[] }`

- [ ] Add POST `/api/workflow-step-templates/:id/create` endpoint:
  - Takes template ID as URL parameter
  - Looks up template in `WORKFLOW_STEP_TEMPLATES`
  - Calls `store.createWorkflowStep()` with template data
  - Returns created workflow step
  - Error: 404 if template ID not found

- [ ] Write tests in `packages/dashboard/src/routes.test.ts`:
  - GET /workflow-step-templates returns all templates
  - POST /workflow-step-templates/:id/create creates workflow step from template
  - POST returns 404 for non-existent template ID
  - Created workflow step has correct name, description, and prompt from template

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 3: Add Frontend API Functions

Add frontend API client functions for workflow step templates.

- [ ] Add to `packages/dashboard/app/api.ts`:
  ```typescript
  export function fetchWorkflowStepTemplates(): Promise<WorkflowStepTemplate[]> {
    return api<WorkflowStepTemplate[]>("/workflow-step-templates");
  }

  export function createWorkflowStepFromTemplate(templateId: string): Promise<WorkflowStep> {
    return api<WorkflowStep>(`/workflow-step-templates/${encodeURIComponent(templateId)}/create`, {
      method: "POST",
    });
  }
  ```

- [ ] Add imports for `WorkflowStepTemplate` type from `@kb/core`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Add Templates UI to Workflow Step Manager

Add a templates section to the WorkflowStepManager component for one-click template creation.

- [ ] Modify `packages/dashboard/app/components/WorkflowStepManager.tsx`:
  - Add "Templates" tab or section alongside existing workflow step list
  - Add state for templates: `templates: WorkflowStepTemplate[]`
  - Fetch templates on component mount using `fetchWorkflowStepTemplates()`
  - Display templates as cards with:
    - Icon (use Lucide icons mapped from template.icon)
    - Name (bold)
    - Description (gray text)
    - Category badge (e.g., "Quality", "Security")
    - "Add" button

- [ ] Add template card component (inline or separate):
  - Visual card layout with icon, name, description
  - Category badge color-coded (Quality = blue, Security = red, etc.)
  - "Add" button creates workflow step from template
  - Show loading state during creation
  - On success: refresh workflow steps list and show success toast

- [ ] Add empty state if no templates available:
  - "No templates available" message

- [ ] Handle template creation:
  - Call `createWorkflowStepFromTemplate(templateId)`
  - On success: 
    - Refresh workflow steps list
    - Show success toast: "Added {templateName} workflow step"
    - Optionally switch to "My Workflow Steps" tab
  - On error: show error toast with message

- [ ] Write tests in `packages/dashboard/app/components/WorkflowStepManager.test.tsx`:
  - Templates section renders with template cards
  - Clicking "Add" on template creates workflow step
  - Created workflow step appears in the workflow steps list
  - Error handling shows toast on creation failure

**Artifacts:**
- `packages/dashboard/app/components/WorkflowStepManager.tsx` (modified)
- `packages/dashboard/app/components/WorkflowStepManager.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Build all packages: `pnpm build`
- [ ] All tests must pass
- [ ] Manual verification:
  - Open Workflow Step Manager in dashboard
  - Verify templates section displays all 5 templates
  - Click "Add" on "Documentation Review" template
  - Verify new workflow step appears in list with correct name/prompt
  - Verify template prompt is fully copied (not truncated)

**Artifacts:**
- All test files with passing tests
- No TypeScript errors
- Successful build

### Step 6: Documentation & Delivery

- [ ] Update `AGENTS.md`:
  - Add "Workflow Step Templates" section documenting available templates
  - Describe how users can add templates with one click
  - List each built-in template and its purpose

- [ ] Create changeset file:
  ```bash
  cat > .changeset/add-workflow-step-templates.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add workflow step templates for common quality gates. Users can now add pre-defined workflow steps (Documentation Review, QA Check, Security Audit, Performance Review, Accessibility Check) with one click instead of creating from scratch.
  EOF
  ```

**Artifacts:**
- `AGENTS.md` (modified)
- `.changeset/add-workflow-step-templates.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Document available workflow step templates and how to use them

**Check If Affected:**
- `README.md` — Add workflow step templates to feature list if workflow steps are documented there

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Typecheck clean (`pnpm typecheck`)
- [ ] Build successful (`pnpm build`)
- [ ] GET `/api/workflow-step-templates` returns all 5 built-in templates
- [ ] POST `/api/workflow-step-templates/:id/create` creates workflow step from template
- [ ] Templates UI visible in Workflow Step Manager
- [ ] One-click template creation works end-to-end
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-268): complete Step N — description`
- **Bug fixes:** `fix(KB-268): description`
- **Tests:** `test(KB-268): description`

## Do NOT

- Skip tests for template UI and API
- Allow templates to be edited directly (templates are immutable; create copies)
- Add user-defined templates in this task (future enhancement)
- Skip documentation updates
- Create changeset for internal-only changes
- Modify the template definitions after initial creation (treat as immutable)

## Icon Mapping for Templates

Use Lucide React icons mapped from template.icon field:
- `file-text` → `FileText` icon
- `check-circle` → `CheckCircle` icon
- `shield` → `Shield` icon
- `zap` → `Zap` icon
- `eye` → `Eye` icon

## Template Categories

Category colors for UI badges:
- **Quality** — Blue badge (bg-blue-100 text-blue-800)
- **Security** — Red badge (bg-red-100 text-red-800)

Future categories could include:
- **Compliance** — Green badge
- **Performance** — Yellow badge
- **Accessibility** — Purple badge
