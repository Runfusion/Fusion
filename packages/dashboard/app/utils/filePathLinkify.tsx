import "./filePathLinkify.css";
import React, { cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { useFileBrowser } from "../context/FileBrowserContext";

// Two branches: the main branch requires a slash plus extension to avoid plain-prose false positives,
// while the allowlist branch covers well-known root files agents commonly reference without a slash.
export const FILE_PATH_REGEX = /(?<![\w@-])((?:[A-Za-z0-9_./@-]+\/)+[A-Za-z0-9_./@-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?|(?:Dockerfile|Makefile|AGENTS\.md|README\.md|README)(?::\d+(?::\d+)?)?)(?![\w-])/g;

const EXCLUDED_PROTOCOLS = ["http://", "https://", "mailto:", "git@", "ftp://"];
const WELL_KNOWN_ROOT_FILES = new Set(["Dockerfile", "Makefile", "AGENTS.md", "README.md", "README"]);

function parseFilePathMatch(value: string): { path: string; line?: number; col?: number } {
  const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(value);
  if (!match) {
    return { path: value };
  }

  return {
    path: match[1] ?? value,
    line: match[2] ? Number.parseInt(match[2], 10) : undefined,
    col: match[3] ? Number.parseInt(match[3], 10) : undefined,
  };
}

function isVersionLike(value: string): boolean {
  return /^v?\d+(?:\.\d+)+$/.test(value);
}

function hasPathSeparatorOrAllowlist(path: string): boolean {
  return path.includes("/") || WELL_KNOWN_ROOT_FILES.has(path);
}

function isExcludedMatch(source: string, start: number, rawMatch: string): boolean {
  const prefix = source.slice(Math.max(0, start - 16), start).toLowerCase();
  if (rawMatch.startsWith("//") || EXCLUDED_PROTOCOLS.some((protocol) => prefix.endsWith(protocol))) {
    return true;
  }

  const { path } = parseFilePathMatch(rawMatch);
  if (isVersionLike(path)) {
    return true;
  }

  if (!hasPathSeparatorOrAllowlist(path)) {
    return true;
  }

  return false;
}

export function FilePathLink({
  path,
  line,
  col,
  children,
}: {
  path: string;
  line?: number;
  col?: number;
  children?: ReactNode;
}) {
  const fileBrowser = useFileBrowser();

  if (!fileBrowser) {
    return <span>{children ?? path}</span>;
  }

  return (
    <button
      type="button"
      className="file-path-link"
      onClick={() => fileBrowser.openFile(path, { line, col })}
    >
      {children ?? path}
    </button>
  );
}

export function linkifyFilePaths(text: string, options?: { keyPrefix?: string }): ReactNode[] {
  if (!text) {
    return [text];
  }

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;

  for (const match of text.matchAll(FILE_PATH_REGEX)) {
    const rawMatch = match[0];
    const start = match.index ?? 0;
    const end = start + rawMatch.length;

    if (isExcludedMatch(text, start, rawMatch)) {
      continue;
    }

    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }

    const { path, line, col } = parseFilePathMatch(rawMatch);
    nodes.push(
      <FilePathLink
        key={`${options?.keyPrefix ?? "file-path"}-${start}-${matchIndex}`}
        path={path}
        line={line}
        col={col}
      >
        {rawMatch}
      </FilePathLink>,
    );
    lastIndex = end;
    matchIndex += 1;
  }

  if (lastIndex === 0) {
    return [text];
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function linkifyReactChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") {
    const nodes = linkifyFilePaths(children);
    return nodes.length === 1 ? nodes[0] : <>{nodes}</>;
  }

  if (Array.isArray(children)) {
    return React.Children.map(children, (child) => linkifyReactChildren(child));
  }

  if (!isValidElement<{ children?: ReactNode }>(children)) {
    return children;
  }

  if (typeof children.type === "string" && ["button", "code", "pre"].includes(children.type)) {
    return children;
  }

  if (children.props.children === undefined) {
    return children;
  }

  return cloneElement(
    children as ReactElement<{ children?: ReactNode }>,
    undefined,
    React.Children.map(children.props.children, (child) => linkifyReactChildren(child)),
  );
}
