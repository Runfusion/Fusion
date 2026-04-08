#!/usr/bin/env node

/**
 * Bootstrap: when running as a bun-compiled binary, the bundled pi-coding-agent
 * reads package.json from the executable's directory at module-init time
 * (top-level `readFileSync` in its config module). We redirect that read to a
 * temp directory containing a minimal package.json so the binary works
 * standalone without any co-located package.json.
 *
 * Node built-ins are safe to import statically — they have no side-effects
 * that depend on package.json. All application imports MUST be dynamic
 * (after the env is configured) so they resolve after PI_PACKAGE_DIR is set.
 */
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// @ts-expect-error -- Bun-only global; undefined in Node
const isBunBinary = typeof Bun !== "undefined" && !!Bun.embeddedFiles;

if (isBunBinary) {
  const execDir = dirname(process.execPath);
  const localPkg = join(execDir, "package.json");

  if (!existsSync(localPkg)) {
    // Write a minimal package.json to a temp dir and redirect PI_PACKAGE_DIR
    const tmp = mkdtempSync(join(tmpdir(), "kb-pkg-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify(
        { name: "kb", version: "0.1.0", type: "module", piConfig: { name: "kb", configDir: ".fusion" } },
        null,
        2,
      ) + "\n",
    );
    process.env.PI_PACKAGE_DIR = tmp;
  }
}

// Dynamic imports so the pi-coding-agent config module sees PI_PACKAGE_DIR
const { runDashboard } = await import("./commands/dashboard.js");
const { runServe } = await import("./commands/serve.js");
const { runDesktop } = await import("./commands/desktop.js");
const { runTaskCreate, runTaskList, runTaskMove, runTaskMerge, runTaskUpdate, runTaskLog, runTaskLogs, runTaskShow, runTaskAttach, runTaskPause, runTaskUnpause, runTaskImportFromGitHub, runTaskDuplicate, runTaskArchive, runTaskUnarchive, runTaskRefine, runTaskPlan, runTaskDelete, runTaskRetry, runTaskComment, runTaskComments, runTaskSteer, runTaskPrCreate } = await import("./commands/task.js");
const { runSettingsShow, runSettingsSet } = await import("./commands/settings.js");
const { runSettingsExport } = await import("./commands/settings-export.js");
const { runSettingsImport } = await import("./commands/settings-import.js");
const { runGitStatus, runGitFetch, runGitPull, runGitPush } = await import("./commands/git.js");
const { runBackupCreate, runBackupList, runBackupRestore, runBackupCleanup } = await import("./commands/backup.js");
const { runMissionCreate, runMissionList, runMissionShow, runMissionDelete, runMissionActivateSlice } = await import("./commands/mission.js");
const { runProjectList, runProjectAdd, runProjectRemove, runProjectShow, runProjectInfo, runProjectSetDefault, runProjectDetect } = await import("./commands/project.js");
const { runNodeList, runNodeAdd, runNodeRemove, runNodeShow, runNodeHealth } = await import("./commands/node.js");
const { runInit } = await import("./commands/init.js");
const { runAgentStop, runAgentStart } = await import("./commands/agent.js");
const { runAgentImport } = await import("./commands/agent-import.js");
const { runMessageInbox, runMessageOutbox, runMessageSend, runMessageRead, runMessageDelete, runAgentMailbox } = await import("./commands/message.js");

