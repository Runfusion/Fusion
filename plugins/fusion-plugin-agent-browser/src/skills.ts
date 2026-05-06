import type { PluginSkillContribution } from "@fusion/plugin-sdk";

export const AGENT_BROWSER_SKILLS: PluginSkillContribution[] = [
  {
    skillId: "agent-browser-navigation",
    name: "Agent Browser Navigation",
    description: "Navigate pages, collect evidence, and summarize findings.",
    skillFiles: ["skills/agent-browser-navigation/SKILL.md"],
    enabled: true,
    triggerPatterns: ["browse", "visit website", "collect evidence"],
  },
];
