import type { PluginToolDefinition } from "@fusion/plugin-sdk";
import { resolveSettings } from "./types.js";

export const AGENT_BROWSER_TOOLS: PluginToolDefinition[] = [
  {
    name: "browser_fetch_metadata",
    description: "Validate a URL against plugin allowlist and return safe fetch metadata.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    execute: async (params, ctx) => {
      const url = typeof params.url === "string" ? params.url : "";
      try {
        const parsed = new URL(url);
        const settings = resolveSettings(ctx.settings);
        const allowed = settings.allowedDomains;
        const isAllowed = allowed.length === 0 || allowed.some((d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`));

        if (!isAllowed) {
          return { content: [{ type: "text", text: `Blocked by allowedDomains: ${parsed.hostname}` }], isError: true };
        }

        return {
          content: [{ type: "text", text: `Allowed URL ${parsed.toString()} (headless=${String(settings.headlessMode)})` }],
          details: { hostname: parsed.hostname, headlessMode: settings.headlessMode },
        };
      } catch {
        return { content: [{ type: "text", text: "Invalid URL" }], isError: true };
      }
    },
  },
];
