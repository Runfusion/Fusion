import { readFileSync } from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPromptsManager } from "../AgentPromptsManager";
import { BUILTIN_AGENT_PROMPTS } from "../../utils/builtinPrompts";
import type { AgentPromptsConfig } from "@fusion/core";

// Mock the builtinPrompts utility to avoid importing the large prompt texts
vi.mock("../../utils/builtinPrompts", () => ({
  BUILTIN_AGENT_PROMPTS: [
    {
      id: "default-executor",
      name: "Default Executor",
      description: "Standard task execution agent with full tooling.",
      role: "executor",
      prompt: "You are a task execution agent responsible for implementing scoped tasks with precision. Always read PROMPT.md, run tests, keep git history clean, and verify lint, tests, and build pass before calling task_done.",
      builtIn: true,
    },
    {
      id: "default-triage",
      name: "Default Triage",
      description: "Standard task specification agent.",
      role: "triage",
      prompt: "You are a task specification agent...",
      builtIn: true,
    },
    {
      id: "default-reviewer",
      name: "Default Reviewer",
      description: "Standard independent code and plan reviewer.",
      role: "reviewer",
      prompt: "You are an independent code and plan reviewer.",
      builtIn: true,
    },
    {
      id: "default-merger",
      name: "Default Merger",
      description: "Standard merge agent for squash merges.",
      role: "merger",
      prompt: "You are a merge agent.",
      builtIn: true,
    },
  ],
  PROMPT_KEY_CATALOG: {
    "executor-welcome": {
      key: "executor-welcome",
      name: "Executor Welcome",
      roles: ["executor"],
      description: "Introductory section for the executor",
      defaultContent: "You are a task execution agent...",
    },
    "triage-welcome": {
      key: "triage-welcome",
      name: "Triage Welcome",
      roles: ["triage"],
      description: "Introductory section for triage",
      defaultContent: "You are a task specification agent...",
    },
  },
}));

const defaultConfig: AgentPromptsConfig = {};

const onChange = vi.fn();
const onPromptOverridesChange = vi.fn();

const stylesContent = loadAllAppCss();
const testStylesId = "agent-prompts-manager-test-styles";

beforeEach(() => {
  vi.clearAllMocks();

  if (!document.getElementById(testStylesId)) {
    const styleElement = document.createElement("style");
    styleElement.id = testStylesId;
    styleElement.textContent = stylesContent;
    document.head.appendChild(styleElement);
  }
});

