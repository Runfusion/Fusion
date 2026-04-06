import { describe, it, expect } from "vitest";

// Import STATUS_CONFIG objects by reading source module internals.
// Each component exports the config as a module-level constant.
// We re-import the raw source to inspect the token strings.

// ProjectHealthBadge STATUS_CONFIG
import type { ProjectStatus } from "@fusion/core";

// We need to read the actual source to access STATUS_CONFIG.
// Since STATUS_CONFIG is module-scoped (not exported), we read the source
// at build time and assert on the token patterns via rendered output.

// Instead, we test the rendered output of each component for correct CSS tokens.
import { render } from "@testing-library/react";
import { ProjectHealthBadge } from "../ProjectHealthBadge";
import { ProjectCard } from "../ProjectCard";
import { ProjectSelector } from "../ProjectSelector";
import type { RegisteredProject, ProjectHealth } from "@fusion/core";
import type { ProjectInfo } from "../../../app/api";

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Play: () => <span>Play</span>,
  Pause: () => <span>Pause</span>,
  AlertCircle: () => <span>AlertCircle</span>,
  Loader2: () => <span>Loader2</span>,
  ChevronDown: () => <span>ChevronDown</span>,
  Check: () => <span>Check</span>,
  Folder: () => <span>Folder</span>,
  Grid3X3: () => <span>Grid3X3</span>,
  Search: () => <span>Search</span>,
  Clock: () => <span>Clock</span>,
  X: () => <span>X</span>,
  MoreHorizontal: () => null,
  Trash2: () => <span>Trash2</span>,
  ArrowRight: () => <span>ArrowRight</span>,
}));

describe("Project component CSS theme tokens", () => {
  it("ProjectHealthBadge uses var(--color-error) for errored status, not var(--error)", () => {
    const { container } = render(<ProjectHealthBadge status="errored" />);

    const badge = container.querySelector("[data-status='errored']") as HTMLElement;
    expect(badge).toBeTruthy();

    const style = badge.style;
    // The color property should use the correct token
    expect(style.color).toBe("var(--color-error)");
    // Must NOT use the undefined bare token
    expect(style.color).not.toBe("var(--error)");
    expect(style.borderColor).toBe("var(--color-error)");
    expect(style.borderColor).not.toBe("var(--error)");
  });

  it("ProjectCard uses var(--color-error) for errored status, not var(--error)", () => {
    const project: RegisteredProject = {
      id: "proj_test",
      name: "Test Project",
      path: "/test/path",
      status: "errored",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const { container } = render(
      <ProjectCard
        project={project}
        health={null}
        onSelect={() => {}}
        onPause={() => {}}
        onResume={() => {}}
        onRemove={() => {}}
      />
    );

    const statusBadge = container.querySelector(".project-card-status-badge") as HTMLElement;
    expect(statusBadge).toBeTruthy();

    const style = statusBadge.style;
    expect(style.color).toBe("var(--color-error)");
    expect(style.color).not.toBe("var(--error)");
    expect(style.borderColor).toBe("var(--color-error)");
    expect(style.borderColor).not.toBe("var(--error)");
  });

  it("ProjectSelector uses var(--color-error) for errored status, not var(--error)", () => {
    const erroredProject: ProjectInfo = {
      id: "proj_errored",
      name: "Errored Project",
      path: "/test/errored",
      status: "errored",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: new Date().toISOString(),
    };

    const { container } = render(
      <ProjectSelector
        projects={[
          erroredProject,
          { ...erroredProject, id: "proj_other", status: "active", name: "Other" },
        ]}
        currentProject={erroredProject}
        onSelect={() => {}}
        onViewAll={() => {}}
      />
    );

    // ProjectSelector returns null when only 1 project, so we provide 2
    // The trigger shows current project — we check that no var(--error) exists in rendered output
    const html = container.innerHTML;
    expect(html).not.toContain("var(--error)");
  });

  it("no STATUS_CONFIG in any project component uses bare var(--error)", async () => {
    // This is a source-code-level regression check.
    // Read the source files and verify no bare var(--error) remains.
    const fs = await import("fs");
    const path = await import("path");

    const componentDir = path.resolve(__dirname, "..");
    const files = [
      "ProjectHealthBadge.tsx",
      "ProjectSelector.tsx",
      "ProjectCard.tsx",
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(componentDir, file), "utf-8");

      // Should NOT contain the bare var(--error) token
      expect(
        source,
        `${file} should not contain var(--error)`
      ).not.toMatch(/var\(--error\)(?!\w)/);

      // Should contain the correct token for errored status
      expect(
        source,
        `${file} should contain var(--color-error) for errored status`
      ).toContain('var(--color-error)');
    }
  });
});
