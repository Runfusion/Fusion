<div align="center">

<img src="https://raw.githubusercontent.com/Runfusion/Fusion/main/demo/assets/fusion-logo.png" alt="Fusion" width="120" />

# @runfusion/fusion

### From rough idea to production code — automatically.

**Multi-node agent orchestrator** — tasks, agents, missions, git, files, and worktrees, with any model, local or cloud.

[**runfusion.ai →**](https://runfusion.ai) · [GitHub](https://github.com/Runfusion/Fusion) · [Docs](https://github.com/Runfusion/Fusion#readme)

<br />

<img src="https://raw.githubusercontent.com/Runfusion/Fusion/main/demo/assets/fusion-reel.gif" alt="Fusion reel: from rough idea to production code" width="900" />

</div>

---

## Install

**Zero install, straight from npm:**

```bash
npx runfusion.ai
```

Boots the dashboard. Subcommands forward through (`npx runfusion.ai task list`, etc). Long form: `npx @runfusion/fusion dashboard`.

**One-line installer** (macOS & Linux — auto-picks Homebrew, falls back to npm):

```bash
curl -fsSL https://runfusion.ai/install.sh | sh
```

**Homebrew** (macOS & Linux):

```bash
brew tap runfusion/fusion
brew install fusion
```

Or as a one-liner: `brew install runfusion/fusion/fusion`.

**npm global**:

```bash
npm install -g @runfusion/fusion
fn dashboard              # or: fusion dashboard
```

As a [pi](https://github.com/badlogic/pi-mono) extension (bundled skill + `/fn` command):

```bash
pi install npm:@runfusion/fusion
```

## Launch the dashboard

Inside a pi session:

```
/fn              # start on default port 4040
/fn stop         # stop it
/fn 8080         # run on a custom port
```

From a shell:

```bash
fn dashboard                 # or: fusion dashboard / npx @runfusion/fusion dashboard
fn dashboard --paused        # start with automation paused
fn dashboard --dev           # web UI only, no AI engine
```

The dashboard gives you:

- **A live kanban board** — tasks move through columns automatically as AI works on them
- **Task detail view** — generated spec, step-by-step progress, reviewer verdicts, full execution log
- **Dependency-aware scheduling** — declare task dependencies or let the engine infer them
- **Auto-merge** — on by default; reviewed work squash-merges without you lifting a finger
- **Parallel execution** — independent tasks run simultaneously in isolated git worktrees
- **Self-sustaining board** — agents may spawn follow-up tasks; the board feeds itself

---

## Your entire dev environment. On a single pane of glass.

Describe a task in plain language. A triage agent reads your project, understands context, and writes a full `PROMPT.md` spec — steps, file scope, acceptance criteria. Then Fusion plans, reviews, executes, and reviews again, in an isolated git worktree, with a human approval gate wherever you want one.

One board. Controlled from anywhere. Laptop, Mac mini, Linux server, cloud VM, phone — all connected.

<div align="center">
  <img src="https://raw.githubusercontent.com/Runfusion/Fusion/main/demo/assets/fusion-mesh.gif" alt="Fusion mesh: laptop, Mac mini, Linux server, cloud VM, phone — all synced" width="820" />
</div>

---

## Run an agent company

Import a team. Run it autonomously for weeks. **440+ agents across 16 companies**, wired for missions, mailboxes, and inter-agent delegation.

```bash
npx companies.sh add paperclipai/companies/gstack
```

<div align="center">
  <img src="https://raw.githubusercontent.com/Runfusion/Fusion/main/demo/assets/fusion-company-reel.gif" alt="Fusion agent company: import a team, run it autonomously for weeks" width="820" />
</div>

---

## How it works

You create a task with a rough description. A pipeline of specialized agents takes over.

**Specification.** A triage agent reads your codebase — file structure, existing patterns, related code — and turns your rough idea into a detailed spec. It breaks the work into discrete steps, identifies which files are in scope, writes acceptance criteria, and assigns a complexity rating that determines how aggressively the work gets reviewed.

**Scheduling.** Tasks declare dependencies on each other. The scheduler builds a dependency graph and starts work only when upstream tasks are done. Independent tasks run in parallel — each in its own isolated git worktree, so there are no conflicts during execution.

**Execution & review.** An executor agent works through the spec step by step in the worktree. At each step boundary, a separate reviewer agent, with read-only access, independently evaluates the work. The reviewer can approve (continue), request revisions (fix specific issues), or force a rethink (change the approach entirely). Review depth scales with the task's complexity rating: trivial tasks get light checks, complex tasks get thorough multi-pass review.

**Merge.** When execution finishes and the reviewer signs off, the task moves to **In Review**:

- **Direct merge** *(default)* — automatically squash-merges the completed task branch into your current branch with a clean commit.
- **Pull request** — automatically creates or links a GitHub PR, waits for reviews/checks, then merges once policy conditions are satisfied.

`autoMerge` controls whether Fusion performs completion automatically. If disabled, tasks stay in **In Review** until you finish the merge yourself. For PR-first mode, authenticate GitHub with `gh auth login`.

Tasks flow through: **Triage → Todo → In Progress → In Review → Done**.

This execution model is heavily based on [Taskplane](https://www.npmjs.com/package/taskplane).

---

## What makes it different

|  |  |
|---|---|
| 🧠 **AI specification** | Rough idea in, detailed `PROMPT.md` out — steps, file scope, acceptance criteria. |
| 🔁 **Workflow gates** | Plan → Review → Execute → Review on every step. Block or pass automatically. |
| 🌳 **Worktree isolation** | Each task runs in its own branch and worktree. Parallel tasks. Zero conflicts. |
| ⚡ **Smart merge** | Passing every gate? Fusion squash-merges and moves on. |
| 🛰️ **Multi-node mesh** | Laptop, server, cloud, phone — all synced. Desktop, mobile, web. |
| 🧩 **Any model** | Anthropic, OpenAI, Ollama — or anything pi-compatible. |
| 🏢 **Agent companies** | Import pre-built teams — 440+ agents across 16 companies. |
| 📬 **Inter-agent messaging** | Built-in mailbox between agents. Delegate, clarify, coordinate. |
| 🗺️ **Missions** | Hierarchical planning with autopilot and validation contracts. |
| 🔓 **Open source. MIT.** | No vendor lock-in. Run it on your own hardware. |

---

## Working from chat

Manage tasks without leaving the conversation:

> "Every ten minutes, analyze the server code for logic the client hasn't implemented yet and create tasks. Tasks may spawn additional tasks, so just add enough to keep the board saturated."

> "Create a Fusion task to fix the login redirect bug"

> "Add a task for dark mode support, it depends on FN-003"

> "What's the status of FN-042"

> "Attach screenshot.png to FN-007"

> "Pause FN-012 — I want to add more context first"

The pi extension exposes tools to create tasks, check progress, attach files, and pause or resume automation.

---

## Standalone CLI

Fusion also works as a standalone CLI outside of pi. See [STANDALONE.md](./STANDALONE.md) for installation and usage without the pi extension.

## Full documentation

Architecture details, development setup, and contributor info live in the [project README](https://github.com/Runfusion/Fusion#readme).

## License

MIT — see [LICENSE](https://github.com/Runfusion/Fusion/blob/main/LICENSE).

<div align="center">

**[runfusion.ai →](https://runfusion.ai)**

</div>
