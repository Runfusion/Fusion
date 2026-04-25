import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingResumeCard } from "../OnboardingResumeCard";

// Mock the model-onboarding-state module
vi.mock("../model-onboarding-state", () => ({
  getOnboardingResumeStep: vi.fn(),
  ONBOARDING_FLOW_STEPS: ["ai-setup", "github", "project-setup", "first-task"],
}));

const mockTrackOnboardingEvent = vi.fn();

vi.mock("../onboarding-events", () => ({
  trackOnboardingEvent: (...args: unknown[]) => mockTrackOnboardingEvent(...args),
  getOnboardingSessionId: () => "test-session-id",
}));

import { getOnboardingResumeStep } from "../model-onboarding-state";

describe("OnboardingResumeCard", () => {
  const mockGetOnboardingResumeStep = getOnboardingResumeStep as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetOnboardingResumeStep.mockReset();
    mockTrackOnboardingEvent.mockReset();
    mockGetOnboardingResumeStep.mockReturnValue(null);
  });

  afterEach(() => {
    mockGetOnboardingResumeStep.mockReset();
    mockTrackOnboardingEvent.mockReset();
  });

  describe("rendering", () => {
    it("renders nothing when no resumable state exists", () => {
      mockGetOnboardingResumeStep.mockReturnValue(null);
      const { container } = render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(container.firstChild).toBeNull();
    });

    it("renders the resume card when resumable state exists", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
        completedSteps: [],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByRole("region", { name: "Resume onboarding" })).toBeInTheDocument();
    });

    it("displays the step label", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "github",
        label: "GitHub",
        completedSteps: ["ai-setup"],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    it("displays the title", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "first-task",
        label: "First Task",
        completedSteps: ["ai-setup", "github"],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText("Continue Setup")).toBeInTheDocument();
    });

    it("displays the continue button", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
        completedSteps: [],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText("Continue onboarding")).toBeInTheDocument();
    });

    it("has accessible button with proper role and shared CTA classes", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
        completedSteps: [],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      const button = screen.getByRole("button", { name: "Continue onboarding" });
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass("btn", "btn-primary", "btn-sm", "onboarding-resume-card__resume-btn");
    });
  });

  describe("interaction", () => {
    it("calls onResume when button is clicked", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
        completedSteps: [],
      });
      const onResume = vi.fn();
      render(<OnboardingResumeCard onResume={onResume} />);

      const button = screen.getByRole("button", { name: "Continue onboarding" });
      fireEvent.click(button);

      expect(mockTrackOnboardingEvent).toHaveBeenCalledWith(
        "onboarding:resumed",
        expect.objectContaining({
          source: "resume-card",
          resumedFromStep: "ai-setup",
        }),
      );
      expect(onResume).toHaveBeenCalledTimes(1);
    });

    it("button is keyboard accessible", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
        completedSteps: [],
      });
      const onResume = vi.fn();
      render(<OnboardingResumeCard onResume={onResume} />);

      const button = screen.getByRole("button", { name: "Continue onboarding" });
      // Click simulates both mouse and keyboard activation
      fireEvent.click(button);

      expect(onResume).toHaveBeenCalledTimes(1);
    });
  });

  describe("step context", () => {
    it("shows correct message for ai-setup step", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
        completedSteps: [],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText(/AI Setup/)).toBeInTheDocument();
    });

    it("shows correct message for github step", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "github",
        label: "GitHub",
        completedSteps: ["ai-setup"],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText(/GitHub/)).toBeInTheDocument();
    });

    it("shows correct message for first-task step", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "first-task",
        label: "First Task",
        completedSteps: ["ai-setup", "github"],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText(/First Task/)).toBeInTheDocument();
    });
  });

  describe("completed step count", () => {
    it("shows progress text without count when 0 steps completed", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
        completedSteps: [],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      // When 0 steps completed, text is just "You're on the <label> step"
      expect(screen.getByText(/^You're on the/)).toBeInTheDocument();
      expect(screen.getByText(/AI Setup/)).toBeInTheDocument();
    });

    it("shows completed step count text with 1 completed step (singular)", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "github",
        label: "GitHub",
        completedSteps: ["ai-setup"],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      // Uses singular "step" for 1 completed
      expect(screen.getByText(/1 of 4 step complete/)).toBeInTheDocument();
    });

    it("shows completed step count text with 2 completed steps (plural)", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "first-task",
        label: "First Task",
        completedSteps: ["ai-setup", "github"],
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      // Uses plural "steps" for 2 completed
      expect(screen.getByText(/2 of 4 steps complete/)).toBeInTheDocument();
    });
  });

  describe("hidden state", () => {
    it("does not render when currentStep is null", () => {
      mockGetOnboardingResumeStep.mockReturnValue(null);
      const { container } = render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(container.firstChild).toBeNull();
    });
  });
});
