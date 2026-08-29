export interface PathBreadcrumb {
  label: string;
  path: string;
}

export function normalizeDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/g, "");
}

export function splitPathSegments(path: string): string[] {
  const normalized = normalizeDisplayPath(trimTrailingSeparators(path));
  if (!normalized) return [];
  return normalized.split("/").filter(Boolean);
}

export function getPathBasename(path: string): string {
  const normalized = normalizeDisplayPath(trimTrailingSeparators(path));
  if (!normalized) return path;
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

export function getTrailingPath(path: string, count: number): string {
  const segments = splitPathSegments(path);
  if (segments.length === 0) {
    return normalizeDisplayPath(path);
  }
  return segments.slice(-count).join("/");
}

export function getDisplayDirname(path: string): string {
  const normalized = normalizeDisplayPath(trimTrailingSeparators(path));
  const lastSeparator = normalized.lastIndexOf("/");
  if (lastSeparator < 0) return "";
  return normalized.slice(0, lastSeparator + 1);
}

export function joinDisplayPath(basePath: string, name: string): string {
  if (!basePath || basePath === ".") {
    return name;
  }
  const segments = splitPathSegments(basePath);
  return [...segments, name].join("/");
}

export function getParentDisplayPath(path: string): string {
  const segments = splitPathSegments(path);
  if (segments.length === 0) {
    return ".";
  }
  segments.pop();
  return segments.length === 0 ? "." : segments.join("/");
}

export function getPathBreadcrumbs(path: string): PathBreadcrumb[] {
  const normalized = normalizeDisplayPath(path);
  const winMatch = normalized.match(/^([A-Za-z]:)(?:\/(.*))?$/);
  if (winMatch) {
    const root = `${winMatch[1]}/`;
    const segments = (winMatch[2] ?? "").split("/").filter(Boolean);
    const breadcrumbs: PathBreadcrumb[] = [{ label: winMatch[1], path: root }];
    for (let i = 0; i < segments.length; i += 1) {
      breadcrumbs.push({
        label: segments[i]!,
        path: `${root}${segments.slice(0, i + 1).join("/")}`,
      });
    }
    return breadcrumbs;
  }

  if (normalized.startsWith("/")) {
    const segments = normalized.split("/").filter(Boolean);
    const breadcrumbs: PathBreadcrumb[] = [{ label: "/", path: "/" }];
    for (let i = 0; i < segments.length; i += 1) {
      breadcrumbs.push({
        label: segments[i]!,
        path: `/${segments.slice(0, i + 1).join("/")}`,
      });
    }
    return breadcrumbs;
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments.map((segment, index) => ({
    label: segment,
    path: segments.slice(0, index + 1).join("/"),
  }));
}
