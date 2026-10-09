import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FUSION_AI_CENSUS_PATTERNS,
  aiTransparencySurfaces,
  validateAiTransparencyRegistry,
} from "../../compliance/aiTransparencySurfaces";

const componentsDir = resolve(process.cwd(), "app/components");

function productionTsxFiles(dir = componentsDir, prefix = ""): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    if (name === "__tests__") continue;
    const absolute = `${dir}/${name}`;
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(absolute).isDirectory()) {
      for (const [child, source] of productionTsxFiles(absolute, relative)) files.set(child, source);
    } else if (name.endsWith(".tsx")) {
      files.set(relative, readFileSync(absolute, "utf8"));
    }
  }
  return files;
}

function findUnregistered(files: ReadonlyMap<string, string>): string[] {
  const registered = new Set(aiTransparencySurfaces.flatMap((surface) => [...surface.sourceFiles]));
  return [...files]
    .filter(([, source]) => FUSION_AI_CENSUS_PATTERNS.some((pattern) => pattern.test(source)))
    .map(([file]) => file)
    .filter((file) => !registered.has(file))
    .sort();
}

describe("Fusion AI transparency coverage registry", () => {
  it("is internally valid and classifies every required baseline candidate", () => {
    expect(validateAiTransparencyRegistry()).toEqual([]);
    const registered = new Set(aiTransparencySurfaces.flatMap((surface) => [...surface.sourceFiles]));
    const requiredCandidates = [
      "StandardChatSurface.tsx",
      "ChatView.tsx",
      "TaskPlannerChatTab.tsx",
      "TaskChatTab.tsx",
      "AgentLogViewer.tsx",
      "WorkflowResultsTab.tsx",
      "PlanningModeModal.tsx",
      "AgentGenerationModal.tsx",
      "GitHubImportTranslateControls.tsx",
      "ResearchView.tsx",
      "InsightsView.tsx",
      "EvalsView.tsx",
      "TaskReviewTab.tsx",
      "TaskRecommendationsTab.tsx",
      "TaskHistoryTab.tsx",
      "command-center/IdeationPanel.tsx",
      "DocumentsView.tsx",
      "TaskDocumentsTab.tsx",
      "MailboxMessageContent.tsx",
      "MissionManager.tsx",
    ];
    expect(requiredCandidates.filter((file) => !registered.has(file))).toEqual([]);
  });

  it("fails a synthetic unregistered AI render branch", () => {
    const synthetic = new Map(productionTsxFiles());
    synthetic.set("UnregisteredAiSurface.tsx", "export const message = { role: \"assistant\" };");
    expect(findUnregistered(synthetic)).toContain("UnregisteredAiSurface.tsx");
  });

  it("has no unregistered production source branch in the deterministic census", () => {
    expect(findUnregistered(productionTsxFiles())).toEqual([]);
  });

  it("keeps every included surface tied to a production disclosure placement", () => {
    const files = productionTsxFiles();
    for (const surface of aiTransparencySurfaces.filter((entry) => entry.decision === "included")) {
      expect(
        surface.sourceFiles.some((file) => files.get(file)?.includes("AiDisclosure")),
        `${surface.id} has no AiDisclosure placement`,
      ).toBe(true);
    }
  });
});