const HELP = `
fn — AI-orchestrated task board

Usage:
  fn init [opts]                      Initialize a new kb project in the current directory
  fn dashboard                        Start the board web UI
  fn dashboard --paused               Start with automation paused
  fn dashboard --dev                  Start web UI only (no AI engine)
  fn dashboard --interactive          Start with interactive port selection
  fn serve [--port <port>] [--host <host>] [--paused]
                                      Start Fusion as a headless node (API + engine, no UI)
  fn desktop                          Launch the Fusion desktop app (Electron)
  fn desktop --dev                    Launch with hot-reload (connects to Vite dev server)
  fn desktop --paused                 Launch with automation paused
  fn task create [desc] [opts]         Create a new task (goes to triage)
  fn task plan [description] [opts]    Create task via AI-guided planning
  fn task list                        List all tasks
  fn task show <id>                   Show task details, steps, log
  fn task logs <id> [--follow] [--limit <n>] [--type <type>]
                                      Show task agent execution logs
  fn task move <id> <col>             Move a task to a column
  fn task update <id> <step> <status> Update step status (pending|in-progress|done|skipped)
  fn task log <id> <message>          Add a log entry
  fn task merge <id>                  Merge an in-review task and close it
  fn task duplicate <id>              Duplicate a task (creates copy in triage)
  fn task refine <id> [opts]          Create a refinement task from done/in-review
  fn task archive <id>                Archive a done task
  fn task unarchive <id>              Unarchive an archived task
  fn task delete <id> [--force]       Delete a task (use --force to skip confirmation)
  fn task attach <id> <file>          Attach a file to a task
  fn task pause <id>                  Pause a task (stops all automation)
  fn task unpause <id>                Unpause a task (resumes automation)
  fn task comment <id> [message]      Add task comment (prompts if message omitted)
  fn task comments <id>               List task comments
  fn task steer <id> [message]        Add steering comment (prompts if message omitted)
  fn task retry <id>                  Retry a failed task (clears error, moves to todo)
  fn task pr-create <id> [--title <title>] [--base <branch>] [--body <body>]
                         Create a GitHub PR for an in-review task
  fn task import <owner/repo> [opts]  Import GitHub issues as tasks
  fn mission create [title] [desc]    Create a new mission
  fn mission list | ls                List missions
  fn mission show | info <id>         Show mission details
  fn mission delete <id> [--force]    Delete a mission
  fn mission activate-slice <id>      Mark a slice active
  fn project list | ls [--json]       List all registered projects
  fn project add [name] [path] [opts]  Register a new project
  fn project remove | rm <name> [--force]
                                      Unregister a project
  fn project show <name>               Show project details with health
  fn project info [name]               Show project details (alias for show)
  fn project set-default | default <name>
                                      Set default project
  fn project detect                    Detect project from current directory
  fn node list | ls [--json]          List all nodes
  fn node add <name> [--url <url>] [--api-key <key>] [--max-concurrent <n>]
                                      Register a new node
  fn node remove | rm <name> [--force]
                                      Unregister a node
  fn node show | info [name]          Show node details
  fn node health <name>               Check node health
  fn settings                          Show current Fusion configuration
  fn settings set <key> <value>        Update a configuration setting
  fn settings export [opts]              Export settings to a JSON file
  fn settings import <file> [opts]       Import settings from a JSON file

  fn git status              Show current branch, commit, dirty state, ahead/behind
  fn git push                Push current branch
  fn git pull                Pull current branch
  fn git fetch [remote]      Fetch from remote (default: origin)
  fn agent stop <id>                Stop a running agent (pause execution)
  fn agent start <id>               Start a stopped agent (resume execution)
  fn agent import <path> [--dry-run] [--skip-existing]
                                      Import agents from an Agent Companies package (directory, archive, or .md file)
  fn agent mailbox <id>             View an agent's mailbox
  fn message inbox                  List inbox messages
  fn message outbox                 List sent messages
  fn message send <agent-id> <msg>  Send a message to an agent
  fn message read <id>              Read a specific message
  fn message delete <id>            Delete a message
  fn backup --create         Create a database backup immediately
  fn backup --list           List all database backups
  fn backup --restore <file> Restore database from a backup file
  fn backup --cleanup        Remove old backups exceeding retention limit

Options:
  --project, -P <name>       Target a specific project (bypasses CWD detection)
  --port, -p <port>          Dashboard/serve port (default: 4040)
  --host <host>              Serve host (default: 0.0.0.0)
  --interactive              Interactive mode (port selection for dashboard, issue selection for import)
  --paused                   Start with engine paused (automation disabled)
  --dev                      Start dashboard only (no AI engine)
  --attach <file>            Attach file(s) on task create (repeatable)
  --depends <id>             Declare dependency on task create (repeatable)
  --feedback <text>          Refinement feedback (non-interactive mode)
  --yes                      Skip confirmation prompts (planning mode)
  --limit, -l <n>            Max issues to import (default: 30, max: 100)
  --labels, -L <labels>      Comma-separated label filter for import
  --interactive, -i          Interactive mode for issue selection
  --help, -h                 Show this help

Columns: triage, todo, in-progress, in-review, done, archived
Supported file types: png, jpg, gif, webp, txt, log, json, yaml, yml, toml, csv, xml

The AI engine uses pi (github.com/badlogic/pi-mono) for agent sessions.
Requires configured API keys — run "pi" first to set up authentication.
`.trim();

