/**
 * projectDetection.ts - Client-side project detection utilities
 * 
 * Provides utilities for scanning and detecting fusion projects.
 * These functions prepare data for API calls rather than accessing
 * the filesystem directly (which is not possible from browser).
 */

import type { DetectedProject } from "../api";

export interface DetectionOptions {
  /** Maximum depth to scan (default: 3) */
  maxDepth?: number;
  /** Base path to scan from */
  basePath?: string;
}

/**
 * Prepares a scan request for projects.
 * This function returns the configuration for a scan - the actual
 * scanning happens server-side via the detectProjects API.
 */
export function prepareProjectScan(
  basePath: string = "",
  maxDepth: number = 3
): { basePath: string; maxDepth: number } {
  return {
    basePath: basePath || getDefaultScanPath(),
    maxDepth: Math.min(Math.max(maxDepth, 1), 5), // Clamp between 1-5
  };
}

/**
 * Filters detected projects to exclude already registered ones.
 */
export function filterNewProjects(
  detected: DetectedProject[],
  registered: { path: string }[]
): DetectedProject[] {
  const registeredPaths = new Set(registered.map((p) => normalizePath(p.path)));
  return detected.filter((p) => !registeredPaths.has(normalizePath(p.path)));
}

/**
 * Validates a project path client-side.
 * Returns validation result - server does final validation.
 */
export function validateProjectPath(path: string): {
  valid: boolean;
  error?: string;
} {
  if (!path || path.trim().length === 0) {
    return { valid: false, error: "Path is required" };
  }

  if (path.includes("..") || path.includes("~")) {
    return { valid: false, error: "Path cannot contain .. or ~" };
  }

  // Must be absolute path
  if (!path.startsWith("/") && !path.match(/^[A-Za-z]:/)) {
    return { valid: false, error: "Path must be absolute" };
  }

  return { valid: true };
}

/**
 * Generates a suggested project name from a path.
 */
export function suggestProjectName(path: string): string {
  // Get the last non-empty segment of the path
  const segments = path.split(/[/\\]/).filter((s) => s.length > 0);
  const name = segments[segments.length - 1] || "My Project";
  
  // Clean up the name
  return name
    .replace(/[^a-zA-Z0-9-_]/g, "-") // Replace special chars with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, "") // Trim leading/trailing hyphens
    || "My Project";
}

/**
 * Validates a project name.
 */
export function validateProjectName(
  name: string,
  existingProjects?: { name: string }[]
): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: "Name is required" };
  }

  if (name.length < 1 || name.length > 64) {
    return { valid: false, error: "Name must be between 1 and 64 characters" };
  }

  if (!/^[a-zA-Z0-9-_]+$/.test(name)) {
    return { valid: false, error: "Name can only contain letters, numbers, hyphens, and underscores" };
  }

  if (existingProjects) {
    const exists = existingProjects.some(
      (p) => p.name.toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      return { valid: false, error: "A project with this name already exists" };
    }
  }

  return { valid: true };
}

/**
 * Normalizes a path for comparison.
 */
function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/") // Convert backslashes to forward slashes
    .replace(/\/$/, "") // Remove trailing slash
    .toLowerCase();
}

/**
 * Gets the default path for scanning.
 * In browser context, this returns a sensible default.
 */
function getDefaultScanPath(): string {
  // In a browser, we can't determine the user's home directory
  // The server will handle this if empty
  return "";
}

/**
 * Sorts detected projects by likelihood of being a fn project.
 * Projects with .fusion/fusion.db are ranked higher.
 */
export function sortDetectedProjects(projects: DetectedProject[]): DetectedProject[] {
  return [...projects].sort((a, b) => {
    // Existing projects (with fusion.db) come first
    if (a.existing && !b.existing) return -1;
    if (!a.existing && b.existing) return 1;
    return 0;
  });
}
