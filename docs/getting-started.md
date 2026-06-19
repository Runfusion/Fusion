# Getting Started

[← Docs index](./README.md)

This guide walks you from install to your first task in Fusion.

## Install Fusion

Choose one of these install methods from the [README quick start](../README.md#quick-start):

### Zero install (recommended)

Run Fusion directly from npm without a global install:

```bash
npx runfusion.ai
```

This launches the dashboard immediately. You can also run subcommands the same way (for example, `npx runfusion.ai task create "fix X"`).

### One-line installer (macOS & Linux)

```bash
curl -fsSL https://runfusion.ai/install.sh | sh
fusion dashboard
```

### Homebrew (macOS & Linux)

```bash
brew tap runfusion/fusion
brew install fusion
fusion dashboard            # or: fn dashboard
```

### npm global

```bash
npm install -g @runfusion/fusion
fn dashboard                # or: fusion dashboard
```

### From source (development)

```bash
pnpm dev dashboard
```

After installing, verify the CLI is available:

```bash
fn --help
# or
fusion --help
```

### Troubleshooting `fn update`

If `fn update` fails with an npm bin-link collision (for example `EEXIST` / `File exists` mentioning `fn` or `fusion`), Fusion now retries once with `--force` automatically.

If update still fails, run the manual recovery commands:

```bash
npm uninstall -g runfusion.ai
rm -f $(command -v fn) $(command -v fusion)
npm install -g @runfusion/fusion@latest
```

If you installed via Homebrew and links are still broken, reinstall the formula:

```bash
brew uninstall fusion && brew install runfusion/tap/fusion
```

## Initialize a Project

In each repository you want Fusion to manage, run:

```bash
fn init
```

On fresh init, Fusion also installs its bundled `fusion` skill into supported agent homes (`~/.claude/skills/fusion`, `~/.codex/skills/fusion`, `~/.gemini/skills/fusion`) when those targets are missing. Existing installs are left untouched.

## First Run and Onboarding

Start the dashboard:

```bash
fn dashboard
```

On first launch, Fusion opens an onboarding wizard with three steps:

1. **AI Setup** — choose a provider and authenticate (you only need one to start). Anthropic/Claude and OpenAI Codex use a pasted authorization-code OAuth flow in onboarding and Settings (sign in, then paste the final redirect URL or code back into Fusion), and Fusion warns before login so you remember to copy the browser address bar URL before the redirect tab appears to fail. After the initial Claude OAuth login, Fusion normally refreshes the OAuth credential automatically with the stored refresh token when the access token expires, so repeated manual re-login is not usually required. **Anthropic — via Claude CLI** remains available as a separate optional path. Deprecated Google Gemini CLI / Antigravity entries are hidden; Google/Gemini API key, Google Generative AI, Vertex, and Cloud Code options remain available.
2. **GitHub (Optional)** — connect GitHub for issue import and PR workflows
3. **First Task** — create your first task or import one from GitHub

The wizard is dismissible and non-blocking. You can skip it and continue using Fusion, then reopen it later from **Settings → Authentication**.

If a provider login gets stuck in progress (for example GitHub Copilot/device-code sign-in), use **Cancel** on the provider card in onboarding or in **Settings → Authentication**, then retry immediately — no dashboard restart is required.

On startup, Fusion prints an `Open:` URL that includes a bearer token (for example, `http://localhost:4040/?token=fn_...`). Open that URL to sign in quickly.

## Create Your First Task

Create tasks from the board or CLI.

### Option A: Quick Entry (Board)

1. Type a short request in the quick entry input.
2. Press Enter.
3. Task appears in **Planning** and the planning agent generates `PROMPT.md`.

### Option B: Plan Mode (Board)

Use the 💡 button to open AI planning mode:

- Fusion asks clarifying questions
- Produces a structured summary
- Lets you create one task or multiple dependency-linked tasks

### Option C: Subtask Breakdown (Board)

Use the 🌳 button to generate 2–5 subtasks, reorder them, and link dependencies before creating tasks.

You can also use expanded board controls (Refine, Deps, Attachments, model overrides, agent assignment, and workflow selection) or the CLI (`fn task create`, `fn task plan`) when needed.

## Choose a Workflow

Most tasks can use the default **Coding** workflow. When the workflow selector is visible on a task or board creation surface, choose a different workflow if the work needs a shorter path, extra review, stepwise execution, Compound Engineering skills, or a custom policy your project authored.

Built-ins include task-selectable Coding, Quick fix, Review-heavy, plugin-gated Compound engineering, and Stepwise coding workflows, plus PR lifecycle fragments for workflow authors. For the full catalog and runtime behavior, see [Workflow Steps](./workflow-steps.md#workflow-overview). To inspect built-ins or author custom workflows, open the dashboard [Workflow Editor](./workflow-editor.md).

## Understand the Task Lifecycle

Fusion uses six default lifecycle columns:

1. **Planning** — raw idea; AI writes plan
2. **Todo** — planned and queued
3. **In Progress** — executor implements in a dedicated worktree
4. **In Review** — implementation complete, awaiting merge/finalization
5. **Done** — merged and complete
6. **Archived** — retained for history, optionally cleaned up from filesystem

Custom workflows can define their own graph policy, typed settings, fields, and (when workflow columns are enabled) column behavior. The default columns remain the baseline mental model for ordinary coding tasks.

## Daily CLI Commands

```bash
fn task list
fn task show FN-001
fn task logs FN-001 --follow --limit 50
fn task steer FN-001 "Prefer existing utility functions"
fn task pause FN-001
fn task unpause FN-001
```

## Next Steps

- [Architecture](./architecture.md) — system internals and package layout
- [Task Management](./task-management.md) — deeper task workflow and lifecycle details
- [Dashboard Guide](./dashboard-guide.md) — board, workflow editor, chat, and UI features
- [Workflow Steps](./workflow-steps.md) — built-in workflows and execution semantics
- [Workflow Editor](./workflow-editor.md) — visual workflow authoring
- [Settings Reference](./settings-reference.md) — project, global, and workflow configuration