describe("AgentPromptsManager", () => {
  describe("Tab Navigation", () => {
    it("renders all three tabs", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      expect(screen.getByTestId("tab-templates")).toBeTruthy();
      expect(screen.getByTestId("tab-assignments")).toBeTruthy();
      expect(screen.getByTestId("tab-overrides")).toBeTruthy();
    });

    it("Templates tab is active by default", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      expect(screen.getByTestId("tab-templates")).toHaveClass(/active/);
    });

    it("clicking a tab switches active state", async () => {
      const user = userEvent.setup();
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Assignments tab
      await user.click(screen.getByTestId("tab-assignments"));
      expect(screen.getByTestId("tab-assignments")).toHaveClass(/active/);
      expect(screen.getByTestId("tab-templates")).not.toHaveClass(/active/);

      // Click Overrides tab
      await user.click(screen.getByTestId("tab-overrides"));
      expect(screen.getByTestId("tab-overrides")).toHaveClass(/active/);
    });
  });

  describe("Templates Tab", () => {
    it("renders built-in templates as read-only cards", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Should show built-in templates section
      expect(screen.getByTestId("builtin-templates")).toBeTruthy();
      expect(screen.getByTestId("builtin-template-default-executor")).toBeTruthy();
      expect(screen.getByTestId("builtin-template-default-triage")).toBeTruthy();

      // Should show Built-in badge
      expect(screen.getAllByText("Built-in").length).toBe(4);
    });

    it("built-in template cards have role badges", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      expect(screen.getAllByText("Executor Agent").length).toBe(1);
      expect(screen.getAllByText("Triage Agent").length).toBe(1);
      expect(screen.getAllByText("Reviewer Agent").length).toBe(1);
      expect(screen.getAllByText("Merger Agent").length).toBe(1);
    });

    it("template preview shows full prompt text (not truncated)", () => {
      const defaultExecutorTemplate = BUILTIN_AGENT_PROMPTS.find(
        (template) => template.id === "default-executor",
      );

      if (!defaultExecutorTemplate) {
        throw new Error("default-executor template is required for this test");
      }

      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      const card = screen.getByTestId("builtin-template-default-executor");
      const previewCode = card.querySelector(".prompt-template-card-preview code");

      expect(previewCode).toBeTruthy();
      expect(previewCode?.textContent).toBe(defaultExecutorTemplate.prompt);
      expect(defaultExecutorTemplate.prompt.length).toBeGreaterThan(200);
    });

    it("template preview area has scrollable overflow", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      const card = screen.getByTestId("builtin-template-default-executor");
      const previewCode = card.querySelector(".prompt-template-card-preview code") as HTMLElement | null;

      expect(previewCode).toBeTruthy();
      expect(window.getComputedStyle(previewCode!).maxHeight).toBe("120px");
      expect(window.getComputedStyle(previewCode!).overflowY).toBe("auto");
    });

    it("shows custom templates section", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      expect(screen.getByTestId("custom-templates")).toBeTruthy();
      expect(screen.getByText("No custom templates yet. Create one to get started.")).toBeTruthy();
    });

    it("shows Add Custom Template button", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      expect(screen.getByTestId("add-template-btn")).toBeTruthy();
    });

    it("clicking Add Custom Template shows editor form", async () => {
      const user = userEvent.setup();
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      await user.click(screen.getByTestId("add-template-btn"));

      expect(screen.getByTestId("template-editor")).toBeTruthy();
      expect(screen.getByTestId("template-name-input")).toBeTruthy();
      expect(screen.getByTestId("template-description-input")).toBeTruthy();
      expect(screen.getByTestId("template-role-select")).toBeTruthy();
      expect(screen.getByTestId("template-prompt-input")).toBeTruthy();
    });

    it("creating a custom template fires onChange with new template", async () => {
      const user = userEvent.setup();
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Open editor
      await user.click(screen.getByTestId("add-template-btn"));

      // Fill in the form
      await user.type(screen.getByTestId("template-name-input"), "My Custom Template");
      await user.type(screen.getByTestId("template-description-input"), "A custom description");
      await user.type(screen.getByTestId("template-prompt-input"), "Custom prompt text");

      // Save
      await user.click(screen.getByTestId("save-template-btn"));

      // Verify onChange was called with new template
      expect(onChange).toHaveBeenCalledTimes(1);
      const newConfig = onChange.mock.calls[0][0];
      expect(newConfig.templates).toBeDefined();
      expect(newConfig.templates.length).toBe(1);
      expect(newConfig.templates[0].name).toBe("My Custom Template");
      expect(newConfig.templates[0].id).toBe("my-custom-template");
    });

    it("shows existing custom templates", () => {
      const config: AgentPromptsConfig = {
        templates: [
          {
            id: "my-custom",
            name: "My Custom",
            description: "Custom description",
            role: "executor",
            prompt: "Custom prompt",
            builtIn: false,
          },
        ],
      };

      render(
        <AgentPromptsManager
          value={config}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      expect(screen.getByTestId("custom-template-my-custom")).toBeTruthy();
      expect(screen.getAllByText("Custom").length).toBeGreaterThan(0);
    });

    it("edit button shows editor with existing template data", async () => {
      const user = userEvent.setup();
      const config: AgentPromptsConfig = {
        templates: [
          {
            id: "my-custom",
            name: "My Custom",
            description: "Custom description",
            role: "executor",
            prompt: "Custom prompt",
            builtIn: false,
          },
        ],
      };

      render(
        <AgentPromptsManager
          value={config}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click edit button
      await user.click(screen.getByTestId("edit-my-custom"));

      // Should show editor with existing data
      expect(screen.getByTestId("template-editor")).toBeTruthy();
      expect((screen.getByTestId("template-name-input") as HTMLInputElement).value).toBe("My Custom");
    });

    it("delete button requires confirmation", async () => {
      const user = userEvent.setup();
      const config: AgentPromptsConfig = {
        templates: [
          {
            id: "my-custom",
            name: "My Custom",
            description: "Custom description",
            role: "executor",
            prompt: "Custom prompt",
            builtIn: false,
          },
        ],
      };

      render(
        <AgentPromptsManager
          value={config}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click delete button
      await user.click(screen.getByTestId("delete-my-custom"));

      // Should show confirmation
      expect(screen.getByTestId("confirm-delete-my-custom")).toBeTruthy();
      expect(screen.getByTestId("cancel-delete-my-custom")).toBeTruthy();
    });

    it("confirming delete fires onChange with template removed", async () => {
      const user = userEvent.setup();
      const config: AgentPromptsConfig = {
        templates: [
          {
            id: "my-custom",
            name: "My Custom",
            description: "Custom description",
            role: "executor",
            prompt: "Custom prompt",
            builtIn: false,
          },
        ],
      };

      render(
        <AgentPromptsManager
          value={config}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click delete and confirm
      await user.click(screen.getByTestId("delete-my-custom"));
      await user.click(screen.getByTestId("confirm-delete-my-custom"));

      // Verify onChange was called with empty templates
      expect(onChange).toHaveBeenCalledTimes(1);
      const newConfig = onChange.mock.calls[0][0];
      expect(newConfig.templates).toBeUndefined();
    });
  });

  describe("Assignments Tab", () => {
    it("renders assignment rows for each core role", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Assignments tab
      fireEvent.click(screen.getByTestId("tab-assignments"));

      expect(screen.getByTestId("assignment-executor")).toBeTruthy();
      expect(screen.getByTestId("assignment-triage")).toBeTruthy();
      expect(screen.getByTestId("assignment-reviewer")).toBeTruthy();
      expect(screen.getByTestId("assignment-merger")).toBeTruthy();
    });

    it("shows dropdown with template options", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Assignments tab
      fireEvent.click(screen.getByTestId("tab-assignments"));

      // Executor dropdown should have built-in and "Use default" options
      const executorSelect = screen.getByTestId("select-executor") as HTMLSelectElement;
      expect(executorSelect.options.length).toBeGreaterThan(1); // "Use default" + built-in templates for executor
    });

    it("changing assignment fires onChange", async () => {
      const user = userEvent.setup();
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Assignments tab
      fireEvent.click(screen.getByTestId("tab-assignments"));

      // Select a template
      const select = screen.getByTestId("select-executor");
      fireEvent.change(select, { target: { value: "default-executor" } });

      // Verify onChange was called
      expect(onChange).toHaveBeenCalledTimes(1);
      const newConfig = onChange.mock.calls[0][0];
      expect(newConfig.roleAssignments).toBeDefined();
      expect(newConfig.roleAssignments?.executor).toBe("default-executor");
    });

    it("clearing assignment removes it from config", async () => {
      const user = userEvent.setup();
      const config: AgentPromptsConfig = {
        roleAssignments: {
          executor: "default-executor",
        },
      };

      render(
        <AgentPromptsManager
          value={config}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Assignments tab
      fireEvent.click(screen.getByTestId("tab-assignments"));

      // Select "Use default"
      const select = screen.getByTestId("select-executor");
      fireEvent.change(select, { target: { value: "" } });

      // Verify onChange was called with executor removed
      expect(onChange).toHaveBeenCalledTimes(1);
      const newConfig = onChange.mock.calls[0][0];
      expect(newConfig.roleAssignments?.executor).toBeUndefined();
    });
  });

  describe("Overrides Tab", () => {
    it("renders override accordion items", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Overrides tab
      fireEvent.click(screen.getByTestId("tab-overrides"));

      expect(screen.getByTestId("override-executor-welcome")).toBeTruthy();
      expect(screen.getByTestId("override-triage-welcome")).toBeTruthy();
    });

    it("accordion items are collapsed by default", () => {
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Overrides tab
      fireEvent.click(screen.getByTestId("tab-overrides"));

      // Editor should not be visible
      expect(screen.queryByTestId("override-input-executor-welcome")).toBeNull();
    });

    it("clicking expand button shows editor", async () => {
      const user = userEvent.setup();
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Overrides tab
      fireEvent.click(screen.getByTestId("tab-overrides"));

      // Click expand button
      await user.click(screen.getByTestId("expand-executor-welcome"));

      // Editor should now be visible
      await waitFor(() => {
        expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
      });
    });

    it("editing an override fires onPromptOverridesChange", async () => {
      const user = userEvent.setup();
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{}}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Overrides tab
      fireEvent.click(screen.getByTestId("tab-overrides"));

      // Expand and edit
      await user.click(screen.getByTestId("expand-executor-welcome"));
      await waitFor(() => {
        expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
      });

      const textarea = screen.getByTestId("override-input-executor-welcome") as HTMLTextAreaElement;
      
      // Use fireEvent.change for a single programmatic change
      fireEvent.change(textarea, { target: { value: "Custom override" } });

      // Verify onPromptOverridesChange was called
      await waitFor(() => {
        expect(onPromptOverridesChange).toHaveBeenCalled();
      });
      
      // Check the last call contains the expected value
      const lastCall = onPromptOverridesChange.mock.calls[onPromptOverridesChange.mock.calls.length - 1];
      const newOverrides = lastCall[0];
      expect(newOverrides["executor-welcome"]).toBe("Custom override");
    });

    it("shows Reset button for existing overrides", async () => {
      const user = userEvent.setup();
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{
            "executor-welcome": "Custom text",
          }}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Overrides tab
      fireEvent.click(screen.getByTestId("tab-overrides"));

      // Expand
      await user.click(screen.getByTestId("expand-executor-welcome"));
      await waitFor(() => {
        expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
      });

      // Should show "customized" badge and Reset button
      expect(screen.getByText("customized")).toBeTruthy();
      expect(screen.getByTestId("reset-executor-welcome")).toBeTruthy();
    });

    it("Reset button fires onPromptOverridesChange with null", async () => {
      const user = userEvent.setup();
      render(
        <AgentPromptsManager
          value={defaultConfig}
          onChange={onChange}
          promptOverrides={{
            "executor-welcome": "Custom text",
          }}
          onPromptOverridesChange={onPromptOverridesChange}
        />,
      );

      // Click Overrides tab
      fireEvent.click(screen.getByTestId("tab-overrides"));

      // Expand and reset
      await user.click(screen.getByTestId("expand-executor-welcome"));
      await waitFor(() => {
        expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
      });

      await user.click(screen.getByTestId("reset-executor-welcome"));

      // Verify onPromptOverridesChange was called with null
      expect(onPromptOverridesChange).toHaveBeenCalledTimes(1);
      const newOverrides = onPromptOverridesChange.mock.calls[0][0];
      expect(newOverrides["executor-welcome"]).toBeNull();
    });
  });

  describe("Fullscreen Expansion", () => {
    describe("Overrides tab fullscreen", () => {
      it("shows fullscreen button when override is expanded", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Click Overrides tab
        fireEvent.click(screen.getByTestId("tab-overrides"));

        // Expand the override
        await user.click(screen.getByTestId("expand-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
        });

        // Fullscreen button should be visible
        expect(screen.getByTestId("fullscreen-executor-welcome")).toBeTruthy();
      });

      it("clicking fullscreen button opens fullscreen view", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Click Overrides tab
        fireEvent.click(screen.getByTestId("tab-overrides"));

        // Expand and click fullscreen
        await user.click(screen.getByTestId("expand-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
        });

        await user.click(screen.getByTestId("fullscreen-executor-welcome"));

        // Fullscreen container should be visible
        await waitFor(() => {
          expect(screen.getByTestId("override-input-fullscreen-executor-welcome")).toBeTruthy();
          expect(screen.getByTestId("collapse-fullscreen-executor-welcome")).toBeTruthy();
        });
      });

      it("fullscreen textarea contains current override value", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{
              "executor-welcome": "My custom welcome message",
            }}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Click Overrides tab
        fireEvent.click(screen.getByTestId("tab-overrides"));

        // Expand and go fullscreen
        await user.click(screen.getByTestId("expand-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
        });

        await user.click(screen.getByTestId("fullscreen-executor-welcome"));

        // Verify fullscreen textarea has the value
        await waitFor(() => {
          const textarea = screen.getByTestId("override-input-fullscreen-executor-welcome") as HTMLTextAreaElement;
          expect(textarea.value).toBe("My custom welcome message");
        });
      });

      it("clicking collapse button exits fullscreen", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Click Overrides tab
        fireEvent.click(screen.getByTestId("tab-overrides"));

        // Expand, go fullscreen, and collapse
        await user.click(screen.getByTestId("expand-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
        });

        await user.click(screen.getByTestId("fullscreen-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-fullscreen-executor-welcome")).toBeTruthy();
        });

        await user.click(screen.getByTestId("collapse-fullscreen-executor-welcome"));

        // Fullscreen should be gone, but accordion should still be expanded
        await waitFor(() => {
          expect(screen.queryByTestId("override-input-fullscreen-executor-welcome")).toBeNull();
          expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
        });
      });

      it("Escape key exits fullscreen", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Click Overrides tab
        fireEvent.click(screen.getByTestId("tab-overrides"));

        // Expand, go fullscreen
        await user.click(screen.getByTestId("expand-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
        });

        await user.click(screen.getByTestId("fullscreen-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-fullscreen-executor-welcome")).toBeTruthy();
        });

        // Press Escape
        const textarea = screen.getByTestId("override-input-fullscreen-executor-welcome") as HTMLTextAreaElement;
        fireEvent.keyDown(textarea, { key: "Escape" });

        // Fullscreen should be gone
        await waitFor(() => {
          expect(screen.queryByTestId("override-input-fullscreen-executor-welcome")).toBeNull();
        });
      });

      it("editing in fullscreen fires onPromptOverridesChange", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Click Overrides tab
        fireEvent.click(screen.getByTestId("tab-overrides"));

        // Expand, go fullscreen, and type
        await user.click(screen.getByTestId("expand-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
        });

        await user.click(screen.getByTestId("fullscreen-executor-welcome"));
        await waitFor(() => {
          expect(screen.getByTestId("override-input-fullscreen-executor-welcome")).toBeTruthy();
        });

        const textarea = screen.getByTestId("override-input-fullscreen-executor-welcome") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "Fullscreen edit" } });

        // Verify onPromptOverridesChange was called with updated value
        await waitFor(() => {
          expect(onPromptOverridesChange).toHaveBeenCalled();
          const lastCall = onPromptOverridesChange.mock.calls[onPromptOverridesChange.mock.calls.length - 1];
          const newOverrides = lastCall[0];
          expect(newOverrides["executor-welcome"]).toBe("Fullscreen edit");
        });
      });
    });

    describe("Templates tab fullscreen", () => {
      it("each built-in template card has an expand button", () => {
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        for (const template of BUILTIN_AGENT_PROMPTS) {
          expect(screen.getByTestId(`expand-view-${template.id}`)).toBeTruthy();
        }
      });

      it("clicking expand button opens fullscreen view", async () => {
        const user = userEvent.setup();
        const defaultExecutorTemplate = BUILTIN_AGENT_PROMPTS.find(
          (template) => template.id === "default-executor",
        );

        if (!defaultExecutorTemplate) {
          throw new Error("default-executor template is required for this test");
        }

        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        await user.click(screen.getByTestId("expand-view-default-executor"));

        await waitFor(() => {
          expect(screen.getByTestId("collapse-view-default-executor")).toBeTruthy();
          expect(screen.getByRole("dialog").textContent).toContain(defaultExecutorTemplate.prompt);
        });
      });

      it("clicking collapse button exits fullscreen", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        await user.click(screen.getByTestId("expand-view-default-executor"));
        await waitFor(() => {
          expect(screen.getByTestId("collapse-view-default-executor")).toBeTruthy();
        });

        await user.click(screen.getByTestId("collapse-view-default-executor"));

        await waitFor(() => {
          expect(screen.queryByTestId("collapse-view-default-executor")).toBeNull();
        });
      });

      it("Escape key exits fullscreen", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        await user.click(screen.getByTestId("expand-view-default-executor"));
        await waitFor(() => {
          expect(screen.getByTestId("collapse-view-default-executor")).toBeTruthy();
        });

        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

        await waitFor(() => {
          expect(screen.queryByTestId("collapse-view-default-executor")).toBeNull();
        });
      });

      it("custom template card has expand button", () => {
        const config: AgentPromptsConfig = {
          templates: [
            {
              id: "my-custom-template",
              name: "My Custom Template",
              description: "Custom template for testing",
              role: "executor",
              prompt: "Custom prompt content",
              builtIn: false,
            },
          ],
        };

        render(
          <AgentPromptsManager
            value={config}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        expect(screen.getByTestId("expand-view-my-custom-template")).toBeTruthy();
      });

      it("only one template fullscreen at a time", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        await user.click(screen.getByTestId("expand-view-default-executor"));
        await waitFor(() => {
          expect(screen.getByTestId("collapse-view-default-executor")).toBeTruthy();
        });

        await user.click(screen.getByTestId("expand-view-default-triage"));

        await waitFor(() => {
          expect(screen.queryByTestId("collapse-view-default-executor")).toBeNull();
          expect(screen.getByTestId("collapse-view-default-triage")).toBeTruthy();
        });
      });

      it("fullscreen view remains singular when custom template overrides a built-in ID", async () => {
        const user = userEvent.setup();
        const config: AgentPromptsConfig = {
          templates: [
            {
              id: "default-executor",
              name: "Custom Override Executor",
              description: "Overrides built-in template",
              role: "executor",
              prompt: "Custom override prompt body for executor role.",
              builtIn: false,
            },
          ],
        };

        render(
          <AgentPromptsManager
            value={config}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        const expandButtons = screen.getAllByTestId("expand-view-default-executor");
        expect(expandButtons.length).toBe(2);

        await user.click(expandButtons[0]);
        await waitFor(() => {
          expect(screen.getAllByRole("dialog").length).toBe(1);
          expect(screen.getByRole("dialog").textContent).toContain("Default Executor");
        });

        await user.click(expandButtons[1]);
        await waitFor(() => {
          expect(screen.getAllByRole("dialog").length).toBe(1);
          expect(screen.getByRole("dialog").textContent).toContain("Custom Override Executor");
        });
      });

      it("opening template card fullscreen closes template editor fullscreen", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        await user.click(screen.getByTestId("add-template-btn"));
        await user.click(screen.getByTestId("template-prompt-fullscreen"));
        await waitFor(() => {
          expect(screen.getByTestId("template-prompt-input-fullscreen")).toBeTruthy();
        });

        await user.click(screen.getByTestId("expand-view-default-executor"));

        await waitFor(() => {
          expect(screen.queryByTestId("template-prompt-input-fullscreen")).toBeNull();
          expect(screen.getByTestId("collapse-view-default-executor")).toBeTruthy();
        });
      });

      it("shows fullscreen button in template editor", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Open template editor
        await user.click(screen.getByTestId("add-template-btn"));

        // Fullscreen button should be visible
        expect(screen.getByTestId("template-prompt-fullscreen")).toBeTruthy();
      });

      it("clicking fullscreen button opens fullscreen view for template prompt", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Open template editor
        await user.click(screen.getByTestId("add-template-btn"));

        // Click fullscreen button
        await user.click(screen.getByTestId("template-prompt-fullscreen"));

        // Fullscreen container should be visible
        await waitFor(() => {
          expect(screen.getByTestId("template-prompt-input-fullscreen")).toBeTruthy();
          expect(screen.getByTestId("template-prompt-collapse")).toBeTruthy();
        });
      });

      it("Escape key exits template prompt fullscreen", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Open template editor and go fullscreen
        await user.click(screen.getByTestId("add-template-btn"));
        await user.click(screen.getByTestId("template-prompt-fullscreen"));
        await waitFor(() => {
          expect(screen.getByTestId("template-prompt-input-fullscreen")).toBeTruthy();
        });

        // Press Escape
        const textarea = screen.getByTestId("template-prompt-input-fullscreen") as HTMLTextAreaElement;
        fireEvent.keyDown(textarea, { key: "Escape" });

        // Fullscreen should be gone
        await waitFor(() => {
          expect(screen.queryByTestId("template-prompt-input-fullscreen")).toBeNull();
        });
      });

      it("saving template resets fullscreen state", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Open template editor and go fullscreen
        await user.click(screen.getByTestId("add-template-btn"));
        await user.click(screen.getByTestId("template-prompt-fullscreen"));
        await waitFor(() => {
          expect(screen.getByTestId("template-prompt-input-fullscreen")).toBeTruthy();
        });

        // Fill in name and save
        await user.type(screen.getByTestId("template-name-input"), "My Template");
        await user.click(screen.getByTestId("save-template-btn"));

        // Verify fullscreen is gone after save
        await waitFor(() => {
          expect(screen.queryByTestId("template-prompt-input-fullscreen")).toBeNull();
          expect(screen.queryByTestId("template-editor")).toBeNull();
        });
      });

      it("canceling template edit resets fullscreen state", async () => {
        const user = userEvent.setup();
        render(
          <AgentPromptsManager
            value={defaultConfig}
            onChange={onChange}
            promptOverrides={{}}
            onPromptOverridesChange={onPromptOverridesChange}
          />,
        );

        // Open template editor and go fullscreen
        await user.click(screen.getByTestId("add-template-btn"));
        await user.click(screen.getByTestId("template-prompt-fullscreen"));
        await waitFor(() => {
          expect(screen.getByTestId("template-prompt-input-fullscreen")).toBeTruthy();
        });

        // Cancel
        await user.click(screen.getByTestId("cancel-template-btn"));

        // Verify fullscreen is gone after cancel
        await waitFor(() => {
          expect(screen.queryByTestId("template-prompt-input-fullscreen")).toBeNull();
          expect(screen.queryByTestId("template-editor")).toBeNull();
        });
      });
    });
  });
});
