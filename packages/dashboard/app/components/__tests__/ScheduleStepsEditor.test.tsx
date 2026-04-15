import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ScheduleStepsEditor } from "../ScheduleStepsEditor";
import type { AutomationStep } from "@fusion/core";

// Mock @fusion/core
vi.mock("@fusion/core", () => ({}));

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus">+</span>,
  Trash2: () => <span data-testid="icon-trash">🗑</span>,
  ChevronUp: () => <span data-testid="icon-up">▲</span>,
  ChevronDown: () => <span data-testid="icon-down">▼</span>,
  Pencil: () => <span data-testid="icon-pencil">✎</span>,
  GripVertical: () => <span data-testid="icon-grip">≡</span>,
  Terminal: () => <span data-testid="icon-terminal">$</span>,
  Sparkles: () => <span data-testid="icon-sparkles">✨</span>,
}));

// Mock api - provide models synchronously for immediate availability
const mockModels = [
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet", reasoning: false, contextWindow: 200000 },
];

vi.mock("../api", () => ({
  fetchModels: vi.fn(() => Promise.resolve({
    models: mockModels,
    favoriteProviders: [],
    favoriteModels: [],
  })),
}));

// Mock CustomModelDropdown
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: (props: any) => {
    // Store the last value for debugging
    (window as any).__lastModelDropdownProps = props;
    return (
      <select
        data-testid="model-dropdown"
        value={props.value ?? ""}
        onChange={(e) => props.onChange?.(e.target.value)}
        disabled={props.disabled}
        data-value={props.value}
      >
        <option value="">Use default</option>
        {props.models?.map((m: any) => (
          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
            {m.name}
          </option>
        ))}
      </select>
    );
  },
}));

// Mock crypto.randomUUID for deterministic tests
let uuidCounter = 0;
vi.stubGlobal("crypto", {
  randomUUID: () => `test-uuid-${++uuidCounter}`,
});

function makeStep(overrides: Partial<AutomationStep> = {}): AutomationStep {
  return {
    id: `step-${++uuidCounter}`,
    type: "command",
    name: "Test Step",
    command: "echo hello",
    ...overrides,
  };
}

