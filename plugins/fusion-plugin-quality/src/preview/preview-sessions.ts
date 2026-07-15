import { createServer } from "node:net";
import { superviseSpawn, type SupervisedChild } from "@fusion/core";

/*
FNXC:Quality 2026-07-14-21:45:
Task-scoped preview servers for QA. Supervised spawn, free port (never 4040), worktree cwd.
Composes Dev Server safety ideas without replacing the global Dev Server view.
*/

export type PreviewStatus = "starting" | "running" | "stopped" | "failed";

export interface PreviewSession {
  projectId: string;
  taskId: string;
  status: PreviewStatus;
  command: string;
  cwd: string;
  port?: number;
  url?: string;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  errorMessage?: string;
  logTail: string[];
}

const FORBIDDEN_PORT = 4040;
/** Cap finished (stopped/failed) sessions retained in memory. */
const MAX_FINISHED_SESSIONS = 32;
/** Drop finished sessions after this age (ms). */
const FINISHED_TTL_MS = 15 * 60 * 1000;

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

export function createPreviewSessionManager() {
  const sessions = new Map<string, LiveSession>();

  function key(projectId: string, taskId: string): string {
    return `${projectId}::${taskId}`;
  }

  function publicView(s: LiveSession): PreviewSession {
    const { supervised: _s, ...publicSession } = s;
    return publicSession;
  }

  /*
  FNXC:Quality 2026-07-14-22:10:
  PR review: finished preview sessions must not accumulate unbounded in the process map.
  Prune stopped/failed by TTL and cap; remove entry after stop when no longer live.
  */
  function pruneFinishedSessions(): void {
    const now = Date.now();
    const finished: Array<{ k: string; stoppedAt: number }> = [];
    for (const [k, s] of sessions) {
      if (s.status === "running" || s.status === "starting") continue;
      const stoppedAt = s.stoppedAt ? Date.parse(s.stoppedAt) : 0;
      if (stoppedAt && now - stoppedAt > FINISHED_TTL_MS) {
        sessions.delete(k);
        continue;
      }
      finished.push({ k, stoppedAt: stoppedAt || 0 });
    }
    if (finished.length <= MAX_FINISHED_SESSIONS) return;
    finished.sort((a, b) => a.stoppedAt - b.stoppedAt);
    const drop = finished.length - MAX_FINISHED_SESSIONS;
    for (let i = 0; i < drop; i++) {
      sessions.delete(finished[i]!.k);
    }
  }

  return {
    get(projectId: string, taskId: string): PreviewSession | null {
      pruneFinishedSessions();
      const s = sessions.get(key(projectId, taskId));
      if (!s) return null;
      return publicView(s);
    },

    async start(input: {
      projectId: string;
      taskId: string;
      cwd: string;
      script: string;
    }): Promise<PreviewSession> {
      pruneFinishedSessions();
      const k = key(input.projectId, input.taskId);
      const existing = sessions.get(k);
      if (existing && (existing.status === "running" || existing.status === "starting")) {
        return publicView(existing);
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
          pruneFinishedSessions();
        });
      } catch (err) {
        session.status = "failed";
        session.errorMessage = err instanceof Error ? err.message : String(err);
        session.stoppedAt = new Date().toISOString();
        pruneFinishedSessions();
      }

      return publicView(session);
    },

    async stop(projectId: string, taskId: string): Promise<PreviewSession | null> {
      const k = key(projectId, taskId);
      const session = sessions.get(k);
      if (!session) return null;
      /*
      FNXC:Quality 2026-07-14-22:20:
      PR review: keep a local ref to supervised so delayed SIGKILL is not cleared
      when session.supervised is nulled; wait for exit before finalizing status.
      */
      const supervised = session.supervised;
      if (supervised) {
        supervised.kill("SIGTERM");
        const forceKillTimer = setTimeout(() => {
          supervised.kill("SIGKILL");
        }, 2_000);
        try {
          await supervised.waitExit();
        } finally {
          clearTimeout(forceKillTimer);
        }
      }
      session.status = "stopped";
      session.stoppedAt = new Date().toISOString();
      session.supervised = undefined;
      pruneFinishedSessions();
      return publicView(session);
    },
  };
}
