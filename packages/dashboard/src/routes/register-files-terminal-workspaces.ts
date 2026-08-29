import { terminalSessionManager } from "../terminal.js";
import { getTerminalService } from "../terminal-service.js";
import { registerFileWorkspaceRoutes } from "./register-file-workspace-routes.js";
import { registerSessionDiffRoutes } from "./register-session-diff-routes.js";
import { registerTerminalRoutes } from "./register-terminal-routes.js";
import type { ApiRoutesContext } from "./types.js";

/**
 * Registers filesystem/workspace, session-diff, and terminal infrastructure routes.
 *
 * Ordering is part of the API contract:
 * 1) session/diff routes
 * 2) file/workspace routes
 * 3) terminal routes
 */
export function registerFilesTerminalWorkspaceRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext } = ctx;

  registerSessionDiffRoutes(router, { getProjectContext });
  registerFileWorkspaceRoutes(ctx);
  registerTerminalRoutes(router, {
    getProjectContext,
    terminalSessionManager,
    getTerminalService,
  });
}
