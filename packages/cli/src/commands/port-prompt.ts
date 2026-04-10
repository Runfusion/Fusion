/**
 * Interactive port prompt utilities for CLI commands.
 *
 * This module provides neutral port selection utilities that can be used by
 * both `runDashboard()` and `runServe()`. It has NO dependency on UI or
 * dashboard-specific imports.
 */

import { createInterface } from "node:readline";

/**
 * Prompt the user for a port number interactively.
 * Shows "Port [4040]: " and accepts user input or Enter for default.
 * Validates input is a valid port number (1-65535).
 * Re-prompts on invalid input.
 * Handles SIGINT (Ctrl+C) gracefully.
 *
 * @param defaultPort - The default port to use if user presses Enter
 * @param input - The readable stream to read from (defaults to process.stdin)
 * @returns The selected port number
 */
export function promptForPort(
  defaultPort: number = 4040,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input,
      output: process.stdout,
    });

    // Handle Ctrl+C during prompt
    const sigintHandler = () => {
      rl.close();
      console.log("\n");
      reject(new Error("Interactive prompt cancelled"));
    };
    process.on("SIGINT", sigintHandler);

    const ask = () => {
      rl.question(`Port [${defaultPort}]: `, (answer) => {
        const trimmed = answer.trim();

        // Empty input: use default
        if (trimmed === "") {
          process.removeListener("SIGINT", sigintHandler);
          rl.close();
          resolve(defaultPort);
          return;
        }

        // Validate as number
        const port = parseInt(trimmed, 10);
        if (isNaN(port)) {
          console.log(`Invalid input: "${trimmed}" is not a number`);
          ask();
          return;
        }

        // Validate port range
        if (port < 1 || port > 65535) {
          console.log(`Invalid port: ${port} (must be between 1 and 65535)`);
          ask();
          return;
        }

        process.removeListener("SIGINT", sigintHandler);
        rl.close();
        resolve(port);
      });
    };

    ask();
  });
}
