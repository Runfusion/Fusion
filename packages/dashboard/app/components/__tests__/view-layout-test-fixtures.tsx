import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { readAppFile } from "../../test/cssFixture";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:31:
FN-379 shares one mounting helper and one source-construct reader across the view-layout families so every
destination is exercised through the real provider identity instead of a bespoke per-suite shell. Tests read
code constructs only; comments, date stamps, and FNXC prose are never a test subject.
*/

/** Mounts a real destination under the project-scoped shared layout provider. */
export function renderWithViewLayout(ui: ReactElement, projectId = "project-inventory"): RenderResult {
  return render(<ViewLayoutProvider projectId={projectId}>{ui}</ViewLayoutProvider>);
}

/** Reads a dashboard app source file for construct-level architecture guards. */
export function readSource(appRelativePath: string): string {
  return readAppFile(appRelativePath);
}

/** Strips block and line comments so construct guards never match explanatory prose. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Reads a source file with its comments removed. */
export function readCode(appRelativePath: string): string {
  return stripComments(readSource(appRelativePath));
}
