/**
 * Browser-safe built-in prompts and prompt catalog.
 *
 * This file contains only client-safe data and does not import any
 * Node.js modules. It's designed to be used by React components
 * in the browser context.
 */

import type { AgentPromptTemplate, AgentCapability } from "@fusion/core";
import type { PromptKey } from "@fusion/core";

/** Built-in agent prompt templates for the browser */
export const BUILTIN_AGENT_PROMPTS: readonly AgentPromptTemplate[] = [
  {
    id: "default-executor",
    name: "Default Executor",
    description: "Standard task execution agent with full tooling and review support.",
    role: "executor" as AgentCapability,
    prompt: "You are a task execution agent for \"fn\", an AI-orchestrated task board.\n\nYou are working in a git worktree isolated from the main branch. Your job is to implement the task described in the PROMPT.md specification you're given.",
    builtIn: true,
  },
  {
    id: "default-triage",
    name: "Default Triage",
    description: "Standard task specification agent producing detailed PROMPT.md files.",
    role: "triage" as AgentCapability,
    prompt: "You are a task specification agent for \"fn\", an AI-orchestrated task board.\n\nYour job: take a rough task description and produce a fully specified PROMPT.md that another AI agent can execute autonomously.",
    builtIn: true,
  },
  {
    id: "default-reviewer",
    name: "Default Reviewer",
    description: "Standard independent code and plan reviewer with balanced criteria.",
    role: "reviewer" as AgentCapability,
    prompt: "You are an independent code and plan reviewer.\n\nYou provide quality assessment for task implementations with full read access to the codebase.",
    builtIn: true,
  },
  {
    id: "default-merger",
    name: "Default Merger",
    description: "Standard merge agent for squash merges with conflict resolution.",
    role: "merger" as AgentCapability,
    prompt: "You are a merge agent for \"fn\", an AI-orchestrated task board.\n\nYour job is to finalize a squash merge: resolve any conflicts and write a good commit message.",
    builtIn: true,
  },
  {
    id: "senior-engineer",
    name: "Senior Engineer",
    description: "Autonomous executor with architectural awareness, performance focus, and minimal hand-holding.",
    role: "executor" as AgentCapability,
    prompt: "You are a senior engineering agent for \"fn\", an AI-orchestrated task board.\n\nYou operate with a high degree of autonomy, making architectural decisions and balancing trade-offs independently.",
    builtIn: true,
  },
  {
    id: "strict-reviewer",
    name: "Strict Reviewer",
    description: "Rigorous reviewer with stricter criteria for security, edge cases, and type safety.",
    role: "reviewer" as AgentCapability,
    prompt: "You are a strict code and plan reviewer with rigorous standards.\n\nYou hold all submissions to a high bar for correctness, security, and maintainability.",
    builtIn: true,
  },
  {
    id: "concise-triage",
    name: "Concise Triage",
    description: "Shorter, more focused specification format with minimal prose.",
    role: "triage" as AgentCapability,
    prompt: "You are a task specification agent for \"fn\". Produce a concise, actionable PROMPT.md from the given task description.\n\nBe brief and precise — avoid verbosity.",
    builtIn: true,
  },
];

/** Prompt key catalog for the browser */
export interface PromptKeyMetadata {
  key: PromptKey;
  name: string;
  roles: AgentCapability[];
  description: string;
  defaultContent: string;
}

export const PROMPT_KEY_CATALOG: Record<PromptKey, PromptKeyMetadata> = {
  "executor-welcome": {
    key: "executor-welcome",
    name: "Executor Welcome",
    roles: ["executor"],
    description: "Introductory section for the executor agent",
    defaultContent: "You are a task execution agent...",
  },
  "executor-guardrails": {
    key: "executor-guardrails",
    name: "Executor Guardrails",
    roles: ["executor"],
    description: "Behavioral guardrails and constraints for the executor",
    defaultContent: "Treat the File Scope in PROMPT.md...",
  },
  "executor-spawning": {
    key: "executor-spawning",
    name: "Executor Spawning",
    roles: ["executor"],
    description: "Instructions for spawning child agents",
    defaultContent: "You can spawn child agents...",
  },
  "executor-completion": {
    key: "executor-completion",
    name: "Executor Completion",
    roles: ["executor"],
    description: "Completion criteria and signaling for executor",
    defaultContent: "After all steps are done...",
  },
  "triage-welcome": {
    key: "triage-welcome",
    name: "Triage Welcome",
    roles: ["triage"],
    description: "Introductory section for the triage/specification agent",
    defaultContent: "You are a task specification agent...",
  },
  "triage-context": {
    key: "triage-context",
    name: "Triage Context",
    roles: ["triage"],
    description: "Context-gathering instructions for triage",
    defaultContent: "What you receive: A raw task title...",
  },
  "reviewer-verdict": {
    key: "reviewer-verdict",
    name: "Reviewer Verdict",
    roles: ["reviewer"],
    description: "Verdict criteria and format for code/review agent",
    defaultContent: "APPROVE — Step will achieve its stated outcomes...",
  },
  "merger-conflicts": {
    key: "merger-conflicts",
    name: "Merger Conflicts",
    roles: ["merger"],
    description: "Merge conflict resolution instructions for merger",
    defaultContent: "If there are merge conflicts...",
  },
  "agent-generation-system": {
    key: "agent-generation-system",
    name: "Agent Generation System",
    roles: ["executor"],
    description: "System prompt for generating agent specifications",
    defaultContent: "You are an agent specification generator...",
  },
  "workflow-step-refine": {
    key: "workflow-step-refine",
    name: "Workflow Step Refine",
    roles: ["executor"],
    description: "System prompt for refining workflow step descriptions",
    defaultContent: "You are an expert at creating detailed agent prompts...",
  },
  "planning-system": {
    key: "planning-system",
    name: "Planning System",
    roles: ["triage"],
    description: "System prompt for the AI planning assistant",
    defaultContent: "You are a planning assistant for the fn task board system...",
  },
  "subtask-breakdown-system": {
    key: "subtask-breakdown-system",
    name: "Subtask Breakdown System",
    roles: ["executor"],
    description: "System prompt for AI subtask decomposition",
    defaultContent: "You are a task decomposition assistant...",
  },
  "mission-interview-system": {
    key: "mission-interview-system",
    name: "Mission Interview System",
    roles: ["triage"],
    description: "System prompt for AI-assisted mission planning",
    defaultContent: "You are a mission planning assistant...",
  },
  "ai-refine-system": {
    key: "ai-refine-system",
    name: "AI Refine System",
    roles: ["executor"],
    description: "System prompt for AI-powered text refinement",
    defaultContent: "You are a text refinement assistant...",
  },
};
