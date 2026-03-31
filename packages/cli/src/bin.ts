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
        { name: "kb", version: "0.1.0", type: "module", piConfig: { name: "kb", configDir: ".kb" } },
        null,
        2,
      ) + "\n",
    );
    process.env.PI_PACKAGE_DIR = tmp;
  }
}

// Dynamic imports so the pi-coding-agent config module sees PI_PACKAGE_DIR
const { runDashboard } = await import("./commands/dashboard.js");
const { runTaskCreate, runTaskList, runTaskMove, runTaskMerge, runTaskUpdate, runTaskLog, runTaskLogs, runTaskShow, runTaskAttach, runTaskPause, runTaskUnpause, runTaskImportFromGitHub, runTaskDuplicate, runTaskArchive, runTaskUnarchive, runTaskRefine, runTaskPlan, runTaskDelete, runTaskRetry, runTaskComment, runTaskComments, runTaskSteer, runTaskPrCreate } = await import("./commands/task.js");
const { runSettingsShow, runSettingsSet } = await import("./commands/settings.js");
const { runGitStatus, runGitFetch, runGitPull, runGitPush } = await import("./commands/git.js");
const { runBackupCreate, runBackupList, runBackupRestore, runBackupCleanup } = await import("./commands/backup.js");

const HELP = `
fn — AI-orchestrated task board

Usage:
  fn dashboard                        Start the board web UI
  fn dashboard --paused               Start with automation paused
  fn dashboard --dev                  Start web UI only (no AI engine)
  fn dashboard --interactive          Start with interactive port selection
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
  fn settings                          Show current Fusion configuration
  fn settings set <key> <value>        Update a configuration setting

  fn git status              Show current branch, commit, dirty state, ahead/behind
  fn git push                Push current branch
  fn git pull                Pull current branch
  fn git fetch [remote]      Fetch from remote (default: origin)
  fn backup --create         Create a database backup immediately
  fn backup --list           List all database backups
  fn backup --restore <file> Restore database from a backup file
  fn backup --cleanup        Remove old backups exceeding retention limit

Options:
  --port, -p <port>          Dashboard port (default: 4040)
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

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];

  try {
    switch (command) {
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
            await runTaskCreate(title || undefined, attachFiles.length > 0 ? attachFiles : undefined, dependsIds.length > 0 ? dependsIds : undefined);
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
            await runTaskPlan(initialPlan || undefined, yesFlag);
            break;
          }
          case "list":
          case "ls":
            await runTaskList();
            break;
          case "move": {
            const id = args[2];
            const column = args[3];
            if (!id || !column) {
              console.error("Usage: fn task move <id> <column>");
              process.exit(1);
            }
            await runTaskMove(id, column);
            break;
          }
          case "show": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task show <id>"); process.exit(1); }
            await runTaskShow(id);
            break;
          }
          case "update": {
            const id = args[2], step = args[3], status = args[4];
            if (!id || !step || !status) {
              console.error("Usage: fn task update <id> <step> <status>");
              console.error("Status: pending | in-progress | done | skipped");
              process.exit(1);
            }
            await runTaskUpdate(id, step, status);
            break;
          }
          case "log": {
            const id = args[2], message = args.slice(3).join(" ");
            if (!id || !message) { console.error("Usage: fn task log <id> <message>"); process.exit(1); }
            await runTaskLog(id, message);
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
            
            await runTaskLogs(id, { follow, limit, type: type as "text" | "thinking" | "tool" | "tool_result" | "tool_error" | undefined });
            break;
          }
          case "merge": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task merge <id>"); process.exit(1); }
            await runTaskMerge(id);
            break;
          }
          case "duplicate": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task duplicate <id>"); process.exit(1); }
            await runTaskDuplicate(id);
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
            await runTaskRefine(id, feedback);
            break;
          }
          case "archive": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task archive <id>"); process.exit(1); }
            await runTaskArchive(id);
            break;
          }
          case "unarchive": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task unarchive <id>"); process.exit(1); }
            await runTaskUnarchive(id);
            break;
          }
          case "delete": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task delete <id> [--force]"); process.exit(1); }
            const force = args.includes("--force");
            await runTaskDelete(id, force);
            break;
          }
          case "attach": {
            const id = args[2], file = args[3];
            if (!id || !file) {
              console.error("Usage: fn task attach <id> <file>");
              process.exit(1);
            }
            await runTaskAttach(id, file);
            break;
          }
          case "pause": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task pause <id>"); process.exit(1); }
            await runTaskPause(id);
            break;
          }
          case "unpause": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task unpause <id>"); process.exit(1); }
            await runTaskUnpause(id);
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
            await runTaskComment(id, message || undefined, author || process.env.USER || "user");
            break;
          }
          case "comments": {
            const id = args[2];
            if (!id) { console.error("Usage: fn task comments <id>"); process.exit(1); }
            await runTaskComments(id);
            break;
          }
          case "steer": {
            const id = args[2];
            const message = args.slice(3).join(" ");
            if (!id) { console.error("Usage: fn task steer <id> [message]"); process.exit(1); }
            await runTaskSteer(id, message || undefined);
            break;
          }
          case "retry": {
            const id = args[2];
            if (!id) {
              console.error("Usage: fn task retry <id>");
              process.exit(1);
            }
            await runTaskRetry(id);
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

            await runTaskPrCreate(id, { title, base, body });
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
              await runTaskImportGitHubInteractive(ownerRepo, { limit, labels });
            } else {
              await runTaskImportFromGitHub(ownerRepo, { limit, labels });
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

      case "settings": {
        const subcommand = args[1];
        if (!subcommand || subcommand === "show") {
          await runSettingsShow();
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
          await runSettingsSet(key, value);
          break;
        }
        console.error(`Unknown settings subcommand: ${subcommand}`);
        console.error("Try: fn settings | fn settings set <key> <value>");
        process.exit(1);
      }

      case "git": {
        const subcommand = args[1];
        switch (subcommand) {
          case "status":
            await runGitStatus();
            break;
          case "fetch": {
            const remote = args[2];
            await runGitFetch(remote);
            break;
          }
          case "pull": {
            const skipConfirm = args.includes("--yes");
            await runGitPull({ skipConfirm });
            break;
          }
          case "push": {
            const skipConfirm = args.includes("--yes");
            await runGitPush({ skipConfirm });
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
          await runBackupCreate();
        } else if (list) {
          await runBackupList();
        } else if (cleanup) {
          await runBackupCleanup();
        } else if (restoreFile) {
          await runBackupRestore(restoreFile);
        } else {
          console.error("Usage: fn backup --create | --list | --cleanup | --restore <filename>");
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

main();
