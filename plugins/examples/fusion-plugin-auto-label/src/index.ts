import { definePlugin } from "@fusion/plugin-sdk";
import type {
  FusionPlugin,
  PluginContext,
  PluginToolDefinition,
  PluginToolResult,
} from "@fusion/plugin-sdk";

// ── Category Rules ─────────────────────────────────────────────────────────────

interface CategoryRule {
  keywords: string[];
  label: string;
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    keywords: ["bug", "fix", "broken", "crash", "error"],
    label: "bug",
  },
  {
    keywords: ["feature", "add", "new", "implement"],
    label: "feature",
  },
  {
    keywords: ["docs", "documentation", "readme", "guide"],
    label: "documentation",
  },
  {
    keywords: ["test", "tests", "testing", "spec", "coverage"],
    label: "testing",
  },
  {
    keywords: ["refactor", "cleanup", "clean up", "reorganize"],
    label: "refactor",
  },
  {
    keywords: ["perf", "performance", "optimize", "slow"],
    label: "performance",
  },
];

// ── Text Classification ────────────────────────────────────────────────────────

/**
 * Classify text into categories based on keyword matching.
 * Returns an array of matching category labels.
 */
export function classifyText(text: string): string[] {
  const lowerText = text.toLowerCase();
  const matchedLabels: string[] = [];

  for (const rule of CATEGORY_RULES) {
    for (const keyword of rule.keywords) {
      // Match whole word boundaries using word characters
      const regex = new RegExp(`\\b${keyword}\\b`, "i");
      if (regex.test(lowerText)) {
        if (!matchedLabels.includes(rule.label)) {
          matchedLabels.push(rule.label);
        }
        break; // Move to next rule once keyword matches
      }
    }
  }

  return matchedLabels;
}

// ── Plugin Tool ─────────────────────────────────────────────────────────────────

const autoLabelTool: PluginToolDefinition = {
  name: "auto_label_classify",
  description:
    "Classify a text description into categories (bug, feature, documentation, testing, refactor, performance). Returns an array of matching labels.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to classify",
      },
    },
    required: ["text"],
  },
  execute: async (
    params: Record<string, unknown>,
    _ctx: PluginContext,
  ): Promise<PluginToolResult> => {
    const text = params.text as string;
    if (!text || typeof text !== "string") {
      return {
        content: [{ type: "text", text: JSON.stringify([]) }],
        isError: false,
      };
    }

    const labels = classifyText(text);
    return {
      content: [{ type: "text", text: JSON.stringify(labels) }],
      isError: false,
    };
  },
};

// ── Plugin Definition ───────────────────────────────────────────────────────────

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-auto-label",
    name: "Auto-Label Plugin",
    version: "0.1.0",
    description: "Automatically labels tasks based on description content",
  },
  state: "installed",
  tools: [autoLabelTool],
  hooks: {
    onLoad: (ctx) => {
      ctx.logger.info(
        `Auto-Label plugin loaded with ${CATEGORY_RULES.length} category rules`,
      );
    },

    onTaskCreated: async (task, ctx) => {
      const labels = classifyText(task.description || "");
      if (labels.length > 0) {
        ctx.logger.info(
          `Task ${task.id} classified with labels: ${labels.join(", ")}`,
        );
        ctx.emitEvent("auto-label:classified", {
          taskId: task.id,
          labels,
        });
      } else {
        ctx.logger.info(`Task ${task.id} did not match any categories`);
      }
    },
  },
});

export default plugin;
