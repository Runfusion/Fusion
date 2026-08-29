import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/core";
import { discoverArtifacts, readArtifactById } from "../artifacts/discovery.js";
import { asString } from "./route-helpers.js";

/**
 * Artifact routes (U3): list discovered CE artifacts grouped by stage, and read
 * a single artifact's content. The render endpoint returns a SELF-CONTAINED HTML
 * document (sandboxed `srcDoc`, inlined styles, no remote assets) mirroring the
 * reports preview/export pattern (docs/plugins/reports.md) so the dashboard can
 * embed it in a sandboxed iframe without leaking host styles or scripts.
 *
 * Project root: artifacts live on disk relative to the project root, which the
 * route reaches via `ctx.taskStore.getRootDir()` (the same root the U5
 * orchestrator writes artifacts to). When a `projectId` is supplied and the host
 * exposes `resolveProjectTaskStore`, the per-project root is used.
 */

interface RouteRequest {
  params: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
}

async function resolveProjectRoot(ctx: PluginContext, projectId?: string): Promise<string> {
  if (projectId && ctx.resolveProjectTaskStore) {
    try {
      const store = await ctx.resolveProjectTaskStore(projectId);
      return store.getRootDir();
    } catch {
      // Fall through to the default task store root.
    }
  }
  return ctx.taskStore.getRootDir();
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Wrap raw artifact markdown in a fully self-contained HTML document. Content is
 * HTML-escaped and rendered inside `<pre>` so nothing in the artifact can inject
 * markup or script; styles are inlined; there are no remote `href`/`src` URLs.
 * `data-section` markers mirror the reports rendering contract so an embedding
 * viewer can offer section quick-jumps without re-parsing.
 */
export function renderArtifactDocument(name: string, content: string): string {
  const escaped = escapeHtml(content);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(name)}</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.5; background: #ffffff; color: #1a1a1a; }
@media (prefers-color-scheme: dark) { body { background: #16181d; color: #e6e6e6; } }
.artifact-doc { padding: 1.25rem 1.5rem; }
.artifact-doc h1 { font-size: 1.1rem; margin: 0 0 1rem; font-family: ui-sans-serif, system-ui, sans-serif; }
.artifact-body { white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 0.85rem; }
</style>
</head>
<body>
<main class="artifact-doc" data-section="artifact">
<h1 data-section="title">${escapeHtml(name)}</h1>
<pre class="artifact-body" data-section="content">${escaped}</pre>
</main>
</body>
</html>`;
}

export function createArtifactRoutes(): PluginRouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/artifacts",
      description: "List discovered CE artifacts grouped by stage.",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const query = (req as RouteRequest).query ?? {};
        const projectId = asString(query.projectId);
        const root = await resolveProjectRoot(ctx, projectId);
        const result = discoverArtifacts(root);
        return { status: 200, body: result };
      },
    },
    {
      method: "GET",
      path: "/artifacts/:id",
      description: "Read a single CE artifact's raw content (JSON).",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const request = req as RouteRequest;
        const id = decodeURIComponent(request.params.id);
        const projectId = asString(request.query?.projectId);
        const root = await resolveProjectRoot(ctx, projectId);
        const result = readArtifactById(root, id);
        if (!result) return { status: 404, body: { error: `Artifact ${id} not found` } };
        if ("error" in result) return { status: 422, body: { error: result.error } };
        return { status: 200, body: { artifact: result.artifact, content: result.content } };
      },
    },
    {
      method: "GET",
      path: "/artifacts/:id/preview.html",
      description: "Read a single CE artifact rendered as a self-contained HTML document.",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const request = req as RouteRequest;
        const id = decodeURIComponent(request.params.id);
        const projectId = asString(request.query?.projectId);
        const root = await resolveProjectRoot(ctx, projectId);
        const result = readArtifactById(root, id);
        if (!result) return { status: 404, body: { error: `Artifact ${id} not found` } };
        if ("error" in result) return { status: 422, body: { error: result.error } };
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: renderArtifactDocument(result.artifact.name, result.content),
        };
      },
    },
  ];
}
