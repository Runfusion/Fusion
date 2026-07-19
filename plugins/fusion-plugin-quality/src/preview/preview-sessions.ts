import { createServer } from "node:net";
import { superviseSpawn, type SupervisedChild } from "@fusion/core";
import type { TaskCodeCwdKind } from "./task-code-worktree.js";

/*
FNXC:Quality 2026-07-14-21:45:
Task-scoped preview servers for QA. Supervised spawn, free port (never 4040), worktree cwd.
Composes Dev Server safety ideas without replacing the global Dev Server view.

FNXC:Quality 2026-07-15-23:23:
Done tasks lose their live worktree after land/cleanup. Preview still starts in a disposable
QA worktree checked out at the task branch/merge commit (see task-code-worktree.ts) so the
server runs the done task's code, not project root/mainline.
*/

export type PreviewStatus = "starting" | "running" | "stopped" | "failed";
export type PreviewCwdKind = TaskCodeCwdKind;

export interface PreviewSession {
  projectId: string;
  taskId: string;
  status: PreviewStatus;
  command: string;
  cwd: string;
  /** Live task worktree, or disposable QA worktree for done/cleaned-up tasks. */
  cwdKind?: PreviewCwdKind;
  /** Git ref when cwdKind is qa-worktree. */
  ref?: string;
  port?: number;
  url?: string;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  errorMessage?: string;
  logTail: string[];
}

const FORBIDDEN_PORT = 4040;
const MAX_TERMINAL_SESSIONS = 50;
const TERMINAL_SESSION_TTL_MS = 60 * 60 * 1000;

async function allocateFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const p = addr.port;
          server.close(() => resolve(p));
        } else {
          server.close(() => reject(new Error("Failed to allocate port")));
        }
      });
      server.on("error", reject);
    });
    if (port !== FORBIDDEN_PORT) return port;
  }
  throw new Error("Could not allocate a free port");
}

function isSafeScriptName(script: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(script);
}

interface LiveSession extends PreviewSession {
  supervised?: SupervisedChild;
}

/** Remove stale terminal session metadata without touching live preview processes. */
export function pruneTerminalPreviewSessions(
  sessions: Map<string, LiveSession>,
  now = Date.now(),
): void {
  const terminal = [...sessions.entries()]
    .filter(([, session]) => session.status === "stopped" || session.status === "failed")
    .sort(([, left], [, right]) => Date.parse(left.stoppedAt ?? left.startedAt ?? "") - Date.parse(right.stoppedAt ?? right.startedAt ?? ""));
  for (const [sessionKey, session] of terminal) {
    const stoppedAt = Date.parse(session.stoppedAt ?? "");
    if (Number.isFinite(stoppedAt) && now - stoppedAt > TERMINAL_SESSION_TTL_MS) {
      sessions.delete(sessionKey);
    }
  }
  for (const [sessionKey] of terminal) {
    if (sessions.size <= MAX_TERMINAL_SESSIONS) break;
    sessions.delete(sessionKey);
  }
}

export function createPreviewSessionManager() {
  const sessions = new Map<string, LiveSession>();

  function key(projectId: string, taskId: string): string {
    return `${projectId}::${taskId}`;
  }

  return {
    get(projectId: string, taskId: string): PreviewSession | null {
      pruneTerminalPreviewSessions(sessions);
      const s = sessions.get(key(projectId, taskId));
      if (!s) return null;
      const { supervised: _s, ...publicSession } = s;
      return publicSession;
    },

    async start(input: {
      projectId: string;
      taskId: string;
      cwd: string;
      cwdKind?: PreviewCwdKind;
      ref?: string;
      script: string;
    }): Promise<PreviewSession> {
      pruneTerminalPreviewSessions(sessions);
      const k = key(input.projectId, input.taskId);
      const existing = sessions.get(k);
      if (existing && (existing.status === "running" || existing.status === "starting")) {
        const { supervised: _s, ...pub } = existing;
        return pub;
      }

      if (!isSafeScriptName(input.script)) {
        throw Object.assign(new Error("Invalid preview script name"), { statusCode: 400 });
      }

      const port = await allocateFreePort();
      if (port === FORBIDDEN_PORT) {
        throw new Error("Refusing to bind reserved port 4040");
      }

      const command = `pnpm run ${input.script}`;
      const session: LiveSession = {
        projectId: input.projectId,
        taskId: input.taskId,
        status: "starting",
        command,
        cwd: input.cwd,
        cwdKind: input.cwdKind,
        ref: input.ref,
        port,
        url: `http://127.0.0.1:${port}`,
        startedAt: new Date().toISOString(),
        logTail: [],
      };
      sessions.set(k, session);

      try {
        const supervised = superviseSpawn(command, [], {
          cwd: input.cwd,
          shell: true,
          env: {
            ...process.env,
            PORT: String(port),
            // Common Vite / Next conventions
            VITE_PORT: String(port),
          },
        });
        session.supervised = supervised;
        session.pid = supervised.child.pid;
        session.status = "running";

        const pushLog = (chunk: Buffer | string) => {
          const line = String(chunk);
          session.logTail.push(...line.split(/\r?\n/).filter(Boolean));
          if (session.logTail.length > 100) {
            session.logTail = session.logTail.slice(-100);
          }
          // Best-effort URL detection
          const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\S*/);
          if (m) session.url = m[0];
        };
        supervised.child.stdout?.on("data", pushLog);
        supervised.child.stderr?.on("data", pushLog);
        supervised.child.on("close", (code) => {
          session.status = code === 0 ? "stopped" : "failed";
          session.stoppedAt = new Date().toISOString();
          if (code && code !== 0) {
            session.errorMessage = `Exited with code ${code}`;
          }
          session.supervised = undefined;
          pruneTerminalPreviewSessions(sessions);
        });
      } catch (err) {
        session.status = "failed";
        session.errorMessage = err instanceof Error ? err.message : String(err);
        session.stoppedAt = new Date().toISOString();
        pruneTerminalPreviewSessions(sessions);
      }

      const { supervised: _s, ...pub } = session;
      return pub;
    },

    async stop(projectId: string, taskId: string): Promise<PreviewSession | null> {
      const k = key(projectId, taskId);
      const session = sessions.get(k);
      if (!session) return null;
      if (session.supervised) {
        /*
        FNXC:Quality 2026-07-15-14:10:
        A stopped preview may still be a live child that ignored SIGTERM. Keep
        the captured supervisor until its close event so the escalation always
        targets the original process group instead of an already-cleared field.
        */
        const supervised = session.supervised;
        supervised.kill("SIGTERM");
        const escalationTimer = setTimeout(() => {
          supervised.kill("SIGKILL");
        }, 2000);
        escalationTimer.unref?.();
      }
      session.status = "stopped";
      session.stoppedAt = new Date().toISOString();
      pruneTerminalPreviewSessions(sessions);
      const { supervised: _s, ...pub } = session;
      return pub;
    },
  };
}
