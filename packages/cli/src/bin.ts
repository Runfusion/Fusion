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
const { runTaskCreate, runTaskList, runTaskMove, runTaskMerge, runTaskUpdate, runTaskLog, runTaskShow, runTaskAttach, runTaskPause, runTaskUnpause, runTaskImportFromGitHub, runTaskDuplicate } = await import("./commands/task.js");

const HELP = `
kb — AI-orchestrated task board

Usage:
  kb dashboard                        Start the board web UI
  kb dashboard --paused               Start with automation paused
  kb dashboard --dev                  Start web UI only (no AI engine)
  kb task create [desc] [opts]         Create a new task (goes to triage)
  kb task list                        List all tasks
  kb task show <id>                   Show task details, steps, log
  kb task move <id> <col>             Move a task to a column
  kb task update <id> <step> <status> Update step status (pending|in-progress|done|skipped)
  kb task log <id> <message>          Add a log entry
  kb task merge <id>                  Merge an in-review task and close it
  kb task duplicate <id>              Duplicate a task (creates copy in triage)
  kb task attach <id> <file>          Attach a file to a task
  kb task pause <id>                  Pause a task (stops all automation)
  kb task unpause <id>                Unpause a task (resumes automation)
  kb task import <owner/repo> [opts]  Import GitHub issues as tasks

Options:
  --port, -p <port>          Dashboard port (default: 4040)
  --paused                   Start with engine paused (automation disabled)
  --dev                      Start dashboard only (no AI engine)
  --attach <file>            Attach file(s) on task create (repeatable)
  --depends <id>             Declare dependency on task create (repeatable)
  --limit, -l <n>            Max issues to import (default: 30, max: 100)
  --labels, -L <labels>      Comma-separated label filter for import
  --interactive, -i          Interactive mode for issue selection
  --help, -h                 Show this help

Columns: triage, todo, in-progress, in-review, done
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
        const portIdx = args.indexOf("--port");
        const portIdxShort = args.indexOf("-p");
        const pi = portIdx !== -1 ? portIdx : portIdxShort;
        const port = pi !== -1 ? parseInt(args[pi + 1], 10) : 4040;
        const open = !args.includes("--no-open");
        const paused = args.includes("--paused");
        const dev = args.includes("--dev");
        await runDashboard(port, { open, paused, dev });
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
          case "list":
          case "ls":
            await runTaskList();
            break;
          case "move": {
            const id = args[2];
            const column = args[3];
            if (!id || !column) {
              console.error("Usage: kb task move <id> <column>");
              process.exit(1);
            }
            await runTaskMove(id, column);
            break;
          }
          case "show": {
            const id = args[2];
            if (!id) { console.error("Usage: kb task show <id>"); process.exit(1); }
            await runTaskShow(id);
            break;
          }
          case "update": {
            const id = args[2], step = args[3], status = args[4];
            if (!id || !step || !status) {
              console.error("Usage: kb task update <id> <step> <status>");
              console.error("Status: pending | in-progress | done | skipped");
              process.exit(1);
            }
            await runTaskUpdate(id, step, status);
            break;
          }
          case "log": {
            const id = args[2], message = args.slice(3).join(" ");
            if (!id || !message) { console.error("Usage: kb task log <id> <message>"); process.exit(1); }
            await runTaskLog(id, message);
            break;
          }
          case "merge": {
            const id = args[2];
            if (!id) { console.error("Usage: kb task merge <id>"); process.exit(1); }
            await runTaskMerge(id);
            break;
          }
          case "duplicate": {
            const id = args[2];
            if (!id) { console.error("Usage: kb task duplicate <id>"); process.exit(1); }
            await runTaskDuplicate(id);
            break;
          }
          case "attach": {
            const id = args[2], file = args[3];
            if (!id || !file) {
              console.error("Usage: kb task attach <id> <file>");
              process.exit(1);
            }
            await runTaskAttach(id, file);
            break;
          }
          case "pause": {
            const id = args[2];
            if (!id) { console.error("Usage: kb task pause <id>"); process.exit(1); }
            await runTaskPause(id);
            break;
          }
          case "unpause": {
            const id = args[2];
            if (!id) { console.error("Usage: kb task unpause <id>"); process.exit(1); }
            await runTaskUnpause(id);
            break;
          }
          case "import": {
            const ownerRepo = args[2];
            if (!ownerRepo) {
              console.error("Usage: kb task import <owner/repo> [options]");
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
            console.log("Try: kb task create | list | move");
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
