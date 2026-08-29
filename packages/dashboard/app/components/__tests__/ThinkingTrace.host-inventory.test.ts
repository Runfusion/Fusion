import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";

const hosts = [
  "AgentLogViewer.tsx",
  "ConversationHistory.tsx",
  "MilestoneSliceInterviewModal.tsx",
  "MissionInterviewModal.tsx",
  "PlanningModeModal.tsx",
  "StandardChatSurface.tsx",
  "TaskChatTab.tsx",
];
describe("ThinkingTrace host inventory", () => {
  it("pins every direct transcript host and its unprocessed component contract", () => {
    const componentSources = new Map(listComponentFiles()
      .filter((file) => file !== "ThinkingTrace.tsx" && !file.includes("__tests__/"))
      .map((file) => [file, readAppFile(`components/${file}`)]));
    const directHosts = [...componentSources]
      .filter(([, source]) => /import\s+\{[^}]*\bThinkingTrace\b[^}]*\}\s+from\s+["']\.\/ThinkingTrace["']/.test(source) && source.includes("<ThinkingTrace"))
      .map(([path]) => path.split("/").at(-1)!)
      .sort();

    expect(directHosts).toEqual(hosts);
    for (const file of hosts) {
      const source = componentSources.get(file)!;
      expect(source, file).toMatch(/import\s+\{[^}]*\bThinkingTrace\b[^}]*\}\s+from\s+["']\.\/ThinkingTrace["']/);
      const tags = [...source.matchAll(/<ThinkingTrace\b([\s\S]*?)\/>/g)];
      expect(tags, file).not.toHaveLength(0);
      for (const [, tag] of tags) {
        const attributes = [...tag.matchAll(/\b([A-Za-z][\w-]*)\s*=/g)].map((match) => match[1]);
        expect(attributes, file).toEqual(attributes.filter((attribute) => ["text", "format", "className", "testId"].includes(attribute)));
      }
    }
  });

  it("keeps the append-only workflow console raw and unsectioned", () => {
    const source = readAppFile("components/WorkflowResultsTab.tsx");
    expect(source).not.toMatch(/import\s+\{\s*ThinkingTrace\s*\}/);
    expect(source).toContain("workflow-live-log-thinking");
    expect(source).toContain("linkifyFilePaths(entry.text)");
  });
});
