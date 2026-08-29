/**
 * Renderer entry resolution for Electron desktop shell.
 *
 * Production: loads embedded renderer assets from dist/client/index.html
 * Development: loads from FUSION_DASHBOARD_URL or localhost:5173
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const DEFAULT_DEV_DASHBOARD_URL = "http://localhost:5173";

/**
 * Determines if the app is running in development mode.
 * Development mode is active when:
 * - NODE_ENV is "development", OR
 * - --dev flag is passed in command line arguments
 */
export function isDevelopmentMode(): boolean {
  return process.env.NODE_ENV === "development" || process.argv.includes("--dev");
}

/**
 * Gets the renderer URL for loading the dashboard UI.
 *
 * In development mode: uses FUSION_DASHBOARD_URL env var or defaults to localhost:5173
 * In production mode: loads from embedded renderer assets (file:// path to dist/client/index.html)
 */
export function getRendererUrl(): string {
  if (isDevelopmentMode()) {
    return process.env.FUSION_DASHBOARD_URL ?? DEFAULT_DEV_DASHBOARD_URL;
  }

  // Production: use embedded renderer assets
  // This path is relative to the bundled main.js location
  const rendererIndexPath = join(import.meta.dirname, "client", "index.html");
  return pathToFileURL(rendererIndexPath).toString();
}

/**
 * Gets the renderer file path for loadFile() calls.
 * Returns the absolute file path (not a URL).
 */
export function getRendererFilePath(): string {
  if (isDevelopmentMode()) {
    // In development, we use loadURL, not loadFile
    return "";
  }

  // Production: return the absolute file path
  return join(import.meta.dirname, "client", "index.html");
}

/**
 * Checks if the renderer should be loaded from a URL (development)
 * vs file path (production).
 */
export function isUrlRenderer(): boolean {
  if (isDevelopmentMode()) {
    // In dev, always use URL unless explicitly told to use file path
    const override = process.env.FUSION_USE_FILE_RENDERER;
    return override !== "true";
  }

  // In production, always use file path
  return false;
}

// Re-export for backward compatibility
export const IS_DEVELOPMENT = isDevelopmentMode();
export { getRendererUrl as DASHBOARD_URL };