function extractGlobalProjectFlag(argv: string[]): { cleanedArgs: string[]; projectName?: string } {
  const cleanedArgs: string[] = [];
  let projectName: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" || arg === "-P") {
      if (projectName) {
        throw new Error("Duplicate --project flag. Specify a project only once.");
      }
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Usage: --project <name>");
      }
      projectName = value;
      i++;
      continue;
    }
    cleanedArgs.push(arg);
  }

  return { cleanedArgs, projectName };
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    return undefined;
  }

  return value;
}

function getFlagValueNumber(args: string[], flag: string): number | undefined {
  const value = getFlagValue(args, flag);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Check if migration is needed and run it automatically.
 * This handles the transition from single-project to multi-project mode.
 */
async function checkAndMigrate(): Promise<void> {
  // Skip if KB_SKIP_MIGRATION is set
  if (process.env.KB_SKIP_MIGRATION === "1") {
    return;
  }

  try {
    const { needsCentralMigration, autoMigrateToCentral } = await import("@fusion/core");

    // Check if migration is needed
    if (!needsCentralMigration(process.cwd())) {
      return;
    }

    console.log("\n🔄 Migrating to multi-project mode...");

    // Get CentralCore and run migration
    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore();
    await central.init();

    try {
      const result = await autoMigrateToCentral(process.cwd(), central);

      if (result.success) {
        console.log(`✓ Registered project: ${result.projectsRegistered.join(", ")}`);
        if (result.errors.length > 0) {
          console.log(`  Warnings: ${result.errors.join(", ")}`);
        }
      } else {
        console.log(`⚠ Migration warnings: ${result.errors.join(", ")}`);
      }
    } finally {
      await central.close();
    }
  } catch (err) {
    // Migration errors are non-fatal - continue with legacy mode
    console.log(`⚠ Migration check failed: ${(err as Error).message}`);
  }
}

async function main() {
  const { cleanedArgs: args, projectName } = extractGlobalProjectFlag(process.argv.slice(2));

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];

  // Migration check: run auto-migration for existing single-project users
  // Skip for init command itself (user is explicitly initializing)
  if (command !== "init" && command !== "dashboard") {
    await checkAndMigrate();
  }

  try {
    switch (command) {
      case "init": {
        // Parse init options
        const nameIdx = args.indexOf("--name");
        const name = nameIdx !== -1 && nameIdx + 1 < args.length ? args[nameIdx + 1] : undefined;
        const pathIdx = args.indexOf("--path");
        const path = pathIdx !== -1 && pathIdx + 1 < args.length ? args[pathIdx + 1] : undefined;

        await runInit({ name, path });
        break;
      }

      case "dashboard": {
        // Initialize native module resolution for Bun binary before starting dashboard
        // This sets up the paths so node-pty can find its native assets
        if (isBunBinary) {
          const { initNativePatch } = await import("./runtime/native-patch.js");
          initNativePatch();
        }

        const portIdx = args.indexOf("--port");
        const portIdxShort = args.indexOf("-p");
        const pi = portIdx !== -1 ? portIdx : portIdxShort;
        const port = pi !== -1 ? parseInt(args[pi + 1], 10) : 4040;
        const paused = args.includes("--paused");
        const dev = args.includes("--dev");
        const interactive = args.includes("--interactive");
        await runDashboard(port, { paused, dev, interactive });
        break;
      }

      case "serve": {
        const portIdx = args.indexOf("--port");
        const portIdxShort = args.indexOf("-p");
        const pi = portIdx !== -1 ? portIdx : portIdxShort;
        const port = pi !== -1 ? parseInt(args[pi + 1], 10) : 4040;
        const paused = args.includes("--paused");
        const interactive = args.includes("--interactive");
        const hostIdx = args.indexOf("--host");
        const host = hostIdx !== -1 && hostIdx + 1 < args.length ? args[hostIdx + 1] : undefined;
        await runServe(port, { paused, interactive, host });
        break;
      }

      case "desktop": {
        const paused = args.includes("--paused");
        const dev = args.includes("--dev");
        const interactive = args.includes("--interactive");
        await runDesktop({ paused, dev, interactive });
        break;
      }

      case "project": {
        const subcommand = args[1];
        switch (subcommand) {
          case "list":
          case "ls":
            {
              const json = args.includes("--json");
              await runProjectList({ json });
            }
            break;
          case "add": {
            const name = args[2];
            const path = args[3];
            const isolationIdx = args.indexOf("--isolation");
            const isolation = isolationIdx !== -1 && isolationIdx + 1 < args.length
              ? args[isolationIdx + 1] as "in-process" | "child-process"
              : undefined;
            const force = args.includes("--force");
            const interactive = args.includes("--interactive");
            await runProjectAdd(name, path, { isolation, force, interactive });
            break;
          }
          case "info": {
            const name = args[2];
            await runProjectInfo(name);
            break;
          }
          case "remove":
          case "rm": {
            const name = args[2];
            const force = args.includes("--force");
            await runProjectRemove(name, { force });
            break;
          }
          case "show": {
            const name = args[2];
            await runProjectShow(name);
            break;
          }
          case "set-default":
          case "default": {
            const name = args[2];
            await runProjectSetDefault(name);
            break;
          }
          case "detect":
            await runProjectDetect();
            break;
          default:
            console.error(`Unknown subcommand: project ${subcommand || ""}`);
            console.log("Try: fn project list | add | remove | show | info | set-default | detect");
            process.exit(1);
        }
        break;
      }

      case "node": {
        const subcommand = args[1];
        switch (subcommand) {
          case "list":
          case "ls": {
            await runNodeList({ json: args.includes("--json") });
            break;
          }
          case "add": {
            const name = args[2];
            await runNodeAdd(name, {
              url: getFlagValue(args, "--url"),
              apiKey: getFlagValue(args, "--api-key"),
              maxConcurrent: getFlagValueNumber(args, "--max-concurrent"),
            });
            break;
          }
          case "remove":
          case "rm": {
            const name = args[2];
            await runNodeRemove(name, { force: args.includes("--force") });
            break;
          }
          case "show":
          case "info": {
            await runNodeShow(args[2]);
            break;
          }
          case "health": {
            await runNodeHealth(args[2]);
            break;
          }
          default:
            console.error(`Unknown subcommand: node ${subcommand || ""}`);
            console.log("Try: fn node list | add | remove | show | health");
            process.exit(1);
        }
        break;
      }

      case "task": {
        const subcommand = args[1];
        switch (subcommand) {
          case "create": {
            const createArgs = args.slice(2);
            const attachFiles: string[] = [];
            const dependsIds: string[] = [];
            const descParts: string[] = [];
            for (let i = 0; i < createArgs.length; i++) {
              if (createArgs[i] === "--attach" && i + 1 < createArgs.length) {
                attachFiles.push(createArgs[i + 1]);
                i++; // skip the value
              } else if (createArgs[i] === "--depends" && i + 1 < createArgs.length) {
                dependsIds.push(createArgs[i + 1]);
                i++; // skip the value
              } else {
                descParts.push(createArgs[i]);
              }
            }
            const title = descParts.join(" ");
            await runTaskCreate(title || undefined, attachFiles.length > 0 ? attachFiles : undefined, dependsIds.length > 0 ? dependsIds : undefined, projectName);
            break;
          }
          case "plan": {
            const planArgs = args.slice(2);
            const yesFlag = planArgs.includes("--yes");
            const descParts: string[] = [];
            for (let i = 0; i < planArgs.length; i++) {
              if (planArgs[i] === "--yes") {
                continue; // skip flag
              } else {
                descParts.push(planArgs[i]);
              }
            }
            const initialPlan = descParts.join(" ");
            await runTaskPlan(initialPlan || undefined, yesFlag, projectName);
            break;
          }
          case "list":
          case "ls":
            await runTaskList(projectName);
            break;
          case "move": {
            const id = args[2];
            const column = args[3];
            if (!id || !column) {
              console.error("Usage: fn task move <id> <column>");
              process.exit(1);
            }
            await runTaskMove(id, column, projectName);
            break;
          }
          case "show": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task show <id>"); process.exit(1); }
            await runTaskShow(id, projectName);
            break;
          }
          case "update": {
            const id = args[2], step = args[3], status = args[4];
            if (!id || !step || !status) {
              console.error("Usage: fn task update <id> <step> <status>");
              console.error("Status: pending | in-progress | done | skipped");
              process.exit(1);
            }
            await runTaskUpdate(id, step, status, projectName);
            break;
          }
          case "log": {
            const id = args[2], message = args.slice(3).join(" ");
            if (!id || !message) { console.error("Usage: fn task log <id> <message>"); process.exit(1); }
            await runTaskLog(id, message, undefined, projectName);
            break;
          }
          case "logs": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task logs <id> [--follow] [--limit <n>] [--type <type>]"); process.exit(1); }
            
            // Parse flags
            const follow = args.includes("--follow");
            
            let limit: number | undefined;
            const limitIdx = args.indexOf("--limit");
            if (limitIdx !== -1 && limitIdx + 1 < args.length) {
              const parsed = parseInt(args[limitIdx + 1], 10);
              if (!isNaN(parsed)) {
                limit = parsed;
              }
            }
            
            let type: string | undefined;
            const typeIdx = args.indexOf("--type");
            if (typeIdx !== -1 && typeIdx + 1 < args.length) {
              type = args[typeIdx + 1];
            }
            
            await runTaskLogs(id, { follow, limit, type: type as "text" | "thinking" | "tool" | "tool_result" | "tool_error" | undefined }, projectName);
            break;
          }
          case "merge": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task merge <id>"); process.exit(1); }
            await runTaskMerge(id, projectName);
            break;
          }
          case "duplicate": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task duplicate <id>"); process.exit(1); }
            await runTaskDuplicate(id, projectName);
            break;
          }
          case "refine": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task refine <id> [--feedback <text>]"); process.exit(1); }
            // Parse optional --feedback flag
            const feedbackIdx = args.indexOf("--feedback");
            const feedback = feedbackIdx !== -1 && feedbackIdx + 1 < args.length
              ? args[feedbackIdx + 1]
              : undefined;
            await runTaskRefine(id, feedback, projectName);
            break;
          }
          case "archive": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task archive <id>"); process.exit(1); }
            await runTaskArchive(id, projectName);
            break;
          }
          case "unarchive": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task unarchive <id>"); process.exit(1); }
            await runTaskUnarchive(id, projectName);
            break;
          }
          case "delete": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task delete <id> [--force]"); process.exit(1); }
            const force = args.includes("--force");
            await runTaskDelete(id, force, projectName);
            break;
          }
          case "attach": {
            const id = args[2], file = args[3];
            if (!id || !file) {
              console.error("Usage: fn task attach <id> <file>");
              process.exit(1);
            }
            await runTaskAttach(id, file, projectName);
            break;
          }
          case "pause": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task pause <id>"); process.exit(1); }
            await runTaskPause(id, projectName);
            break;
          }
          case "unpause": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task unpause <id>"); process.exit(1); }
            await runTaskUnpause(id, projectName);
            break;
          }
          case "comment": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task comment <id> [message] [--author <name>]"); process.exit(1); }
            const authorIdx = args.indexOf("--author");
            const author = authorIdx !== -1 && authorIdx + 1 < args.length ? args[authorIdx + 1] : undefined;
            const messageParts = args.slice(3).filter((arg, index, arr) => {
              const absoluteIndex = index + 3;
              return absoluteIndex !== authorIdx && absoluteIndex !== authorIdx + 1;
            });
            const message = messageParts.join(" ");
            await runTaskComment(id, message || undefined, author || process.env.USER || "user", projectName);
            break;
          }
          case "comments": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task comments <id>"); process.exit(1); }
            await runTaskComments(id, projectName);
            break;
          }
          case "steer": {
            const id = args[2];
            const message = args.slice(3).join(" ");
            if (!id) { console.error("Usage: fn task steer <id> [message]"); process.exit(1); }
            await runTaskSteer(id, message || undefined, projectName);
            break;
          }
          case "retry": {
            const id = args[2];
            if (!id) {
              console.error("Usage: fn task retry <id>");
              process.exit(1);
            }
            await runTaskRetry(id, projectName);
            break;
          }
          case "pr-create": {
            const id = args[2];
            if (!id) {
              console.error("Usage: fn task pr-create <id> [--title <title>] [--base <branch>] [--body <body>]");
              process.exit(1);
            }

            // Parse optional flags
            let title: string | undefined;
            let base: string | undefined;
            let body: string | undefined;

            const titleIdx = args.indexOf("--title");
            if (titleIdx !== -1 && titleIdx + 1 < args.length) {
              title = args[titleIdx + 1];
            }

            const baseIdx = args.indexOf("--base");
            if (baseIdx !== -1 && baseIdx + 1 < args.length) {
              base = args[baseIdx + 1];
            }

            const bodyIdx = args.indexOf("--body");
            if (bodyIdx !== -1 && bodyIdx + 1 < args.length) {
              body = args[bodyIdx + 1];
            }

            await runTaskPrCreate(id, { title, base, body }, projectName);
            break;
          }
          case "import": {
            const ownerRepo = args[2];
            if (!ownerRepo) {
              console.error("Usage: fn task import <owner/repo> [options]");
              console.error("Options: --limit <n>, -l <n>  (default: 30, max: 100)");
              console.error("         --labels <labels>, -L <labels>  (comma-separated)");
              console.error("         --interactive, -i  (interactive mode)");
              process.exit(1);
            }

            // Parse options
            let limit = 30;
            const limitIdx = args.indexOf("--limit");
            const limitIdxShort = args.indexOf("-l");
            const li = limitIdx !== -1 ? limitIdx : limitIdxShort;
            if (li !== -1 && li + 1 < args.length) {
              const parsed = parseInt(args[li + 1], 10);
              if (!isNaN(parsed)) {
                limit = Math.min(Math.max(parsed, 1), 100);
              }
            }

            let labels: string[] | undefined;
            const labelsIdx = args.indexOf("--labels");
            const labelsIdxShort = args.indexOf("-L");
            const labi = labelsIdx !== -1 ? labelsIdx : labelsIdxShort;
            if (labi !== -1 && labi + 1 < args.length) {
              labels = args[labi + 1].split(",").map(l => l.trim()).filter(Boolean);
            }

            // Check for interactive mode
            const interactive = args.includes("--interactive") || args.includes("-i");

            if (interactive) {
              const { runTaskImportGitHubInteractive } = await import("./commands/task.js");
              await runTaskImportGitHubInteractive(ownerRepo, { limit, labels }, projectName);
            } else {
              await runTaskImportFromGitHub(ownerRepo, { limit, labels }, projectName);
            }
            break;
          }
          default:
            console.error(`Unknown subcommand: task ${subcommand || ""}`);
            console.log("Try: fn task create | list | move");
            process.exit(1);
        }
        break;
      }

      case "mission": {
        const subcommand = args[1];
        switch (subcommand) {
          case "create": {
            const title = args[2];
            const description = args.length > 3 ? args.slice(3).join(" ") : undefined;
            await runMissionCreate(title, description, projectName);
            break;
          }
          case "list":
          case "ls":
            await runMissionList(projectName);
            break;
          case "show":
          case "info": {
            const id = args[2];
            await runMissionShow(id, projectName);
            break;
          }
          case "delete": {
            const id = args[2];
            const force = args.includes("--force");
            await runMissionDelete(id, force, projectName);
            break;
          }
          case "activate-slice": {
            const id = args[2];
            await runMissionActivateSlice(id, projectName);
            break;
          }
          default:
            console.error(`Unknown subcommand: mission ${subcommand || ""}`);
            console.log("Try: fn mission create | list | show | delete | activate-slice");
            process.exit(1);
        }
        break;
      }

      case "settings": {
        const subcommand = args[1];
        if (!subcommand || subcommand === "show") {
          await runSettingsShow(projectName);
          break;
        }
        if (subcommand === "set") {
          const key = args[2];
          const value = args.slice(3).join(" ");
          if (!key || value === undefined) {
            console.error("Usage: fn settings set <key> <value>");
            console.error("Example: fn settings set maxConcurrent 4");
            process.exit(1);
          }
          await runSettingsSet(key, value, projectName);
          break;
        }
        if (subcommand === "export") {
          // Parse export options
          const scopeIdx = args.indexOf("--scope");
          const scope = scopeIdx !== -1 && scopeIdx + 1 < args.length
            ? args[scopeIdx + 1] as "global" | "project" | "both"
            : "both";
          
          const outputIdx = args.indexOf("--output");
          const output = outputIdx !== -1 && outputIdx + 1 < args.length
            ? args[outputIdx + 1]
            : undefined;

          await runSettingsExport({ scope, output, projectName });
          break;
        }
        if (subcommand === "import") {
          const file = args[2];
          if (!file) {
            console.error("Usage: fn settings import <file> [--scope global|project|both] [--merge] [--yes]");
            console.error("Example: fn settings import fusion-settings-2026-03-31.json --yes");
            process.exit(1);
          }

          // Parse import options
          const scopeIdx = args.indexOf("--scope");
          const scope = scopeIdx !== -1 && scopeIdx + 1 < args.length
            ? args[scopeIdx + 1] as "global" | "project" | "both"
            : "both";

          const merge = args.includes("--merge");
          const yes = args.includes("--yes");

          await runSettingsImport(file, { scope, merge, yes, projectName });
          break;
        }
        console.error(`Unknown settings subcommand: ${subcommand}`);
        console.error("Try: fn settings | fn settings set <key> <value> | fn settings export | fn settings import <file>");
        process.exit(1);
      }

      case "git": {
        const subcommand = args[1];
        switch (subcommand) {
          case "status":
            await runGitStatus(projectName);
            break;
          case "fetch": {
            const remote = args[2];
            await runGitFetch(remote, projectName);
            break;
          }
          case "pull": {
            const skipConfirm = args.includes("--yes");
            await runGitPull({ skipConfirm, projectName });
            break;
          }
          case "push": {
            const skipConfirm = args.includes("--yes");
            await runGitPush({ skipConfirm, projectName });
            break;
          }
          default:
            console.error(`Unknown subcommand: git ${subcommand || ""}`);
            console.log("Try: fn git status | fetch | pull | push");
            process.exit(1);
        }
        break;
      }

      case "backup": {
        const create = args.includes("--create");
        const list = args.includes("--list");
        const cleanup = args.includes("--cleanup");
        const restoreIdx = args.indexOf("--restore");
        const restoreFile = restoreIdx !== -1 && restoreIdx + 1 < args.length ? args[restoreIdx + 1] : undefined;

        if (create) {
          await runBackupCreate(projectName);
        } else if (list) {
          await runBackupList(projectName);
        } else if (cleanup) {
          await runBackupCleanup(projectName);
        } else if (restoreFile) {
          await runBackupRestore(restoreFile, projectName);
        } else {
          console.error("Usage: fn backup --create | --list | --cleanup | --restore <filename>");
          process.exit(1);
        }
        break;
      }

      case "agent": {
        const subcommand = args[1];
        switch (subcommand) {
          case "stop": {
            const id = args[2];
            if (!id) { console.error("Usage: fn agent stop <id>"); process.exit(1); }
            await runAgentStop(id, projectName);
            break;
          }
          case "start": {
            const id = args[2];
            if (!id) { console.error("Usage: fn agent start <id>"); process.exit(1); }
            await runAgentStart(id, projectName);
            break;
          }
          case "mailbox": {
            const id = args[2];
            if (!id) { console.error("Usage: fn agent mailbox <id>"); process.exit(1); }
            await runAgentMailbox(id, projectName);
            break;
          }
          case "import": {
            const source = args[2];
            if (!source) { console.error("Usage: fn agent import <path> [--dry-run] [--skip-existing]"); process.exit(1); }
            const importArgs = args.slice(3);
            const dryRun = importArgs.includes("--dry-run");
            const skipExisting = importArgs.includes("--skip-existing");
            await runAgentImport(source, { dryRun, skipExisting, project: projectName });
            break;
          }
          default:
            console.error(`Unknown subcommand: agent ${subcommand || ""}`);
            console.log("Try: fn agent stop <id> | fn agent start <id> | fn agent mailbox <id> | fn agent import <path>");
            process.exit(1);
        }
        break;
      }

      case "message": {
        const subcommand = args[1];
        switch (subcommand) {
          case "inbox": {
            await runMessageInbox(projectName);
            break;
          }
          case "outbox": {
            await runMessageOutbox(projectName);
            break;
          }
          case "send": {
            const toId = args[2];
            const content = args.slice(3).join(" ").trim();
            if (!toId || !content) {
              console.error("Usage: fn message send <agent-id> <content>");
              process.exit(1);
            }
            await runMessageSend(toId, content, projectName);
            break;
          }
          case "read": {
            const id = args[2];
            if (!id) { console.error("Usage: fn message read <id>"); process.exit(1); }
            await runMessageRead(id, projectName);
            break;
          }
          case "delete": {
            const id = args[2];
            if (!id) { console.error("Usage: fn message delete <id>"); process.exit(1); }
            await runMessageDelete(id, projectName);
            break;
          }
          default:
            console.error(`Unknown subcommand: message ${subcommand || ""}`);
            console.log("Try: fn message inbox | fn message outbox | fn message send | fn message read | fn message delete");
            process.exit(1);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

await main();
