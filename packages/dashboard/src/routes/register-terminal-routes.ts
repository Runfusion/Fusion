import type { Request, Router } from "express";
import { ApiError, badRequest, notFound, rethrowAsApiError } from "../api-error.js";
import type { ProjectContext } from "./types.js";
import type { TerminalOutputEvent, terminalSessionManager as terminalSessionManagerType } from "../terminal.js";
import type { getTerminalService as getTerminalServiceType } from "../terminal-service.js";

export interface TerminalRouteDeps {
  getProjectContext: (req: Request) => Promise<ProjectContext>;
  terminalSessionManager: typeof terminalSessionManagerType;
  getTerminalService: typeof getTerminalServiceType;
}

/**
 * Registers terminal execution and PTY management routes.
 *
 * Endpoints:
 * - POST /terminal/exec
 * - POST /terminal/sessions/:id/kill
 * - GET /terminal/sessions/:id
 * - GET /terminal/sessions/:id/stream
 * - POST /terminal/sessions
 * - GET /terminal/sessions
 * - DELETE /terminal/sessions/:id
 */
export function registerTerminalRoutes(router: Router, deps: TerminalRouteDeps): void {
  const { getProjectContext, terminalSessionManager, getTerminalService } = deps;

  router.post("/terminal/exec", async (req, res) => {
    try {
      const { command } = req.body;

      if (!command || typeof command !== "string") {
        throw badRequest("command is required and must be a string");
      }

      if (command.length > 4096) {
        throw badRequest("command exceeds maximum length of 4096 characters");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const result = terminalSessionManager.createSession(command, rootDir);

      if (result.error) {
        throw new ApiError(403, result.error);
      }

      res.status(201).json({ sessionId: result.sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to execute command");
    }
  });

  router.post("/terminal/sessions/:id/kill", (req, res) => {
    try {
      const { id } = req.params;
      const { signal } = req.body;

      const validSignals: NodeJS.Signals[] = ["SIGTERM", "SIGKILL", "SIGINT"];
      const killSignal = validSignals.includes(signal) ? signal : "SIGTERM";

      const killed = terminalSessionManager.killSession(id, killSignal);

      if (!killed) {
        const session = terminalSessionManager.getSession(id);
        if (!session) {
          throw notFound("Session not found");
        }
        throw badRequest("Session is not running");
      }

      res.json({ killed: true, sessionId: id });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/terminal/sessions/:id", (req, res) => {
    try {
      const session = terminalSessionManager.getSession(req.params.id);

      if (!session) {
        throw notFound("Session not found");
      }

      res.json({
        id: session.id,
        command: session.command,
        running: session.exitCode === null && !session.killed,
        exitCode: session.exitCode,
        output: session.output.join(""),
        startTime: session.startTime.toISOString(),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/terminal/sessions/:id/stream", (req, res) => {
    try {
      const { id } = req.params;
      const session = terminalSessionManager.getSession(id);

      if (!session) {
        throw notFound("Session not found");
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      res.write(`event: connected\ndata: ${JSON.stringify({ sessionId: id })}\n\n`);

      const onOutput = (event: TerminalOutputEvent) => {
        if (event.sessionId !== id) return;

        const eventName = event.type === "exit" ? "terminal:exit" : "terminal:output";
        const data = JSON.stringify({
          type: event.type,
          data: event.data,
          ...(event.exitCode !== undefined && { exitCode: event.exitCode }),
        });

        res.write(`event: ${eventName}\ndata: ${data}\n\n`);

        if (event.type === "exit") {
          setTimeout(() => {
            res.end();
          }, 100);
        }
      };

      terminalSessionManager.on("output", onOutput);

      req.on("close", () => {
        terminalSessionManager.off("output", onOutput);
      });

      req.on("error", () => {
        terminalSessionManager.off("output", onOutput);
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/terminal/sessions", async (req, res) => {
    try {
      const { cwd, cols, rows } = req.body;
      const { store: scopedStore } = await getProjectContext(req);
      const terminalService = getTerminalService(scopedStore.getRootDir());

      const result = await terminalService.createSession({
        cwd,
        cols: typeof cols === "number" ? cols : undefined,
        rows: typeof rows === "number" ? rows : undefined,
      });

      if (!result.success) {
        const statusByCode = {
          max_sessions: 503,
          invalid_shell: 400,
          invalid_cwd: 400,
          pty_load_failed: 503,
          pty_spawn_failed: 500,
        } as const;

        throw new ApiError(statusByCode[result.code], result.error, { code: result.code });
      }

      res.status(201).json({
        sessionId: result.session.id,
        shell: result.session.shell,
        cwd: result.session.cwd,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create terminal session");
    }
  });

  router.get("/terminal/sessions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const terminalService = getTerminalService(scopedStore.getRootDir());
      const sessions = terminalService.getAllSessions();

      res.json(
        sessions.map((session) => ({
          id: session.id,
          cwd: session.cwd,
          shell: session.shell,
          createdAt: session.createdAt.toISOString(),
          lastActivityAt: session.lastActivityAt.toISOString(),
        })),
      );
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list sessions");
    }
  });

  router.delete("/terminal/sessions/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { store: scopedStore } = await getProjectContext(req);
      const terminalService = getTerminalService(scopedStore.getRootDir());

      const killed = terminalService.killSession(id);

      if (!killed) {
        const session = terminalService.getSession(id);
        if (!session) {
          throw notFound("Session not found");
        }
        throw badRequest("Failed to kill session");
      }

      res.json({ killed: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
}