describe("ScheduleStepsEditor", () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
  });

  describe("step addition", () => {
    it("renders add buttons for command and AI prompt", () => {
      render(<ScheduleStepsEditor steps={[]} onChange={onChange} />);
      expect(screen.getByText("Add Command Step")).toBeDefined();
      expect(screen.getByText("Add AI Prompt Step")).toBeDefined();
    });

    it("adds a command step when clicking Add Command Step", () => {
      render(<ScheduleStepsEditor steps={[]} onChange={onChange} />);
      fireEvent.click(screen.getByText("Add Command Step"));
      expect(onChange).toHaveBeenCalledTimes(1);
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps).toHaveLength(1);
      expect(newSteps[0].type).toBe("command");
      expect(newSteps[0].name).toBe("New Command Step");
    });

    it("adds an AI prompt step when clicking Add AI Prompt Step", () => {
      render(<ScheduleStepsEditor steps={[]} onChange={onChange} />);
      fireEvent.click(screen.getByText("Add AI Prompt Step"));
      expect(onChange).toHaveBeenCalledTimes(1);
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps).toHaveLength(1);
      expect(newSteps[0].type).toBe("ai-prompt");
      expect(newSteps[0].name).toBe("New AI Prompt Step");
    });

    it("appends to existing steps", () => {
      const existing = [makeStep({ name: "Existing" })];
      render(<ScheduleStepsEditor steps={existing} onChange={onChange} />);
      fireEvent.click(screen.getByText("Add Command Step"));
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps).toHaveLength(2);
      expect(newSteps[0].name).toBe("Existing");
    });
  });

  describe("step deletion", () => {
    it("removes a step when delete button is clicked", () => {
      const steps = [
        makeStep({ id: "s1", name: "First" }),
        makeStep({ id: "s2", name: "Second" }),
      ];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      const deleteButtons = screen.getAllByTitle("Delete");
      fireEvent.click(deleteButtons[0]);
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps).toHaveLength(1);
      expect(newSteps[0].name).toBe("Second");
    });
  });

  describe("step reordering", () => {
    it("moves a step up", () => {
      const steps = [
        makeStep({ id: "s1", name: "First" }),
        makeStep({ id: "s2", name: "Second" }),
      ];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      // Click "Move up" on the second step
      const moveUpButtons = screen.getAllByTitle("Move up");
      fireEvent.click(moveUpButtons[1]); // second step's move up button
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps[0].name).toBe("Second");
      expect(newSteps[1].name).toBe("First");
    });

    it("moves a step down", () => {
      const steps = [
        makeStep({ id: "s1", name: "First" }),
        makeStep({ id: "s2", name: "Second" }),
      ];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      // Click "Move down" on the first step
      const moveDownButtons = screen.getAllByTitle("Move down");
      fireEvent.click(moveDownButtons[0]); // first step's move down button
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps[0].name).toBe("Second");
      expect(newSteps[1].name).toBe("First");
    });

    it("disables Move Up on the first step", () => {
      const steps = [makeStep({ id: "s1", name: "Only" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      const moveUpBtn = screen.getByLabelText("Move Only up");
      expect(moveUpBtn.hasAttribute("disabled")).toBe(true);
    });

    it("disables Move Down on the last step", () => {
      const steps = [makeStep({ id: "s1", name: "Only" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      const moveDownBtn = screen.getByLabelText("Move Only down");
      expect(moveDownBtn.hasAttribute("disabled")).toBe(true);
    });
  });

  describe("step editor state", () => {
    function StatefulEditor(props: Omit<ScheduleStepsEditorProps, 'onChange'>) {
      const [steps, setSteps] = useState<AutomationStep[]>(props.steps);
      return <ScheduleStepsEditor steps={steps} onChange={setSteps} />;
    }

    it("opens step editor automatically when adding a new step", () => {
      render(<StatefulEditor steps={[]} />);
      fireEvent.click(screen.getByText("Add Command Step"));
      // After adding, the editor should be open (showing Save Step button)
      expect(screen.getByText("Save Step")).toBeDefined();
    });

    it("notifies parent when editing state changes", () => {
      const onEditingChange = vi.fn();
      function StatefulEditorWithCallback(props: Omit<ScheduleStepsEditorProps, 'onChange'>) {
        const [steps, setSteps] = useState<AutomationStep[]>(props.steps);
        return <ScheduleStepsEditor steps={steps} onChange={setSteps} onEditingChange={onEditingChange} />;
      }
      render(<StatefulEditorWithCallback steps={[]} />);
      
      // Should be called with true when opening editor
      fireEvent.click(screen.getByText("Add Command Step"));
      expect(onEditingChange).toHaveBeenLastCalledWith(true);
      
      // Should be called with false when canceling
      fireEvent.click(screen.getByText("Cancel"));
      expect(onEditingChange).toHaveBeenLastCalledWith(false);
    });

    it("opens step editor for existing steps when edit is clicked", () => {
      const steps = [makeStep({ id: "s1", name: "Build" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText("Edit Build"));
      expect(screen.getByText("Save Step")).toBeDefined();
      expect(screen.getByLabelText("Step Name")).toHaveProperty("value", "Build");
    });

    it("closes editor on cancel", () => {
      const steps = [makeStep({ id: "s1", name: "Build" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText("Edit Build"));
      expect(screen.getByText("Save Step")).toBeDefined();
      fireEvent.click(screen.getByText("Cancel"));
      // Editor should be closed; step card should be visible again
      expect(screen.queryByText("Save Step")).toBeNull();
      expect(screen.getByText("Build")).toBeDefined();
    });
  });

  describe("form validation", () => {
    it("shows error when step name is empty", () => {
      const steps = [makeStep({ id: "s1", name: "Build" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText("Edit Build"));
      // Clear the name
      fireEvent.change(screen.getByLabelText("Step Name"), { target: { value: "" } });
      fireEvent.click(screen.getByText("Save Step"));
      expect(screen.getByText("Step name is required")).toBeDefined();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("shows error when command step has no command", () => {
      const steps = [makeStep({ id: "s1", name: "Build", command: "echo test" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText("Edit Build"));
      // Clear the command
      fireEvent.change(screen.getByDisplayValue("echo test"), { target: { value: "" } });
      fireEvent.click(screen.getByText("Save Step"));
      expect(screen.getByText("Command is required")).toBeDefined();
    });
  });

  describe("empty state", () => {
    it("shows empty state message when no steps", () => {
      render(<ScheduleStepsEditor steps={[]} onChange={onChange} />);
      expect(screen.getByText(/No steps added yet/)).toBeDefined();
    });

    it("does not show empty state when steps exist", () => {
      const steps = [makeStep()];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      expect(screen.queryByText(/No steps added yet/)).toBeNull();
    });
  });

  describe("step display", () => {
    it("shows step index numbers", () => {
      const steps = [
        makeStep({ id: "s1", name: "First" }),
        makeStep({ id: "s2", name: "Second" }),
      ];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      expect(screen.getByText("1")).toBeDefined();
      expect(screen.getByText("2")).toBeDefined();
    });

    it("shows step names", () => {
      const steps = [makeStep({ id: "s1", name: "Build project" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      expect(screen.getByText("Build project")).toBeDefined();
    });

    it("shows continueOnFailure flag", () => {
      const steps = [makeStep({ id: "s1", name: "Build", continueOnFailure: true })];
      const { container } = render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      const flag = container.querySelector(".step-card-flag");
      expect(flag).not.toBeNull();
      expect(flag?.textContent).toBe("⚡");
    });

    it("shows step count in header", () => {
      const steps = [makeStep(), makeStep({ id: "s2" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      expect(screen.getByText("Steps (2)")).toBeDefined();
    });
  });

  describe("model selection", () => {
    it("shows model dropdown for AI prompt step type", async () => {
      const steps = [makeStep({ id: "s1", name: "AI Step", type: "ai-prompt", prompt: "Test prompt" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      
      // Click edit to open the step editor
      fireEvent.click(screen.getByLabelText("Edit AI Step"));
      
      // Wait for models to load and dropdown to appear
      await waitFor(() => expect(screen.getByTestId("model-dropdown")).toBeDefined());
      
      expect(screen.getByTestId("model-dropdown")).toBeDefined();
    });

    it("does not show model dropdown for command step type", () => {
      const steps = [makeStep({ id: "s1", name: "Command Step" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText("Edit Command Step"));
      expect(screen.queryByTestId("model-dropdown")).toBeNull();
    });

    it("pre-populates model dropdown when editing step with existing model", async () => {
      const steps = [makeStep({ 
        id: "s1", 
        type: "ai-prompt", 
        name: "Analyze", 
        prompt: "Analyze this",
        modelProvider: "openai", 
        modelId: "gpt-4o" 
      })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      
      fireEvent.click(screen.getByLabelText("Edit Analyze"));
      
      // Wait for models to load and dropdown to appear
      await waitFor(() => expect(screen.getByTestId("model-dropdown")).toBeDefined());
      
      const dropdown = screen.getByTestId("model-dropdown") as HTMLSelectElement;
      // Use data-value attribute to verify the passed value since React controlled select
      // DOM property may not sync immediately with the prop value
      expect(dropdown.getAttribute("data-value")).toBe("openai/gpt-4o");
    });

    it("model dropdown receives onChange callback", async () => {
      const steps = [makeStep({ id: "s1", type: "ai-prompt", name: "AI Step", prompt: "Test prompt" })];
      render(<ScheduleStepsEditor steps={steps} onChange={onChange} />);
      
      fireEvent.click(screen.getByLabelText("Edit AI Step"));
      
      // Wait for dropdown to appear
      await waitFor(() => expect(screen.getByTestId("model-dropdown")).toBeDefined());
      
      // Get the mock component props to verify onChange is passed correctly
      const lastProps = (window as any).__lastModelDropdownProps;
      expect(lastProps).toBeDefined();
      expect(typeof lastProps.onChange).toBe("function");
      
      // The onChange should be a function that accepts a value string
      // We can't fully test the React state update in this mock setup,
      // but we can verify the callback is properly wired
    });
  });

  describe("ID generation fallback", () => {
    it("adds steps when crypto.randomUUID is unavailable", () => {
      // Remove crypto.randomUUID to simulate non-secure context
      vi.stubGlobal("crypto", {});
      render(<ScheduleStepsEditor steps={[]} onChange={onChange} />);
      fireEvent.click(screen.getByText("Add Command Step"));
      expect(onChange).toHaveBeenCalledTimes(1);
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps).toHaveLength(1);
      expect(newSteps[0].type).toBe("command");
      expect(newSteps[0].id).toBeTruthy();
    });

    it("adds AI prompt steps when crypto.randomUUID is unavailable", () => {
      vi.stubGlobal("crypto", {});
      render(<ScheduleStepsEditor steps={[]} onChange={onChange} />);
      fireEvent.click(screen.getByText("Add AI Prompt Step"));
      expect(onChange).toHaveBeenCalledTimes(1);
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps).toHaveLength(1);
      expect(newSteps[0].type).toBe("ai-prompt");
      expect(newSteps[0].id).toBeTruthy();
    });

    it("adds steps when crypto is entirely undefined", () => {
      vi.stubGlobal("crypto", undefined);
      render(<ScheduleStepsEditor steps={[]} onChange={onChange} />);
      fireEvent.click(screen.getByText("Add Command Step"));
      expect(onChange).toHaveBeenCalledTimes(1);
      const newSteps = onChange.mock.calls[0][0] as AutomationStep[];
      expect(newSteps).toHaveLength(1);
      expect(newSteps[0].id).toMatch(/^step-/);
    });

    it("enters edit mode for new step using fallback IDs", () => {
      vi.stubGlobal("crypto", {});
      function StatefulEditor() {
        const [steps, setSteps] = useState<AutomationStep[]>([]);
        return <ScheduleStepsEditor steps={steps} onChange={setSteps} />;
      }
      render(<StatefulEditor />);
      fireEvent.click(screen.getByText("Add Command Step"));
      // Editor should open immediately for the new step
      expect(screen.getByText("Save Step")).toBeDefined();
    });
  });
});
