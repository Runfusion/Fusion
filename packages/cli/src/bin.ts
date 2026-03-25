#!/usr/bin/env node

import { runDashboard } from "./commands/dashboard.js";
import { runTaskCreate, runTaskList, runTaskMove } from "./commands/task.js";

const HELP = `
hai — AI-orchestrated task board

Usage:
  hai dashboard              Start the board web UI
  hai task create [title]    Create a new task (goes to triage)
  hai task list              List all tasks
  hai task move <id> <col>   Move a task to a column

Options:
  --port, -p <port>          Dashboard port (default: 4040)
  --engine                   Enable AI engine (auto-specify + execute tasks)
  --no-open                  Don't auto-open the browser
  --help, -h                 Show this help

Columns: triage, todo, in-progress, in-review, done

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
        const engine = args.includes("--engine");
        const open = !args.includes("--no-open");
        await runDashboard(port, { engine, open });
        break;
      }

      case "task": {
        const subcommand = args[1];
        switch (subcommand) {
          case "create": {
            const title = args.slice(2).join(" ");
            await runTaskCreate(title || undefined);
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
              console.error("Usage: hai task move <id> <column>");
              process.exit(1);
            }
            await runTaskMove(id, column);
            break;
          }
          default:
            console.error(`Unknown subcommand: task ${subcommand || ""}`);
            console.log("Try: hai task create | list | move");
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
