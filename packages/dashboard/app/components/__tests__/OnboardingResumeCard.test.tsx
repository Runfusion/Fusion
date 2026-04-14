import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingResumeCard } from "../OnboardingResumeCard";

// Mock the model-onboarding-state module
vi.mock("../model-onboarding-state", () => ({
  getOnboardingResumeStep: vi.fn(),
}));

import { getOnboardingResumeStep } from "../model-onboarding-state";

describe("OnboardingResumeCard", () => {
  const mockGetOnboardingResumeStep = getOnboardingResumeStep as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetOnboardingResumeStep.mockReset();
    mockGetOnboardingResumeStep.mockReturnValue(null);
  });

  afterEach(() => {
    mockGetOnboardingResumeStep.mockReset();
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
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByRole("region", { name: "Resume onboarding" })).toBeInTheDocument();
    });

    it("displays the step label", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "github",
        label: "GitHub",
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    it("displays the title", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "first-task",
        label: "First Task",
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText("Continue Setup")).toBeInTheDocument();
    });

    it("displays the continue button", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText("Continue onboarding")).toBeInTheDocument();
    });

    it("has accessible button with proper role", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      const button = screen.getByRole("button", { name: "Continue onboarding" });
      expect(button).toBeInTheDocument();
    });
  });

  describe("interaction", () => {
    it("calls onResume when button is clicked", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
      });
      const onResume = vi.fn();
      render(<OnboardingResumeCard onResume={onResume} />);

      const button = screen.getByRole("button", { name: "Continue onboarding" });
      fireEvent.click(button);

      expect(onResume).toHaveBeenCalledTimes(1);
    });

    it("button is keyboard accessible", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "ai-setup",
        label: "AI Setup",
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
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText(/AI Setup/)).toBeInTheDocument();
    });

    it("shows correct message for github step", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "github",
        label: "GitHub",
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText(/GitHub/)).toBeInTheDocument();
    });

    it("shows correct message for first-task step", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "first-task",
        label: "First Task",
      });
      render(<OnboardingResumeCard onResume={vi.fn()} />);
      expect(screen.getByText(/First Task/)).toBeInTheDocument();
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
